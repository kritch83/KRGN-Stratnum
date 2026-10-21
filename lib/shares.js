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
const families = require('./families');

// A run this long means the miner is not solving this algo at all — 192/7
// params on the 200/9 port, the wrong personalization, or something that is
// not a miner. Honest rigs do emit the odd invalid solution from GPU noise,
// but never a streak: any solution that verifies clears the count.
// Families whose shares carry no proof beyond their hash (X11, and KawPoW's
// cheap path) say so with `lowDiffCountsAsInvalid`: junk there does not fail
// verification, it misses the target, so for them a miss counts and only an
// accepted share clears the count. Vardiff moves at most once per retarget
// interval and the previous target is still honoured, so an honest rig does
// not miss twenty times running.
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

    // 4-5: shape, ranges and the duplicate key — the family's cheap checks.
    //      Everything is lowercase-normalized there, so a share resent in
    //      uppercase is still recognised as the same share.
    const fam = families.of(job.algo);
    const parsed = fam.parse(job, session, params, this.opts);
    if (parsed.reject) return reject(parsed.reject[0], parsed.reject[1]);
    const { dupKey, work } = parsed;

    // 6: duplicate detection (per job, across sessions), before the expensive
    //    step. `pending` covers a share whose verification is still running —
    //    a family that verifies asynchronously would otherwise let two copies
    //    of one share sent back to back both through.
    if (job.seen.has(dupKey) || job.pending.has(dupKey)) return reject(22, 'duplicate share');

    // 7: verification — the expensive step, and the reason a connection that
    //    never produces a real solution is shown the door instead of being
    //    served forever. Only awaited when the family is asynchronous, so a
    //    synchronous family runs exactly as it always has.
    let vres;
    job.pending.add(dupKey);
    try {
      vres = fam.verify(job, session, work);
      if (vres && typeof vres.then === 'function') vres = await vres;
    } finally {
      job.pending.delete(dupKey);
    }
    if (!vres.ok) {
      session.invalidSolns++;
      session.invalidStreak++;
      if (session.invalidSolns <= 3 || session.invalidSolns % 50 === 0) {
        this.log.warn(`invalid solution from ${session.workerName} (${vres.reason}, #${session.invalidSolns}) — ` +
          `if EVERY share fails, ${vres.hint}`);
      }
      if (session.invalidStreak >= MAX_CONSECUTIVE_INVALID) {
        this.stratum.dropAfterReply(session, `${session.invalidStreak} invalid solutions in a row`);
      }
      return reject(20, 'invalid solution');
    }
    // A solution that verifies means this miner is solving the right thing,
    // whatever this particular share's difficulty turns out to be.
    if (!fam.lowDiffCountsAsInvalid) session.invalidStreak = 0;

    // 8: remember it, so the same work cannot be counted twice. Only shares
    //    that verified get in, so junk can never fill the window.
    job.seen.add(dupKey);
    while (job.seen.size > this.maxSeenPerJob) {
      job.seen.delete(job.seen.values().next().value);   // oldest first
    }

    const hashBN = vres.hashBN;
    // On the job's own algo's scale — the one vardiff and set_target use.
    const shareDiff = Number((job.algo.diff1 * 1000n) / hashBN) / 1000;

    // 9: block check FIRST (a block-worthy hash must never die on share rules)
    let isBlock = false;
    if (hashBN <= job.blockTarget) {
      isBlock = true;
      await this._submitBlock(job, fam.block(job, session, work, vres), session, shareDiff);
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
      if (fam.lowDiffCountsAsInvalid && ++session.invalidStreak >= MAX_CONSECUTIVE_INVALID) {
        this.stratum.dropAfterReply(session, `${session.invalidStreak} shares in a row below the share difficulty`);
      }
      return reject(23, 'low difficulty share of ' + shareDiff);
    }
    session.invalidStreak = 0;

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

  // block: { hex, cbTxid } from the family — the cbTxid travels with the block
  // rather than the job, because a family that varies the coinbase per miner
  // has a different one for every session.
  async _submitBlock(job, block, session, shareDiff) {
    const blockHex = block.hex;
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
      this.log.info(`*** BLOCK ACCEPTED at height ${job.height}! coinbase txid ${block.cbTxid} ***`);
    } else {
      this.log.error(`*** BLOCK REJECTED by daemon: ${JSON.stringify(res.result)} (height ${job.height}) — ` +
        'this indicates a serialization/template problem, please report it ***');
    }
    this.emit('block', {
      height: job.height,
      worker: session.workerName,
      cbTxid: block.cbTxid,
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
