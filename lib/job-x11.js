'use strict';
// X11 template -> job, for the classic stratum. Kerrigan's X11 block is a
// plain Bitcoin-style block: an 80-byte header whose X11 is both the proof of
// work and the block hash. Miners build the coinbase themselves from
// coinb1 || extraNonce1 || extraNonce2 || coinb2, fold it up the merkle
// branch, and roll the header's 32-bit nonce (and nTime) — so the coinbase,
// and with it the merkle root and the coinbase txid, differ for every share.

const util = require('./util');
const coinbaseLib = require('./coinbase');

// extraNonce1 (the pool's, 4 bytes) + extraNonce2 (the miner's, 4 bytes).
const EXTRANONCE_BYTES = 8;
const EN2_BYTES = 4;

function validateTemplate(tpl, algo) {
  const fail = reason => ({ ok: false, reason });
  if (!tpl || typeof tpl !== 'object') return fail('template is not an object');
  if (!Number.isInteger(tpl.version)) return fail('missing version');
  const nibble = (tpl.version >> 8) & 0xf;
  if (nibble !== algo.versionNibble) {
    return fail(`template version 0x${(tpl.version >>> 0).toString(16)} is not ${algo.key} ` +
      `(algo nibble ${nibble}, expected ${algo.versionNibble}) — check rpcalgoport/algo settings on the daemon`);
  }
  if (tpl.algo !== undefined && tpl.algo !== algo.key) return fail(`template is for ${JSON.stringify(tpl.algo)}, expected ${algo.key}`);
  if (!tpl.coinbasetxn || !util.isHex(tpl.coinbasetxn.data) || tpl.coinbasetxn.data.length < 2) {
    return fail('missing coinbasetxn.data — daemon did not build the coinbase (is pooladdress being sent?)');
  }
  if (!util.isHex(tpl.previousblockhash) || tpl.previousblockhash.length !== 64) return fail('bad previousblockhash');
  if (!util.isHex(tpl.target) || tpl.target.length !== 64) return fail('bad target');
  if (!util.isHex(tpl.bits) || tpl.bits.length !== 8) return fail('bad bits');
  if (!Number.isInteger(tpl.height) || tpl.height < 1) return fail('missing height');
  if (!Number.isInteger(tpl.curtime)) return fail('missing curtime');
  for (const tx of tpl.transactions || []) {
    if (!util.isHex(tx.data)) return fail('bad transaction data');
    const txid = tx.txid !== undefined ? tx.txid : tx.hash;
    if (!util.isHex(txid) || txid.length !== 64) return fail('bad transaction txid');
  }
  return { ok: true };
}

// The hashes a miner folds its coinbase hash with, bottom up: the coinbase is
// leaf 0, so each step is its sibling at that level. Odd levels duplicate
// their last element, as util.merkleRoot does.
function merkleBranch(txHashes) {
  const branch = [];
  let level = [null].concat(txHashes);   // null: the coinbase, not known yet
  while (level.length > 1) {
    branch.push(level[1]);
    const next = [null];
    for (let i = 2; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(util.sha256d(Buffer.concat([a, b])));
    }
    level = next;
  }
  return branch;
}

function foldBranch(coinbaseHash, branch) {
  let h = coinbaseHash;
  for (const sib of branch) h = util.sha256d(Buffer.concat([h, sib]));
  return h;
}

// Each 4-byte word of the internal-order hash byte-swapped: the order every
// classic-stratum miner expects prevhash in.
function swap32(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i += 4) out.writeUInt32LE(buf.readUInt32BE(i), i);
  return out;
}

const be32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b.toString('hex'); };

// opts: { algo, coinbaseTag? }
function buildJob(tpl, jobId, opts) {
  const algo = opts.algo;
  const gate = validateTemplate(tpl, algo);
  if (!gate.ok) throw new Error('invalid template: ' + gate.reason);

  const split = coinbaseLib.splitForExtranonce(tpl.coinbasetxn.data, EXTRANONCE_BYTES, opts.coinbaseTag);
  const txs = tpl.transactions || [];
  const txHashes = txs.map(tx => util.reverseBuf(util.hexToBuf(tx.txid !== undefined ? tx.txid : tx.hash, 'txid')));
  const branch = merkleBranch(txHashes);

  // The branch is what every share's merkle root comes from, so check it
  // against the full-tree computation the other algos use before any miner
  // sees it.
  const probe = util.sha256d(Buffer.concat([split.coinb1, Buffer.alloc(EXTRANONCE_BYTES), split.coinb2]));
  if (!foldBranch(probe, branch).equals(util.merkleRoot([probe].concat(txHashes)))) {
    throw new Error('merkle branch self-check failed');
  }

  const prevHash = util.reverseBuf(util.hexToBuf(tpl.previousblockhash));
  return {
    id: jobId,
    algo,
    createdAt: Date.now(),
    height: tpl.height,
    curtime: tpl.curtime,
    version: tpl.version >>> 0,
    prevHash,
    prevHashDisplay: tpl.previousblockhash.toLowerCase(),
    blockTarget: BigInt('0x' + tpl.target),
    bitsHex: tpl.bits.toLowerCase(),
    bits: util.reverseBuf(util.hexToBuf(tpl.bits)),
    minerRewardSat: Number.isInteger(tpl.coinbasevalue_miner) ? tpl.coinbasevalue_miner
      : Number.isInteger(tpl.coinbasevalue) ? tpl.coinbasevalue : 0,
    templateHash: tpl.template_hash,
    txCount: 1 + txs.length,
    coinb1: split.coinb1,
    coinb2: split.coinb2,
    merkleBranch: branch,
    // What mining.notify carries.
    prevHashStratum: swap32(prevHash).toString('hex'),
    coinb1Hex: split.coinb1.toString('hex'),
    coinb2Hex: split.coinb2.toString('hex'),
    merkleBranchHex: branch.map(h => h.toString('hex')),
    versionHex: be32(tpl.version),
    ntimeHex: be32(tpl.curtime),
    txDatas: txs.map(tx => util.hexToBuf(tx.data, 'tx data')),
    coinbaseTagged: split.tagUsed !== null,
    tagSkipped: split.tagSkipped,
    seen: new Set(),
  };
}

function notifyParams(job, clean) {
  return [job.id, job.prevHashStratum, job.coinb1Hex, job.coinb2Hex, job.merkleBranchHex,
    job.versionHex, job.bitsHex, job.ntimeHex, !!clean];
}

// en1, en2: Buffers. The coinbase exactly as the miner hashed it.
function coinbaseFor(job, en1, en2) {
  return Buffer.concat([job.coinb1, en1, en2, job.coinb2]);
}

// merkleRoot: internal order; nTime, nonce: u32 numbers.
function serializeHeader(job, merkleRoot, nTime, nonce) {
  const h = Buffer.alloc(80);
  h.writeUInt32LE(job.version, 0);
  job.prevHash.copy(h, 4);
  merkleRoot.copy(h, 36);
  h.writeUInt32LE(nTime >>> 0, 68);
  job.bits.copy(h, 72);
  h.writeUInt32LE(nonce >>> 0, 76);
  return h;
}

function serializeBlock(job, header, coinbase) {
  return Buffer.concat([header, util.varint(job.txCount), coinbase, ...job.txDatas]);
}

module.exports = {
  EXTRANONCE_BYTES, EN2_BYTES,
  validateTemplate, buildJob, notifyParams,
  merkleBranch, foldBranch, swap32,
  coinbaseFor, serializeHeader, serializeBlock,
};
