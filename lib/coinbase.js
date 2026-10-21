'use strict';
// Miner-tag embedding: append a printable-ASCII pushdata to the daemon-built
// coinbase's input script (the on-chain signature explorers identify pools
// by — e.g. zpool mines this chain with "/zpool.ca/" there).
//
// The coinbase scriptSig is never executed; the kerrigan daemon itself emits
// a 1-byte scriptSig (height lives in the CbTx payload, not the script), so
// an appended tag only has to respect the ~100-byte script-size envelope.
// FAIL-SAFE: any parse anomaly returns the original coinbase untouched —
// a missing tag is cosmetic, a malformed block is not.
//
// splitForExtranonce does the same splice for the classic (X11) stratum: it
// adds a placeholder pushdata for the miners' extranonces and cuts the
// coinbase around it. There the extranonce is not optional, so it throws
// where appendTag would quietly do nothing.

const util = require('./util');

const MAX_SCRIPTSIG = 100;
const MAX_TAG = 40;

function sanitizeTag(tag) {
  return String(tag === undefined || tag === null ? '' : tag)
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, MAX_TAG);
}

// Returns { hex, applied, tagUsed?, reason? }. hex is unchanged when !applied.
function appendTag(coinbaseHex, tag) {
  const clean = sanitizeTag(tag);
  if (!clean) return { hex: coinbaseHex, applied: false, reason: 'empty tag after sanitizing' };
  let result;
  try {
    result = splice(util.hexToBuf(coinbaseHex, 'coinbasetxn'), clean);
  } catch (err) {
    return { hex: coinbaseHex, applied: false, reason: 'coinbase parse failed: ' + err.message };
  }
  if (!result) return { hex: coinbaseHex, applied: false, reason: 'no room in scriptSig (100-byte cap)' };
  return { hex: result.buf.toString('hex'), applied: true, tagUsed: result.tagUsed };
}

// Where the coinbase's scriptSig is: lenOff is its length varint, and
// [start, end) the script itself. Throws on anything that is not a coinbase.
function locateScriptSig(buf) {
  let off = 0;
  const need = n => {
    if (off + n > buf.length) throw new Error('truncated tx at offset ' + off);
  };

  need(4);
  off += 4; // version | type
  const vin = util.readVarint(buf, off);
  if (vin.value !== 1) throw new Error('coinbase must have exactly 1 input, got ' + vin.value);
  off += vin.size;

  need(36);
  if (!buf.subarray(off, off + 32).equals(Buffer.alloc(32)) || buf.readUInt32LE(off + 32) !== 0xffffffff) {
    throw new Error('input is not a coinbase outpoint');
  }
  off += 36;

  const sl = util.readVarint(buf, off);
  const start = off + sl.size;
  const end = start + sl.value;
  if (end + 4 > buf.length) throw new Error('scriptSig overruns tx');
  return { lenOff: off, start, end };
}

// One single-byte-opcode pushdata: length byte + ASCII (<= 75 by definition).
// `room` is the most script bytes the push may take, its length byte included.
function tagPush(tag, room) {
  const fit = Math.min(room - 1, 75);
  if (fit < 4) return null; // a 1-3 char stump is not worth emitting
  const tagUsed = tag.slice(0, fit);
  return { push: Buffer.concat([Buffer.from([tagUsed.length]), Buffer.from(tagUsed, 'latin1')]), tagUsed };
}

// The coinbase with its scriptSig replaced, re-read as a check.
function rewrite(buf, loc, newScript) {
  const out = Buffer.concat([
    buf.subarray(0, loc.lenOff),
    util.varint(newScript.length),
    newScript,
    buf.subarray(loc.end), // sequence + outputs + locktime + payload, untouched
  ]);

  // Belt and braces: the rewritten script region must re-read exactly.
  const check = util.readVarint(out, loc.lenOff);
  if (check.value !== newScript.length ||
      !out.subarray(loc.lenOff + check.size, loc.lenOff + check.size + check.value).equals(newScript)) {
    throw new Error('splice self-check failed');
  }
  return out;
}

function splice(buf, tag) {
  const loc = locateScriptSig(buf);
  const script = buf.subarray(loc.start, loc.end);
  const t = tagPush(tag, MAX_SCRIPTSIG - script.length);
  if (!t) return null;
  return { buf: rewrite(buf, loc, Buffer.concat([script, t.push])), tagUsed: t.tagUsed };
}

// Classic stratum: the miner builds the coinbase as coinb1 || extraNonce1 ||
// extraNonce2 || coinb2. Appends the optional tag, then one pushdata of
// `size` placeholder bytes to the daemon's scriptSig, and cuts around those.
// The tag gives way when both do not fit; the extranonce cannot, so a
// scriptSig too long to take it throws.
// Returns { coinb1, coinb2 (Buffers), tagUsed, tagSkipped }.
function splitForExtranonce(coinbaseHex, size, tag) {
  if (!Number.isInteger(size) || size < 1 || size > 75) throw new Error('extranonce size must be 1..75 bytes');
  const buf = util.hexToBuf(coinbaseHex, 'coinbasetxn');
  const loc = locateScriptSig(buf);
  const script = buf.subarray(loc.start, loc.end);
  const enPush = 1 + size;
  if (script.length + enPush > MAX_SCRIPTSIG) {
    throw new Error(`no room for a ${size}-byte extranonce in a ${script.length}-byte scriptSig (100-byte cap)`);
  }

  let tagged = Buffer.alloc(0);
  let tagUsed = null;
  let tagSkipped = null;
  const clean = sanitizeTag(tag);
  if (clean) {
    const t = tagPush(clean, MAX_SCRIPTSIG - script.length - enPush);
    if (t) { tagged = t.push; tagUsed = t.tagUsed; } else tagSkipped = 'no room in scriptSig (100-byte cap)';
  } else if (tag !== undefined && tag !== null && tag !== '') {
    tagSkipped = 'empty tag after sanitizing';
  }

  const newScript = Buffer.concat([script, tagged, Buffer.from([size]), Buffer.alloc(size)]);
  const out = rewrite(buf, loc, newScript);
  const cut = out.length - (buf.length - loc.end) - size;   // where the placeholder starts
  const coinb1 = out.subarray(0, cut);
  const coinb2 = out.subarray(cut + size);
  // The cut must sit exactly on the placeholder, with the daemon's outputs
  // and payload after it unchanged.
  if (!out.subarray(cut, cut + size).equals(Buffer.alloc(size)) || out[cut - 1] !== size ||
      !coinb2.subarray(coinb2.length - (buf.length - loc.end)).equals(buf.subarray(loc.end))) {
    throw new Error('extranonce split self-check failed');
  }
  return { coinb1: Buffer.from(coinb1), coinb2: Buffer.from(coinb2), tagUsed, tagSkipped };
}

module.exports = { appendTag, splitForExtranonce, sanitizeTag, MAX_TAG };
