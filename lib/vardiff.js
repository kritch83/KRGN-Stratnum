'use strict';
// Per-session variable difficulty: aims for one share every targetTime
// seconds, retargeting at most once per retargetTime. Clock is injectable
// for tests. All methods mutate the per-session state they are given.

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

class VarDiff {
  // opts: { targetTime, retargetTime, variancePercent, minDiff, maxDiff }
  constructor(opts, now) {
    this.opts = opts;
    this.now = now || (() => Date.now() / 1000);
    const variance = opts.targetTime * (opts.variancePercent / 100);
    this.tMin = opts.targetTime - variance;
    this.tMax = opts.targetTime + variance;
    this.bufSize = Math.max(4, Math.round((opts.retargetTime / opts.targetTime) * 4));
  }

  createSession(startDiff) {
    const t = this.now();
    return {
      difficulty: clamp(startDiff, this.opts.minDiff, this.opts.maxDiff),
      previousDifficulty: null,
      lastShareAt: t,
      // First retarget after half an interval, like the reference pools.
      lastRetargetAt: t - this.opts.retargetTime / 2,
      gaps: [],
    };
  }

  // Called on every accepted share. Returns the new difficulty when a
  // retarget fires, else null.
  onShare(s) {
    const now = this.now();
    s.gaps.push(now - s.lastShareAt);
    if (s.gaps.length > this.bufSize) s.gaps.shift();
    s.lastShareAt = now;
    if (now - s.lastRetargetAt < this.opts.retargetTime) return null;
    s.lastRetargetAt = now;
    const avg = s.gaps.reduce((a, b) => a + b, 0) / s.gaps.length;
    s.gaps = [];
    if (avg >= this.tMin && avg <= this.tMax) return null; // inside the dead band
    const newDiff = clamp(s.difficulty * (this.opts.targetTime / avg), this.opts.minDiff, this.opts.maxDiff);
    if (newDiff === s.difficulty) return null;
    s.previousDifficulty = s.difficulty;
    s.difficulty = newDiff;
    return newDiff;
  }

  // Called periodically for sessions that stopped submitting: halve the
  // difficulty so a rig that started too high can find its level.
  onIdleCheck(s) {
    const now = this.now();
    if (now - s.lastShareAt < Math.max(60, this.opts.targetTime * 5)) return null;
    if (s.difficulty <= this.opts.minDiff) return null;
    s.lastShareAt = now;
    s.lastRetargetAt = now;
    s.gaps = [];
    const newDiff = clamp(s.difficulty / 2, this.opts.minDiff, this.opts.maxDiff);
    if (newDiff === s.difficulty) return null;
    s.previousDifficulty = s.difficulty;
    s.difficulty = newDiff;
    return newDiff;
  }
}

module.exports = { VarDiff };
