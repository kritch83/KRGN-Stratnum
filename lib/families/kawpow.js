'use strict';
// KawPoW — the Ravencoin stratum dialect Kerrigan's reference pools use:
//   subscribe -> [["mining.notify", id], extraNonce1]   (2 bytes: the nonce prefix)
//   mining.set_target [target]
//   mining.notify [jobId, headerHash, seedHash, target, clean, height, bits]
//   mining.submit [worker, jobId, "0x"+nonce, "0x"+headerHash, "0x"+mixHash]
//
// A share's mix is recomputed in full (lib/kawpow.js, on a worker thread) and
// must equal the one submitted. Shares that would not count anyway are told
// apart first by the cheap final hash, so junk never costs a full computation
// — which also means junk mostly shows up as low difficulty rather than as an
// invalid mix, so misses count against the connection too.

const util = require('../util');
const kawpow = require('../kawpow');
const jobLib = require('../job-kawpow');
const { KawpowVerifier } = require('../kawpow-verifier');

let verifier = null;
let verifierOpts = {};

// server.js sets where epoch caches are kept; tests may point it elsewhere.
function configure(opts) {
  verifierOpts = Object.assign({}, opts || {});
  if (verifier) { verifier.close(); verifier = null; }
}

function getVerifier() {
  if (!verifier) verifier = new KawpowVerifier(verifierOpts);
  return verifier;
}

const hex = (v, len) => {
  const s = String(v === undefined || v === null ? '' : v).toLowerCase();
  const bare = s.startsWith('0x') ? s.slice(2) : s;
  return bare.length === len && util.isHex(bare) ? bare : null;
};

// Would a share with this hash count for anything — the session's target,
// the one it had just before a retarget, or a block? The same tolerance the
// shared pipeline applies.
function couldCount(hashBN, job, session) {
  if (hashBN <= job.blockTarget) return true;
  if (hashBN * 99n <= session.shareTarget * 100n) return true;
  return session.prevShareTarget !== null && hashBN * 99n <= session.prevShareTarget * 100n;
}

module.exports = {
  name: 'kawpow',
  en1Bytes: 2,
  lowDiffCountsAsInvalid: true,
  configure,
  _getVerifier: getVerifier,   // for the tests

  validateTemplate: jobLib.validateTemplate,

  buildJob(tpl, jobId, opts) {
    const job = jobLib.buildJob(tpl, jobId, opts);
    getVerifier().prepare(job.height);   // have the epoch ready before shares need it
    return job;
  },

  // ---- wire ----

  subscribeResult(session) {
    return [['mining.notify', String(session.id)], session.en1];
  },

  targetMessage(session) {
    return ['mining.set_target', [util.bigIntToHex64(session.shareTarget)]];
  },

  notifyParams(job, clean, session) {
    return [job.id, job.headerHashHex, job.seedHashHex, util.bigIntToHex64(session.shareTarget),
      !!clean, job.height, job.bitsHex];
  },

  // ---- shares ----

  parse(job, session, params) {
    const nonceHex = hex(params[2], 16);
    const headerHex = hex(params[3], 64);
    const mixHex = hex(params[4], 64);
    if (!nonceHex) return { reject: [20, 'incorrect size of nonce'] };
    if (!headerHex) return { reject: [20, 'incorrect size of header hash'] };
    if (!mixHex) return { reject: [20, 'incorrect size of mix hash'] };
    if (headerHex !== job.headerHashHex) return { reject: [20, 'header hash does not match the job'] };
    // extraNonce1 is the nonce's top two bytes: it is what keeps two rigs from
    // searching the same nonces.
    if (!nonceHex.startsWith(session.en1)) return { reject: [20, 'nonce outside your extranonce range'] };
    // The header is fixed per job, so the nonce alone identifies the work.
    return { dupKey: nonceHex, work: { nonce: BigInt('0x' + nonceHex), mixHash: Buffer.from(mixHex, 'hex') } };
  },

  async verify(job, session, work) {
    const claimed = kawpow.finalHash(job.height, job.headerHash, work.mixHash, work.nonce);
    const claimedBN = BigInt('0x' + claimed.toString('hex'));
    // Not good enough to count even if the mix were real: the shared pipeline
    // rejects it as low difficulty, and nothing is gained by proving the mix.
    if (!couldCount(claimedBN, job, session)) return { ok: true, hashBN: claimedBN };
    const real = await getVerifier().hash(job.height, job.headerHash, work.nonce);
    if (!real.mixHash.equals(work.mixHash)) {
      return { ok: false, reason: 'mix hash does not match the nonce',
        hint: 'the miner is probably not mining KawPoW for this job (wrong coin, or a stale header hash)' };
    }
    return { ok: true, hashBN: BigInt('0x' + real.finalHash.toString('hex')) };
  },

  block(job, session, work) {
    return { hex: jobLib.serializeBlock(job, work.nonce, work.mixHash).toString('hex'), cbTxid: job.cbTxidDisplay };
  },
};
