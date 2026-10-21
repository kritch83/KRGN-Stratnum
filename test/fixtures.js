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
  // 80-byte-header blocks. 122281/122282 (KawPoW) and 122278/122283 (X11) are
  // neighbours of the 200/9 block above, fetched from the public explorer.
  kawpow: { file: 'block-122281.rawblock.json', height: 122281, family: 'kawpow' },
  kawpow2: { file: 'block-122282.rawblock.json', height: 122282, family: 'kawpow', algo: 'kawpow' },
  x11: { file: 'block-122283.rawblock.json', height: 122283, family: 'bitcoin' },
  x11b: { file: 'block-122278.rawblock.json', height: 122278, family: 'bitcoin', algo: 'x11' },
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

// The 80-byte header X11 and KawPoW blocks start with.
function parseHeader80(header) {
  return {
    version: header.readUInt32LE(0),
    prevHash: header.subarray(4, 36),
    merkleRoot: header.subarray(36, 68),
    nTime: header.readUInt32LE(68),
    bitsBuf: header.subarray(72, 76),
    nNonce: header.readUInt32LE(76),
  };
}

function walkTxs(raw, off) {
  const txCount = util.readVarint(raw, off);
  const txs = [];
  off += txCount.size;
  for (let i = 0; i < txCount.value; i++) {
    const start = off;
    off = skipTx(raw, off);
    txs.push(raw.subarray(start, off));
  }
  if (off !== raw.length) throw new Error(`fixture: trailing bytes (${raw.length - off})`);
  return { txCount: txCount.value, txs, txids: txs.map(tx => util.reverseHex(util.sha256d(tx).toString('hex'))) };
}

// KawPoW: header | nHeight u32 | nNonce64 u64 | mix_hash (uint256, i.e. the
// miner's mix byte-reversed) | txs.
function parseKawpowBlock(key) {
  const s = spec(key);
  const rawHex = loadRawBlockHex(key);
  const raw = util.hexToBuf(rawHex, 'rawblock');
  const header = raw.subarray(0, 80);
  return Object.assign({
    algo: 'kawpow', height: s.height, raw, rawHex, header,
    nHeight: raw.readUInt32LE(80),
    nonce: raw.readBigUInt64LE(84),
    mixHash: util.reverseBuf(raw.subarray(92, 124)),
    // What miners are sent: the header's sha256d, display (big-endian) order.
    headerHash: util.reverseBuf(util.sha256d(header)),
    fields: parseHeader80(header),
  }, walkTxs(raw, 124));
}

// X11: a plain 80-byte header, then the transactions.
function parseX11Block(key) {
  const s = spec(key);
  const rawHex = loadRawBlockHex(key);
  const raw = util.hexToBuf(rawHex, 'rawblock');
  const header = raw.subarray(0, 80);
  return Object.assign({ algo: 'x11', height: s.height, raw, rawHex, header, fields: parseHeader80(header) },
    walkTxs(raw, 80));
}

