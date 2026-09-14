'use strict';
// Counters, rolling sol/s windows, blocks-found registry, reject histogram,
// and atomic JSON persistence. Live windows are in-memory only; persisted
// state is lifetime counters + the blocks registry.

const fs = require('fs');
const path = require('path');
const util = require('./util');

const SHARE_WINDOW_SEC = 3600;
const MAX_BLOCKS = 200;
const MAX_REJECT_REASONS = 50;

// A block's round expressed as a fraction of one expected block, which is the
// only quantity effort can be built from. Prefers the per-share weighted figure;
// falls back to work/netDiff for blocks recorded before that existed, and
// returns null for ones with neither so they are skipped rather than counted
// as free wins.
function blockEffort(b) {
  if (!b) return null;
  if (Number.isFinite(b.effort) && b.effort > 0) return b.effort;
  if (Number.isFinite(b.work) && b.work > 0 && Number.isFinite(b.netDiff) && b.netDiff > 0) {
    return b.work / b.netDiff;
  }
  return null;
}

// Collapse variable parts so each failure mode is one histogram bucket.
function normalizeReason(code, reason) {
  let text = String(reason || 'unknown');
  if (text.startsWith('low difficulty share')) text = 'low difficulty share';
  return `${code}: ${text.slice(0, 60)}`;
}

class Stats {
  // opts: { dataDir, historySamples, sampleMs?, now?, solsPerDiff1?, fileTag? }
  //   solsPerDiff1 — solutions per diff-1 share on this algo (default: 192/7's)
  //   fileTag      — when several algos share one data dir, names this one's
  //                  files state-<tag>.json / history-<tag>.json. Empty keeps
  //                  the original names, which equihash192 goes on using.
  constructor(opts, log) {
    this.opts = opts;
    this.log = log;
    this.solsPerDiff1 = opts.solsPerDiff1 || util.SOLS_PER_DIFF1;
    this.now = opts.now || (() => Date.now());
    this.startedAt = this.now();
    // roundWork:   raw booked difficulty since the last accepted block. Kept
    //              for display; it is NOT what effort is computed from.
    // roundEffort: the same round expressed as a fraction of a block, summing
    //              bookedDiff / netDiff-at-the-time for every share. Network
    //              difficulty here swings tens of percent inside one round, so
    //              dividing total work by the difficulty at a single instant
    //              gives an essentially arbitrary answer.
    // Both persisted, because a restart mid-round must not reset the clock.
    this.counters = {
      acceptedShares: 0, rejectedShares: 0, blocksFound: 0,
      roundWork: 0, roundEffort: 0, firstStartAt: this.now(),
    };
    this.readOnly = false;
    this._readOnlyWarnedAt = 0;
    this.blocks = [];
    this.shareWindow = [];   // { t, d (booked diff), w (worker) }
    this.rejects = new Map(); // normalized reason -> count
    this.history = [];        // { t, sols, netSols|null, netDiff|null }
    // Bumped whenever `history` changes, so the dashboard can skip re-sending
    // 720 unchanged samples on every 2-second poll. The per-instance nonce is
    // load-bearing: a restart must never mint a seq a stale page already holds,
    // or that page would keep drawing a chart the server has thrown away. A
    // timestamp alone is not enough — two processes can start inside the same
    // millisecond, and an injected clock makes that the norm in tests.
    this._historyTick = 0;
    this._historyNonce = Math.random().toString(36).slice(2, 10);
    this.historySeq = `${this._historyNonce}-0`;
    this.dirty = false;
    const suffix = opts.fileTag ? `-${opts.fileTag}` : '';
    this.statePath = path.join(opts.dataDir, `state${suffix}.json`);
    // Chart history lives in its own file: state.json carries found blocks and
    // is fsync'd on every one of them, and history is disposable by
    // comparison. Keeping them apart keeps ~25 KB of chart off that path.
    this.historyPath = path.join(opts.dataDir, `history${suffix}.json`);
    this._timers = [];
    this._confirming = false;
    this._load();
    this._loadHistory();
  }

