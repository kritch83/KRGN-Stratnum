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

function splice(buf, tag) {
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
  const scriptStart = off + sl.size;
  const scriptEnd = scriptStart + sl.value;
  if (scriptEnd + 4 > buf.length) throw new Error('scriptSig overruns tx');
  const script = buf.subarray(scriptStart, scriptEnd);

  // One single-byte-opcode pushdata: length byte + ASCII (<= 75 by definition).
  const room = Math.min(MAX_SCRIPTSIG - sl.value - 1, 75);
  if (room < 4) return null; // a 1-3 char stump is not worth emitting
  const tagUsed = tag.slice(0, room);
  const push = Buffer.concat([Buffer.from([tagUsed.length]), Buffer.from(tagUsed, 'latin1')]);
  const newScript = Buffer.concat([script, push]);

  const out = Buffer.concat([
    buf.subarray(0, off),
    util.varint(newScript.length),
    newScript,
    buf.subarray(scriptEnd), // sequence + outputs + locktime + payload, untouched
  ]);

  // Belt and braces: the rewritten script region must re-read exactly.
  const check = util.readVarint(out, off);
  if (check.value !== newScript.length ||
      !out.subarray(off + check.size, off + check.size + check.value).equals(newScript)) {
    throw new Error('splice self-check failed');
  }
  return { buf: out, tagUsed };
}

module.exports = { appendTag, sanitizeTag, MAX_TAG };
