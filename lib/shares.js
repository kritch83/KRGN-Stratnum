'use strict';
// Share submission pipeline — single owner of accept/reject/block decisions.
// Pipeline order is load-bearing; see the numbered steps.
//
// Events:
//   'accepted' { worker, session, bookedDiff, shareDiff, height, isBlock }
//   'rejected' { worker, code, reason }
//   'block'    { height, worker, cbTxid, accepted, submitResult, rewardSat,
//                shareDiff, foundAt }

const EventEmitter = require('events');
const util = require('./util');
const jobLib = require('./job');
const equihash = require('./equihash');

// A run this long means the miner is not solving this algo at all — 192/7
// params on the 200/9 port, the wrong personalization, or something that is
// not a miner. Honest rigs do emit the odd invalid solution from GPU noise,
// but never a streak: any solution that verifies clears the count.
const MAX_CONSECUTIVE_INVALID = 20;

// How many shares one job remembers for duplicate detection. The keys are
// 32-byte hashes, so the cap is a few MB per job — and it is only ever reached
// by a very fast miner sitting at a very low difficulty, which is precisely
// when vardiff has not caught up yet. Past the cap the oldest entries are
// forgotten; the worst that can then happen is a replayed share counted twice
// in the statistics, and on a solo pool shares buy nothing — the reward is
// paid by the block's own coinbase.
const MAX_SEEN_PER_JOB = 20000;

class ShareProcessor extends EventEmitter {
  // opts: { nTimeToleranceSec }
  constructor(stratum, daemon, opts, log) {
    super();
    this.stratum = stratum;
    this.daemon = daemon;
    this.opts = opts;
    this.log = log;
    // An instance field so a test can shrink the window to a few entries.
    this.maxSeenPerJob = MAX_SEEN_PER_JOB;
    stratum.onSubmit = (session, params) => this.processSubmit(session, params);
  }