  sampleMs() {
    return this.opts.sampleMs || 20000;
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.statePath, 'utf8');
    } catch (err) {
      // ONLY "the file isn't there" means first run. Any other failure —
      // permissions, I/O, a directory in the way — means a state file may well
      // exist and simply be unreadable, and carrying on would let the next
      // save() overwrite it with empty counters. That is how a full block
      // history disappears without a single warning, so refuse to write at all
      // until a human has looked at it.
      if (err.code !== 'ENOENT') {
        this.readOnly = true;
        this.log.error(`cannot read ${this.statePath} (${err.code}: ${err.message}) — ` +
          'REFUSING to overwrite it. Mining continues, but found blocks will not be ' +
          'recorded until this is fixed. Check ownership and permissions on the data dir.');
      }
      return;
    }
    try {
      const state = JSON.parse(raw);
      if (state.counters && typeof state.counters === 'object') Object.assign(this.counters, state.counters);
      if (Array.isArray(state.blocks)) this.blocks = state.blocks;
      this.log.info(`state loaded: ${this.counters.blocksFound} block(s) found, ` +
        `${this.counters.acceptedShares} lifetime accepted shares`);
    } catch {
      const quarantine = `${this.statePath}.corrupt-${this.now()}`;
      try { fs.renameSync(this.statePath, quarantine); } catch { /* keep going */ }
      this.log.error(`state file was corrupt — moved to ${quarantine}, starting fresh`);
    }
  }

  // Atomic write via tmp+rename. fsync is optional: durability matters for
  // found blocks, but fsync on the SMB-hosted data dir blocks the same event
  // loop that verifies shares, so the chart does without it.
  _writeJson(filePath, data, fsync) {
    fs.mkdirSync(this.opts.dataDir, { recursive: true });
    const tmp = filePath + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, data);
      if (fsync) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  }

  save() {
    // Set when the existing state could not be read. Writing now would destroy
    // whatever is actually in that file, so the only safe move is to keep
    // shouting and not touch it. Rate-limited: this runs on a 60 s timer and
    // on every block found.
    if (this.readOnly) {
      const t = this.now();
      if (t - this._readOnlyWarnedAt > 300000) {
        this._readOnlyWarnedAt = t;
        this.log.error(`not saving: ${this.statePath} could not be read at startup, so it ` +
          'is being left alone rather than overwritten. Fix the permissions and restart.');
      }
      return;
    }
    try {
      this._writeJson(
        this.statePath,
        JSON.stringify({ version: 1, counters: this.counters, blocks: this.blocks }, null, 2),
        true
      );
      this.dirty = false;
    } catch (err) {
      this.log.error('failed to save state:', err.message);
    }
  }

  // Compact and un-fsync'd: losing the last sample to a hard crash costs a
  // dot on a graph.
  saveHistory() {
    try {
      this._writeJson(this.historyPath, JSON.stringify({ version: 1, history: this.history }), false);
    } catch (err) {
      this.log.error('failed to save chart history:', err.message);
    }
  }

  // Rebuild every sample rather than trusting the file: the array is
  // published verbatim by /api/stats, so nothing unvetted may enter it.
  _loadHistory() {
    let raw;
    try {
      raw = fs.readFileSync(this.historyPath, 'utf8');
    } catch {
      return; // first run
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log.warn('chart history was corrupt — starting with an empty graph');
      return;
    }
    if (!parsed || !Array.isArray(parsed.history)) return;
    const now = this.now();
    // Bound to the chart's own window; an older sample can never be drawn,
    // and the x-axis is index-based so a stale one would silently stretch it.
    const maxAgeMs = Math.max(this.opts.historySamples, 1) * this.sampleMs();
    const clean = [];
    for (const s of parsed.history) {
      if (!s || typeof s !== 'object') continue;
      if (!Number.isFinite(s.t) || !Number.isFinite(s.sols)) continue;
      if (now - s.t > maxAgeMs) continue;
      if (s.t > now + 60000) continue; // clock stepped backwards
      clean.push({
        t: s.t,
        sols: s.sols,
        netSols: Number.isFinite(s.netSols) ? s.netSols : null,
        netDiff: Number.isFinite(s.netDiff) ? s.netDiff : null,
      });
    }
    clean.sort((a, b) => a.t - b.t);
    this.history = clean;
    this._trimHistory();
    this._bumpHistory();
    if (this.history.length) {
      this.log.info(`chart history restored: ${this.history.length} sample(s)`);
    }
  }

  attach(shares) {
    shares.on('accepted', e => this.recordShare(e));
    shares.on('rejected', e => this.recordReject(e));
    shares.on('block', e => this.registerBlock(e));
  }

  recordShare({ worker, session, bookedDiff, netDiff }) {
    const t = this.now();
    this.counters.acceptedShares++;
    this.counters.roundWork += bookedDiff;
    // Weight the share by the difficulty it was actually mined against: a
    // share worth d at network difficulty D is d/D of an expected block.
    if (Number.isFinite(netDiff) && netDiff > 0) {
      this.counters.roundEffort += bookedDiff / netDiff;
    }
    this.dirty = true;
    // sid identifies the connection. Several rigs may log in under the same
    // worker name, and their rates must not be pooled into each other.
    this.shareWindow.push({ t, d: bookedDiff, w: worker, sid: session ? session.id : undefined });
    this._prune(t);
  }

  recordReject({ code, reason }) {
    this.counters.rejectedShares++;
    this.dirty = true;
    const key = normalizeReason(code, reason);
    if (this.rejects.has(key) || this.rejects.size < MAX_REJECT_REASONS) {
      this.rejects.set(key, (this.rejects.get(key) || 0) + 1);
    }
  }

  registerBlock(e) {
    if (this.blocks.some(b => b.height === e.height && b.cbTxid === e.cbTxid)) return;
    this.blocks.unshift({
      height: e.height,
      cbTxid: e.cbTxid,
      worker: e.worker,
      foundAt: e.foundAt,
      rewardSat: e.rewardSat,
      shareDiff: e.shareDiff,
      status: e.accepted ? 'pending' : 'rejected',
      submitResult: e.submitResult === null || e.submitResult === undefined ? null : String(e.submitResult),
      confirmations: 0,
      hash: null,
      // Effort inputs. effort is the real one — the round summed as a fraction
      // of a block, share by share, at the difficulty each share faced. work
      // and netDiff are kept alongside it for display and for diagnosing a
      // round after the fact.
      effort: Math.round(this.counters.roundEffort * 1e6) / 1e6,
      work: Math.round(this.counters.roundWork * 1000) / 1000,
      netDiff: Number.isFinite(e.netDiff) && e.netDiff > 0 ? e.netDiff : null,
    });
    if (this.blocks.length > MAX_BLOCKS) this.blocks.pop();
    if (e.accepted) {
      this.counters.blocksFound++;
      // Only an accepted block ends the round. A daemon-rejected submission
      // found nothing, so that work still counts toward the next one.
      this.counters.roundWork = 0;
      this.counters.roundEffort = 0;
    }
    this.save(); // a found block is never lost to a crash
  }

  // Average effort per block: actual work / expected work, where 1 is exactly
  // the odds and LOWER is better (0.5 = the block cost half what it should).
  //
  // A plain mean is correct here, and that is the whole reason effort is the
  // better metric to report: every block costs exactly one expected block, so
  // the denominators are all 1 and sum(effort)/n IS total-actual over
  // total-expected. Luck, being a ratio of ratios, cannot be averaged that way
  // — the mean of per-block luck would let a 30-second round outweigh an
  // hour-long one.
  avgEffort(lastN) {
    let total = 0;
    let n = 0;
    for (const b of this.blocks) {
      if (b.status === 'rejected') continue;
      const e = blockEffort(b);
      if (e === null) continue;
      total += e;
      n++;
      if (lastN && n >= lastN) break;
    }
    return n > 0 ? { effort: total / n, blocks: n } : null;
  }

  // The current round as a fraction of one block's expected work. 0.5 =
  // halfway to average. Needs no difficulty argument: each share was already
  // weighted against the difficulty it faced as it arrived.
  roundEffort() {
    return this.counters.roundEffort;
  }

  _prune(t) {
    const cutoff = t - SHARE_WINDOW_SEC * 1000;
    let drop = 0;
    while (drop < this.shareWindow.length && this.shareWindow[drop].t < cutoff) drop++;
    if (drop > 0) this.shareWindow.splice(0, drop);
  }

  // Seconds of history actually available in the window. sinceMs narrows it
  // for a subject younger than the pool (e.g. a worker that just connected),
  // so a fresh miner is not averaged against time it was not present for.
  _elapsedSec(t, windowSec, sinceMs) {
    const start = Math.max(this.startedAt, sinceMs || 0);
    return Math.max(30, Math.min(windowSec, (t - start) / 1000));
  }

  // Total booked difficulty and share count in the window, over shares
  // accepted by `match` (null = all).
  _accumulate(t, windowSec, match) {
    const cutoff = t - windowSec * 1000;
    let sum = 0;
    let count = 0;
    for (const s of this.shareWindow) {
      if (s.t >= cutoff && (!match || match(s))) { sum += s.d; count++; }
    }
    return { sum, count };
  }

  // Estimated sol/s over the window: sum of booked difficulties x sols-per-
  // diff1-share / elapsed. Elapsed is clamped for warm-up honesty.
  // Filtering by `worker` aggregates every connection using that name.
  solsRate(windowSec, worker, sinceMs) {
    const t = this.now();
    this._prune(t);
    const { sum } = this._accumulate(t, windowSec, worker === undefined ? null : s => s.w === worker);
    return (sum * this.solsPerDiff1) / this._elapsedSec(t, windowSec, sinceMs);
  }

  // Accepted shares per minute over the window. With vardiff working this
  // should sit near 60 / vardiff.targetTime (4/min at the default 15 s), which
  // makes it a quick read on whether a miner's difficulty has settled.
  sharesPerMin(windowSec, worker, sinceMs) {
    const t = this.now();
    this._prune(t);
    const { count } = this._accumulate(t, windowSec, worker === undefined ? null : s => s.w === worker);
    return (count * 60) / this._elapsedSec(t, windowSec, sinceMs);
  }

  // Rates for ONE connection. This is what the per-worker dashboard rows use:
  // several rigs sharing a worker name are distinct sessions, and pooling them
  // would show each row the sum of all of them.
  sessionRates(windowSec, sessionId, sinceMs) {
    const t = this.now();
    this._prune(t);
    const { sum, count } = this._accumulate(t, windowSec, s => s.sid === sessionId);
    const elapsed = this._elapsedSec(t, windowSec, sinceMs);
    return {
      sols: (sum * this.solsPerDiff1) / elapsed,
      sharesPerMin: (count * 60) / elapsed,
    };
  }

  isWarmingUp(windowSec) {
    return (this.now() - this.startedAt) / 1000 < windowSec;
  }

  // One chart sample. netDiff is the current network difficulty, or null when
  // no template is available — that gap is preserved rather than recorded as
  // zero, which would draw a false crash to the chart floor.
  // Deliberately does NOT set this.dirty: nothing here belongs to state.json,
  // and marking it would turn the conditional 60 s save into an unconditional
  // fsync'd write of the whole block registry, forever.
  recordSample(netDiff) {
    const diff = Number.isFinite(netDiff) && netDiff > 0 ? netDiff : null;
    const netSols = util.netSolsFromDiff(diff, this.solsPerDiff1);
    this.history.push({
      t: this.now(),
      sols: Math.round(this.solsRate(300) * 100) / 100,
      netSols: netSols === null ? null : Math.round(netSols * 10) / 10,
      netDiff: diff === null ? null : Math.round(diff * 1000) / 1000,
    });
    this._trimHistory();
    this._bumpHistory();
  }

  _bumpHistory() {
    this.historySeq = `${this._historyNonce}-${++this._historyTick}`;
  }

  // splice, not a single shift: a restored file (or a lowered historySamples)
  // can leave the array more than one sample over the cap.
  _trimHistory() {
    const cap = Math.max(1, this.opts.historySamples);
    if (this.history.length > cap) this.history.splice(0, this.history.length - cap);
  }

  // netDiffSource: () => number|null, called once per sample. Injected rather
  // than handing Stats the stratum server, which would drag a live TCP
  // listener into every stats unit test.
  start(daemon, netDiffSource) {
    const t1 = setInterval(() => {
      let netDiff = null;
      try {
        if (netDiffSource) netDiff = netDiffSource();
      } catch (err) {
        this.log.debug('network difficulty source threw:', err.message);
      }
      this.recordSample(netDiff);
      this.saveHistory();
    }, this.sampleMs());
    const t2 = setInterval(() => { if (this.dirty) this.save(); }, 60000);
    const t3 = setInterval(() => { this._confirmSweep(daemon); }, 30000);
    this._timers = [t1, t2, t3];
    for (const t of this._timers) if (t.unref) t.unref();
  }

  stop() {
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    this.save();
    this.saveHistory();
  }

  async _confirmSweep(daemon) {
    if (this._confirming || !daemon) return;
    this._confirming = true;
    try {
      for (const b of this.blocks) {
        if (b.status === 'rejected' || b.status === 'orphaned') continue;
        if (b.status === 'confirmed' && b.confirmations >= 100) continue;
        let res;
        try {
          res = await daemon.classifyBlock(b.height, b.cbTxid);
        } catch {
          break; // daemon unavailable — retry next sweep
        }
        const prevStatus = b.status;
        if (res.status !== b.status || res.confirmations !== b.confirmations) this.dirty = true;
        b.status = res.status;
        b.confirmations = res.confirmations;
        if (res.hash) b.hash = res.hash;
        if (prevStatus !== 'confirmed' && b.status === 'confirmed') {
          this.log.info(`block ${b.height} confirmed on-chain (${b.confirmations} confirmations)`);
        }
        if (prevStatus !== 'orphaned' && b.status === 'orphaned') {
          this.log.warn(`block ${b.height} was orphaned`);
        }
      }
      if (this.dirty) this.save();
    } finally {
      this._confirming = false;
    }
  }
}

module.exports = { Stats, normalizeReason, blockEffort };
