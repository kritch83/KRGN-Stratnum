'use strict';
// X11 — the classic Bitcoin stratum every SHA-256/X11 ASIC speaks:
//   subscribe -> [[["mining.set_difficulty", id], ["mining.notify", id]], extraNonce1, extraNonce2Size]
//   mining.set_difficulty [difficulty]
//   mining.notify [jobId, prevhash, coinb1, coinb2, merkleBranch, version, nbits, ntime, cleanJobs]
//   mining.submit [worker, jobId, extraNonce2, ntime, nonce]
//
// There is no proof to check beyond the hash itself: a share is the X11 of
// the header it describes. That is why a long run of shares that miss the
// target counts against a connection here (`lowDiffCountsAsInvalid`) — junk
// cannot fail verification, it can only miss.

const util = require('../util');
const jobLib = require('../job-x11');
const { x11 } = require('../x11');

const hex = (v, len) => {
  const s = String(v === undefined || v === null ? '' : v).toLowerCase();
  return s.length === len && util.isHex(s) ? s : null;
};

module.exports = {
  name: 'bitcoin',
  en1Bytes: jobLib.EXTRANONCE_BYTES - jobLib.EN2_BYTES,
  lowDiffCountsAsInvalid: true,

  validateTemplate: jobLib.validateTemplate,
  buildJob: jobLib.buildJob,

  // ---- wire ----

  subscribeResult(session) {
    const id = String(session.id);
    return [[['mining.set_difficulty', id], ['mining.notify', id]], session.en1, jobLib.EN2_BYTES];
  },

  // The difficulty itself: the miner turns it into a target on the same
  // diff-1 scale the pool books shares on.
  targetMessage(session) {
    return ['mining.set_difficulty', [session.diffState.difficulty]];
  },

  notifyParams(job, clean) {
    return jobLib.notifyParams(job, clean);
  },

  // ---- shares ----

  parse(job, session, params, opts) {
    const en2Hex = hex(params[2], jobLib.EN2_BYTES * 2);
    const nTimeHex = hex(params[3], 8);
    const nonceHex = hex(params[4], 8);
    if (!en2Hex) return { reject: [20, 'incorrect size of extranonce2'] };
    if (!nTimeHex) return { reject: [20, 'incorrect size of ntime'] };
    if (!nonceHex) return { reject: [20, 'incorrect size of nonce'] };
    // A sixth param is BIP 310 version rolling. mining.configure turned it
    // down, and a rolled version is a different header from the one we check.
    if (params.length > 5 && params[5] !== undefined && params[5] !== null) {
      return { reject: [20, 'version rolling is not supported'] };
    }

    // Big-endian on the wire, as every classic-stratum miner sends them.
    const nTime = parseInt(nTimeHex, 16);
    const nowSec = Math.floor(Date.now() / 1000);
    if (nTime < job.curtime || nTime > nowSec + opts.nTimeToleranceSec) {
      return { reject: [20, 'ntime out of range'] };
    }
    // extraNonce1 is per connection, so these four fields pin down the header.
    return {
      dupKey: session.en1 + en2Hex + nTimeHex + nonceHex,
      work: { en2: Buffer.from(en2Hex, 'hex'), nTime, nonce: parseInt(nonceHex, 16) },
    };
  },

  // Rebuild what the miner hashed and hash it. Synchronous: ~1 ms.
  verify(job, session, work) {
    const coinbase = jobLib.coinbaseFor(job, Buffer.from(session.en1, 'hex'), work.en2);
    const merkleRoot = jobLib.foldBranch(util.sha256d(coinbase), job.merkleBranch);
    const header = jobLib.serializeHeader(job, merkleRoot, work.nTime, work.nonce);
    work.coinbase = coinbase;
    work.header = header;
    return { ok: true, hashBN: util.bufToBigIntLE(x11(header)) };
  },

  // The coinbase is this miner's own, so its txid comes from the share.
  block(job, session, work) {
    return {
      hex: jobLib.serializeBlock(job, work.header, work.coinbase).toString('hex'),
      cbTxid: util.reverseHex(util.sha256d(work.coinbase).toString('hex')),
    };
  },
};