function parseRealBlock(algo) {
  const s = spec(algo);
  if (s.family === 'kawpow') return parseKawpowBlock(algo);
  if (s.family === 'bitcoin') return parseX11Block(algo);
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
// KawPoW template as the daemon would have served it for a real block. Its
// `headerhash` is computed the node's way (src/rpc/mining.cpp): over the
// template's own header, merkle root left zeroed. nNonce is the one liberty —
// the live node puts 0 there, but these blocks' pool put the height, and
// keeping it is what lets the job's nNonce check land on the height so the
// replay reproduces the real block byte for byte.
// The node's GBT `headerhash` for a template whose header is `header`, with
// its merkle root zeroed and `nNonce` in the nonce field (0 on the live node).
function daemonHeaderHash(header, nNonce) {
  const h = Buffer.from(header);
  h.fill(0, 36, 68);
  h.writeUInt32LE(nNonce >>> 0, 76);
  return util.reverseBuf(util.sha256d(h));
}

function gbtFromKawpowBlock(overrides, key) {
  const s = spec(key);
  const blk = parseKawpowBlock(key);
  const f = blk.fields;
  const kawpow = require('../lib/kawpow');
  const bitsDisplay = util.reverseHex(f.bitsBuf.toString('hex'));
  const vec = loadVector(key);
  return Object.assign({
    version: f.version,
    previousblockhash: util.reverseHex(f.prevHash.toString('hex')),
    curtime: f.nTime,
    bits: bitsDisplay,
    height: s.height,
    target: util.bigIntToHex64(util.compactToTarget(bitsDisplay)),
    coinbasetxn: { data: blk.txs[0].toString('hex') },
    transactions: blk.txs.slice(1).map((tx, i) => ({ data: tx.toString('hex'), txid: blk.txids[i + 1], hash: blk.txids[i + 1] })),
    coinbasevalue: 2500000000,
    coinbasevalue_miner: 500000000,
    headerhash: daemonHeaderHash(blk.header, f.nNonce).toString('hex'),
    seedhash: kawpow.epochSeed(kawpow.epochOf(s.height)).toString('hex'),
    longpollid: 'lp-' + s.height,
    template_hash: vec.hash,
    mutable: ['time', 'transactions', 'prevblock'],
    algo: 'kawpow',
  }, overrides || {});
}

// The real X11 blocks were mined by a pool that built its own coinbase
// (merged-mining marker, its extranonce, its name). The daemon's coinbase is
// that transaction with the daemon's own 1-byte scriptSig — OP_RETURN, as in
// the 192/7 block stratnum mined from a daemon template — so outputs and the
// CbTx payload stay real.
function x11DaemonCoinbase(key) {
  const cb = parseX11Block(key).txs[0];
  let off = 4;
  off += util.readVarint(cb, off).size + 36;
  const sl = util.readVarint(cb, off);
  return Buffer.concat([cb.subarray(0, off), Buffer.from([1, 0x6a]), cb.subarray(off + sl.size + sl.value)]);
}

function gbtFromX11Block(overrides, key) {
  const s = spec(key);
  const blk = parseX11Block(key);
  const f = blk.fields;
  const bitsDisplay = util.reverseHex(f.bitsBuf.toString('hex'));
  return Object.assign({
    version: f.version,
    previousblockhash: util.reverseHex(f.prevHash.toString('hex')),
    curtime: f.nTime,
    bits: bitsDisplay,
    height: s.height,
    target: util.bigIntToHex64(util.compactToTarget(bitsDisplay)),
    coinbasetxn: { data: x11DaemonCoinbase(key).toString('hex') },
    transactions: blk.txs.slice(1).map((tx, i) => ({ data: tx.toString('hex'), txid: blk.txids[i + 1], hash: blk.txids[i + 1] })),
    coinbasevalue: 2500000000,
    coinbasevalue_miner: 500000000,
    longpollid: 'lp-' + s.height,
    template_hash: loadVector(key).hash,
    mutable: ['time', 'transactions', 'prevblock'],
    algo: 'x11',
  }, overrides || {});
}

// What a classic-stratum miner does with mining.notify, written the way the
// reference pools serialize a header — each field written big-endian, then
// the whole 80 bytes reversed — so it shares no code with lib/job-x11.js.
// Returns the header it hashes, the coinbase it built, and the block.
function x11MinerAssemble(notifyParams, en1Hex, en2Hex, nTimeHex, nonceHex, txDatas) {
  const [, prevHashStratum, coinb1, coinb2, branch, versionHex, nbitsHex] = notifyParams;
  const coinbase = Buffer.from(coinb1 + en1Hex + en2Hex + coinb2, 'hex');
  let root = util.sha256d(coinbase);
  for (const h of branch) root = util.sha256d(Buffer.concat([root, Buffer.from(h, 'hex')]));
  // Stratum's prevhash is the internal hash with each 4-byte word swapped;
  // display order is the internal order reversed.
  const words = prevHashStratum.match(/.{8}/g);
  const prevDisplay = words.reverse().join('');
  const h = Buffer.alloc(80);
  h.write(nonceHex, 0, 'hex');
  h.write(nbitsHex, 4, 'hex');
  h.write(nTimeHex, 8, 'hex');
  h.write(util.reverseHex(root.toString('hex')), 12, 'hex');
  h.write(prevDisplay, 44, 'hex');
  h.write(versionHex, 76, 'hex');
  const header = util.reverseBuf(h);
  const txs = txDatas || [];
  const block = Buffer.concat([header, util.varint(1 + txs.length), coinbase, ...txs]);
  return { header, coinbase, block, cbTxid: util.reverseHex(util.sha256d(coinbase).toString('hex')) };
}

function gbtFromRealBlock(overrides, algo) {
  const a = algo || DEFAULT_ALGO;
  const s = spec(a);
  if (s.family === 'kawpow') return gbtFromKawpowBlock(overrides, a);
  if (s.family === 'bitcoin') return gbtFromX11Block(overrides, a);
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
  if (spec(algo).family === 'kawpow') {
    // The block's winning KawPoW share: extraNonce1 is the nonce's top two
    // bytes (tests pin it via STRATNUM_FORCE_EN1).
    const blk = parseKawpowBlock(algo);
    const nonceHex = blk.nonce.toString(16).padStart(16, '0');
    const kawpow = require('../lib/kawpow');
    return {
      en1: nonceHex.slice(0, 4),
      nonceHex,
      headerHashHex: blk.headerHash.toString('hex'),
      mixHex: blk.mixHash.toString('hex'),
      rawHex: blk.rawHex,
      height: blk.height,
      cbTxid: blk.txids[0],
      hashBN: BigInt('0x' + kawpow.finalHash(blk.height, blk.headerHash, blk.mixHash, blk.nonce).toString('hex')),
    };
  }
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
  loadBlockJson, loadRawBlockHex, parseRealBlock, parseHeader, parseHeader80, gbtFromRealBlock, realShare,
  x11DaemonCoinbase, x11MinerAssemble, daemonHeaderHash,
  SOLUTION_PREFIX, REAL,
};
