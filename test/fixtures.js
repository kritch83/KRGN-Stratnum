'use strict';
// Helpers around the committed real mainnet blocks, one per algo:
//   116370 — equihash192, with the explorer's JSON alongside the raw bytes
//   122284 — equihash200, raw bytes only (`getblock <hash> 0`), so its txids
//            are derived from the bytes here
// Everything derived here is self-validated in vectors.test.js — txids against
// the explorer (192/7) or the header's merkle root (200/9), heights against
// the coinbase — so downstream tests can trust these slices.

const fs = require('fs');
const path = require('path');
const util = require('../lib/util');
const equihash = require('../lib/equihash');

const VECTORS = path.join(__dirname, 'vectors');

// Every helper defaults to the 192/7 block, which is what the tests written
// before 200/9 existed mean.
const DEFAULT_ALGO = 'equihash192';
const REAL = {
  equihash192: { file: 'block-116370.rawblock.json', height: 116370, eq: equihash.EQ192, personalization: 'kerrigan' },
  equihash200: { file: 'block-122284.rawblock.json', height: 122284, eq: equihash.EQ200, personalization: 'ZcashPoW' },
};

// The 192/7 CompactSize solution prefix, as older tests import it.
const SOLUTION_PREFIX = Buffer.from(equihash.EQ192.SOLUTION_PREFIX, 'hex');

function spec(algo) {
  const s = REAL[algo || DEFAULT_ALGO];
  if (!s) throw new Error('fixtures: no real block for ' + algo);
  return s;
}

// Explorer JSON — the 192/7 block only.
function loadBlockJson() {
  return JSON.parse(fs.readFileSync(path.join(VECTORS, 'block-116370.json'), 'utf8'));
}

function loadVector(algo) {
  return JSON.parse(fs.readFileSync(path.join(VECTORS, spec(algo).file), 'utf8'));
}

function loadRawBlockHex(algo) {
  return loadVector(algo).rawblock.toLowerCase();
}

function parseHeader(header) {
  return {
    version: header.readUInt32LE(0),
    prevHash: header.subarray(4, 36),
    merkleRoot: header.subarray(36, 68),
    hashReserved: header.subarray(68, 100),
    nTime: header.readUInt32LE(100),
    bitsBuf: header.subarray(104, 108),
    nonce: header.subarray(108, 140),
  };
}

// Minimal Dash-family tx walker: u32(version | type<<16), vins, vouts,
// locktime, then a varint-length extraPayload when version >= 3 && type != 0.
function skipTx(buf, off) {
  const verRaw = buf.readUInt32LE(off);
  const version = verRaw & 0xffff;
  const type = verRaw >>> 16;
  off += 4;
  const vin = util.readVarint(buf, off);
  off += vin.size;
  for (let i = 0; i < vin.value; i++) {
    off += 36; // outpoint
    const script = util.readVarint(buf, off);
    off += script.size + script.value;
    off += 4; // sequence
  }
  const vout = util.readVarint(buf, off);
  off += vout.size;
  for (let i = 0; i < vout.value; i++) {
    off += 8; // value
    const script = util.readVarint(buf, off);
    off += script.size + script.value;
  }
  off += 4; // locktime
  if (version >= 3 && type !== 0) {
    const payload = util.readVarint(buf, off);
    off += payload.size + payload.value;
  }
  return off;
}

function parseRealBlock(algo) {
  const s = spec(algo);
  const rawHex = loadRawBlockHex(algo);
  const raw = util.hexToBuf(rawHex, 'rawblock');
  const header = raw.subarray(0, 140);
  const prefix = Buffer.from(s.eq.SOLUTION_PREFIX, 'hex');
  const solStart = 140 + prefix.length;
  const solEnd = solStart + s.eq.SOLUTION_BYTES;
  if (!raw.subarray(140, solStart).equals(prefix)) {
    throw new Error('fixture: unexpected solution preamble ' + raw.subarray(140, solStart).toString('hex'));
  }
  const txCount = util.readVarint(raw, solEnd);
  const txs = [];
  let off = solEnd + txCount.size;
  for (let i = 0; i < txCount.value; i++) {
    const start = off;
    off = skipTx(raw, off);
    txs.push(raw.subarray(start, off));
  }
  if (off !== raw.length) throw new Error(`fixture: trailing bytes (${raw.length - off})`);
  return {
    algo: algo || DEFAULT_ALGO,
    height: s.height,
    raw, rawHex, header,
    solution: raw.subarray(solStart, solEnd),
    solutionWithPrefix: raw.subarray(140, solEnd),
    txCount: txCount.value, txs,
    // Display-order txids from the bytes. Dash special transactions hash
    // their whole serialization, extra payload included.
    txids: txs.map(tx => util.reverseHex(util.sha256d(tx).toString('hex'))),
    fields: parseHeader(header),
  };
}

// Derive a getblocktemplate-shaped object from a real block, as the daemon
// would have served it just before that block was mined. The daemon's
// header_hex carries its own (zero) nonce; only bytes 0..107 are comparable.
function gbtFromRealBlock(overrides, algo) {
  const a = algo || DEFAULT_ALGO;
  const s = spec(a);
  const blk = parseRealBlock(a);
  const f = blk.fields;
  const bitsDisplay = util.reverseHex(f.bitsBuf.toString('hex'));
  const tpl = {
    version: f.version,
    previousblockhash: util.reverseHex(f.prevHash.toString('hex')),
    finalsaplingroothash: util.reverseHex(f.hashReserved.toString('hex')),
    curtime: f.nTime,
    bits: bitsDisplay,
    height: s.height,
    target: util.bigIntToHex64(util.compactToTarget(bitsDisplay)),
    coinbasetxn: { data: blk.txs[0].toString('hex') },
    transactions: blk.txs.slice(1).map((tx, i) => ({
      data: tx.toString('hex'),
      txid: blk.txids[i + 1],
      hash: blk.txids[i + 1],
    })),
    coinbasevalue: 2500000000,
    coinbasevalue_miner: 500000000,
    equihash_n: s.eq.N,
    equihash_k: s.eq.K,
    personalization: s.personalization,
    header_hex: Buffer.concat([blk.header.subarray(0, 108), Buffer.alloc(32)]).toString('hex'),
    longpollid: 'lp-' + s.height,
    template_hash: a === 'equihash192' ? loadBlockJson().hash : loadVector(a).hash,
    mutable: ['time', 'transactions', 'prevblock'],
    algo: a,
  };
  return Object.assign(tpl, overrides || {});
}

// The real block's winning share as a miner would submit it: extraNonce1 is
// the nonce's first 4 bytes (tests pin it via STRATNUM_FORCE_EN1) and the
// other 28 are extraNonce2.
function realShare(algo) {
  const blk = parseRealBlock(algo);
  const f = blk.fields;
  return {
    en1: f.nonce.subarray(0, 4).toString('hex'),
    en2: f.nonce.subarray(4).toString('hex'),
    nTime: util.u32LEHex(f.nTime),
    soln: blk.solutionWithPrefix.toString('hex'),
    rawHex: blk.rawHex,
    curtime: f.nTime,
    height: blk.height,
    cbTxid: blk.txids[0],
    hashBN: util.bufToBigIntLE(util.sha256d(Buffer.concat([blk.header, blk.solutionWithPrefix]))),
  };
}

module.exports = {
  loadBlockJson, loadRawBlockHex, parseRealBlock, parseHeader, gbtFromRealBlock, realShare,
  SOLUTION_PREFIX, REAL,
};