  async processSubmit(session, params) {
    const reject = (code, reason) => {
      this.emit('rejected', { worker: session.workerName || 'worker', code, reason });
      return { error: [code, reason, null] };
    };

    // 1-2: session state
    if (!session.subscribed) return reject(25, 'not subscribed');
    if (!session.authorized) return reject(24, 'unauthorized worker');

    // 3: job lookup (current + retained refreshes)
    const jobId = typeof params[1] === 'string' ? params[1] : String(params[1]);
    const job = this.stratum.jobs.get(jobId);
    if (!job) return reject(21, 'job not found');

    // 4: shape (lowercase-normalized). Solution size and CompactSize prefix
    //    are the job's algo's — fd9001 + 400 bytes on 192/7, fd4005 + 1344 on
    //    200/9 — and miners send it with or without the prefix.
    const eq = job.algo.eq;
    const nTimeHex = String(params[2] === undefined ? '' : params[2]).toLowerCase();
    const en2Hex = String(params[3] === undefined ? '' : params[3]).toLowerCase();
    let solnHex = String(params[4] === undefined ? '' : params[4]).toLowerCase();
    if (nTimeHex.length !== 8 || !util.isHex(nTimeHex)) return reject(20, 'incorrect size of ntime');
    if (en2Hex.length !== 56 || !util.isHex(en2Hex)) return reject(20, 'incorrect size of extranonce2');
    const bareHexLen = eq.SOLUTION_BYTES * 2;
    if (solnHex.length === bareHexLen && util.isHex(solnHex)) solnHex = eq.SOLUTION_PREFIX + solnHex;
    if (solnHex.length !== eq.SOLUTION_PREFIX.length + bareHexLen || !util.isHex(solnHex) ||
        !solnHex.startsWith(eq.SOLUTION_PREFIX)) {
      return reject(20, 'incorrect size of solution');
    }

    // 5: nTime range (against this job's own curtime)
    const nTimeBuf = util.hexToBuf(nTimeHex);
    const nTimeInt = nTimeBuf.readUInt32LE(0);
    const nowSec = Math.floor(Date.now() / 1000);
    if (nTimeInt < job.curtime || nTimeInt > nowSec + this.opts.nTimeToleranceSec) {
      return reject(20, 'ntime out of range');
    }

    // 6: the PoW hash, which doubles as the duplicate-detection key. It covers
    //    the whole header — both extranonces and nTime — plus the solution, in
    //    32 bytes, where remembering the submission itself would cost 2.7 KB
    //    per share on 200/9. Hashing is microseconds; verifying is milliseconds,
    //    so a repeat is caught before the expensive step.
    const nonceBuf = Buffer.concat([util.hexToBuf(session.en1), util.hexToBuf(en2Hex)]);
    const header = jobLib.serializeHeader(job, nTimeBuf, nonceBuf);
    const solnBuf = util.hexToBuf(solnHex);
    const powHash = util.sha256d(Buffer.concat([header, solnBuf]));
    const dupKey = powHash.toString('hex');
    if (job.seen.has(dupKey)) return reject(22, 'duplicate share');

    // 7: equihash solution verification — the expensive step, and the reason a
    //    connection that never produces a real solution is shown the door
    //    instead of being served forever.
    const vres = equihash.verify(header, solnBuf.subarray(eq.SOLUTION_PREFIX.length / 2), job.personalization, eq);
    if (!vres.ok) {
      session.invalidSolns++;
      session.invalidStreak++;
      if (session.invalidSolns <= 3 || session.invalidSolns % 50 === 0) {
        this.log.warn(`invalid solution from ${session.workerName} (${vres.reason}, #${session.invalidSolns}) — ` +
          `if EVERY share fails, the miner is probably not set to --par=${eq.N},${eq.K} --pers=${job.personalization}`);
      }
      if (session.invalidStreak >= MAX_CONSECUTIVE_INVALID) {
        this.stratum.dropAfterReply(session, `${session.invalidStreak} invalid solutions in a row`);
      }
      return reject(20, 'invalid solution');
    }
    // A solution that verifies means this miner is solving the right thing,
    // whatever this particular share's difficulty turns out to be.
    session.invalidStreak = 0;

    // 8: remember it, so the same work cannot be counted twice. Only shares
    //    that verified get in, so junk can never fill the window.
    job.seen.add(dupKey);
    while (job.seen.size > this.maxSeenPerJob) {
      job.seen.delete(job.seen.values().next().value);   // oldest first
    }

    const hashBN = util.bufToBigIntLE(powHash);
    // On the job's own algo's scale — the one vardiff and set_target use.
    const shareDiff = Number((job.algo.diff1 * 1000n) / hashBN) / 1000;

    // 9: block check FIRST (a block-worthy hash must never die on share rules)
    let isBlock = false;
    if (hashBN <= job.blockTarget) {
      isBlock = true;
      await this._submitBlock(job, header, solnBuf, session, shareDiff);
    }

    // 10-11: share target (0.99 tolerance, exact integers) with retarget grace
    let bookedDiff;
    if (hashBN * 99n <= session.shareTarget * 100n) {
      bookedDiff = session.diffState.difficulty;
      session.prevShareTarget = null; // first accept at the new target ends the grace window
    } else if (session.prevShareTarget !== null && hashBN * 99n <= session.prevShareTarget * 100n) {
      bookedDiff = session.diffState.previousDifficulty !== null
        ? session.diffState.previousDifficulty
        : session.diffState.difficulty;
    } else if (isBlock) {
      bookedDiff = session.diffState.difficulty; // block-worthy share is always accepted
    } else {
      return reject(23, 'low difficulty share of ' + shareDiff);
    }

    session.lastShareAt = Date.now();
    if (shareDiff > session.bestShareDiff) session.bestShareDiff = shareDiff;

    this.emit('accepted', {
      worker: session.workerName,
      session,
      bookedDiff,
      shareDiff,
      height: job.height,
      isBlock,
      // The difficulty THIS share was mined against, not whatever it happens
      // to be when the round ends — that is the whole point of weighting.
      netDiff: job.algo.targetToDiff(job.blockTarget),
    });

    // 12: vardiff
    const newDiff = this.stratum.vardiff.onShare(session.diffState);
    if (newDiff !== null) this.stratum.applyRetarget(session, newDiff);

    return { result: true };
  }

  async _submitBlock(job, header, solnBuf, session, shareDiff) {
    const blockHex = jobLib.serializeBlock(job, header, solnBuf).toString('hex');
    // A candidate on a superseded job is exactly the case that used to be
    // discarded as "job not found". Call it out: it is worth submitting
    // anyway, and worth knowing how often the race actually fires.
    const cur = this.stratum.currentJob;
    const stale = cur && cur.height > job.height
      ? ` (LATE — chain has already moved to ${cur.height}, submitting anyway)` : '';
    this.log.info(`*** BLOCK CANDIDATE at height ${job.height} by ${session.workerName} ` +
      `(share diff ${shareDiff})${stale} — submitting to daemon ***`);
    const res = await this.daemon.submitBlock(blockHex);
    const accepted = res.ok || res.result === 'duplicate';
    if (accepted) {
      this.log.info(`*** BLOCK ACCEPTED at height ${job.height}! coinbase txid ${job.cbTxidDisplay} ***`);
    } else {
      this.log.error(`*** BLOCK REJECTED by daemon: ${JSON.stringify(res.result)} (height ${job.height}) — ` +
        'this indicates a serialization/template problem, please report it ***');
    }
    this.emit('block', {
      height: job.height,
      worker: session.workerName,
      cbTxid: job.cbTxidDisplay,
      accepted,
      submitResult: res.result,
      rewardSat: job.minerRewardSat,
      shareDiff,
      // Network difficulty at the moment it was found — the denominator for
      // this round's effort. Expected work to find a block is exactly netDiff
      // diff-1 shares, so effort = workDone / netDiff.
      netDiff: job.algo.targetToDiff(job.blockTarget),
      foundAt: Date.now(),
    });
    this.daemon.forcePoll();
  }
}

module.exports = { ShareProcessor };
