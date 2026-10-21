'use strict';
// Equihash 192/7 and 200/9 — the kerrigan-network stratum dialect, exactly as
// stratnum has always spoken it. The job and its serialization live in
// lib/job.js; this file is the wire format and the per-share check.

const util = require('../util');
const jobLib = require('../job');
const equihash = require('../equihash');

module.exports = {
  name: 'equihash',

  // extraNonce1 width. The miner fills the other 28 bytes of the 32-byte nonce.
  en1Bytes: 4,

  validateTemplate: jobLib.validateTemplate,
  buildJob: jobLib.buildJob,

  // ---- wire ----

  subscribeResult(session) {
    return [null, session.en1];
  },

  // The share target, always sent before the job it applies to.
  targetMessage(session) {
    return ['mining.set_target', [util.bigIntToHex64(session.shareTarget)]];
  },

  notifyParams(job, clean) {
    return jobLib.notifyParams(job, clean);
  },

  // ---- shares ----

  // Shape, nTime and the duplicate key — everything cheap. Returns
  // { reject: [code, reason] } or { dupKey, work }.
  parse(job, session, params, opts) {
    // Solution size and CompactSize prefix are the job's algo's — fd9001 + 400
    // bytes on 192/7, fd4005 + 1344 on 200/9 — and miners send it with or
    // without the prefix. Everything is lowercase-normalized first.
    const eq = job.algo.eq;
    const nTimeHex = String(params[2] === undefined ? '' : params[2]).toLowerCase();
    const en2Hex = String(params[3] === undefined ? '' : params[3]).toLowerCase();
    let solnHex = String(params[4] === undefined ? '' : params[4]).toLowerCase();
    if (nTimeHex.length !== 8 || !util.isHex(nTimeHex)) return { reject: [20, 'incorrect size of ntime'] };
    if (en2Hex.length !== 56 || !util.isHex(en2Hex)) return { reject: [20, 'incorrect size of extranonce2'] };
    const bareHexLen = eq.SOLUTION_BYTES * 2;
    if (solnHex.length === bareHexLen && util.isHex(solnHex)) solnHex = eq.SOLUTION_PREFIX + solnHex;
    if (solnHex.length !== eq.SOLUTION_PREFIX.length + bareHexLen || !util.isHex(solnHex) ||
        !solnHex.startsWith(eq.SOLUTION_PREFIX)) {
      return { reject: [20, 'incorrect size of solution'] };
    }

    // nTime range, against this job's own curtime.
    const nTimeBuf = util.hexToBuf(nTimeHex);
    const nTimeInt = nTimeBuf.readUInt32LE(0);
    const nowSec = Math.floor(Date.now() / 1000);
    if (nTimeInt < job.curtime || nTimeInt > nowSec + opts.nTimeToleranceSec) {
      return { reject: [20, 'ntime out of range'] };
    }

    // The PoW hash doubles as the duplicate key. It covers the whole header —
    // both extranonces and nTime — plus the solution, in 32 bytes, where
    // remembering the submission itself would cost 2.7 KB per share on 200/9.
    const nonceBuf = Buffer.concat([util.hexToBuf(session.en1), util.hexToBuf(en2Hex)]);
    const header = jobLib.serializeHeader(job, nTimeBuf, nonceBuf);
    const solnBuf = util.hexToBuf(solnHex);
    const powHash = util.sha256d(Buffer.concat([header, solnBuf]));
    return { dupKey: powHash.toString('hex'), work: { header, solnBuf, powHash } };
  },

  // The expensive step: is the solution a real equihash solution for this
  // header? Synchronous — the shared pipeline only awaits families that need it.
  verify(job, session, work) {
    const eq = job.algo.eq;
    const vres = equihash.verify(work.header, work.solnBuf.subarray(eq.SOLUTION_PREFIX.length / 2),
      job.personalization, eq);
    if (!vres.ok) {
      return { ok: false, reason: vres.reason,
        hint: `the miner is probably not set to --par=${eq.N},${eq.K} --pers=${job.personalization}` };
    }
    return { ok: true, hashBN: util.bufToBigIntLE(work.powHash) };
  },

  // The block this share completes, and the coinbase txid to follow it by.
  block(job, session, work) {
    return { hex: jobLib.serializeBlock(job, work.header, work.solnBuf).toString('hex'), cbTxid: job.cbTxidDisplay };
  },
};
