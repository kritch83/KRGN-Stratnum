'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { assert, assertEq, assertClose } = require('./t');
const logLib = require('../lib/log');
const util = require('../lib/util');
const { Stats, normalizeReason } = require('../lib/stats');

logLib.setLevel('error');
const log = logLib.make('test-stats');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stratnum-test-'));
}

function makeStats(dir, nowRef, extra) {
  return new Stats(Object.assign({
    dataDir: dir,
    historySamples: 5,
    now: nowRef ? () => nowRef.t : undefined,
  }, extra || {}), log);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const tests = [
  {
    name: 'rolling window sol/s math',
    fn() {
      const dir = tmpDir();
      const nowRef = { t: 1_000_000_000_000 };
      const stats = makeStats(dir, nowRef);
      // one diff-10 share every 5s for 10 simulated minutes
      for (let i = 0; i < 120; i++) {
        nowRef.t += 5000;
        stats.recordShare({ worker: 'w1', bookedDiff: 10, shareDiff: 12 });
      }
      // Last 300s hold 61 shares (inclusive cutoff) -> sum 610 -> 610*C/300
      assertClose(stats.solsRate(300), (610 * util.SOLS_PER_DIFF1) / 300, 1e-9, '5m window');
      // Full hour window: 120 shares over 600s elapsed -> 1200*C/600 = 2C
      assertClose(stats.solsRate(3600), 2 * util.SOLS_PER_DIFF1, 0.01, '1h window (elapsed-clamped)');
      // Worker filter
      assertClose(stats.solsRate(300, 'w1'), (610 * util.SOLS_PER_DIFF1) / 300, 1e-9);
      assertEq(stats.solsRate(300, 'other'), 0);
    },
  },
  {
    name: 'warm-up: elapsed floor prevents rate spikes at startup',
    fn() {
      const dir = tmpDir();
      const nowRef = { t: 1_000_000_000_000 };
      const stats = makeStats(dir, nowRef);
      nowRef.t += 1000;
      stats.recordShare({ worker: 'w1', bookedDiff: 100, shareDiff: 100 });
      // 1s elapsed but floor is 30s: rate = 100*C/30, not 100*C/1
      assertClose(stats.solsRate(300), (100 * util.SOLS_PER_DIFF1) / 30, 0.01);
      assert(stats.isWarmingUp(300));
    },
  },
  {
    name: 'save/load round trip preserves counters and blocks',
    fn() {
      const dir = tmpDir();
      const s1 = makeStats(dir);
      s1.recordShare({ worker: 'w1', bookedDiff: 1, shareDiff: 2 });
      s1.registerBlock({
        height: 100, cbTxid: 'aa', worker: 'w1', foundAt: 123,
        rewardSat: 5e8, shareDiff: 50000, accepted: true, submitResult: null,
      });
      s1.save();
      const s2 = makeStats(dir);
      assertEq(s2.counters.acceptedShares, 1);
      assertEq(s2.counters.blocksFound, 1);
      assertEq(s2.blocks.length, 1);
      assertEq(s2.blocks[0].height, 100);
      assertEq(s2.blocks[0].status, 'pending');
    },
  },
  {
    name: 'corrupt state file is quarantined, fresh start',
    fn() {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, 'state.json'), '{ this is not json');
      const stats = makeStats(dir);
      assertEq(stats.counters.acceptedShares, 0);
      const files = fs.readdirSync(dir);
      assert(files.some(f => f.startsWith('state.json.corrupt-')), 'quarantine file exists');
      assert(!files.includes('state.json'), 'corrupt original moved away');
    },
  },
  {
    name: 'leftover .tmp from a killed write is ignored',
    fn() {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, 'state.json.tmp'), 'garbage from a crashed write');
      const stats = makeStats(dir);
      assertEq(stats.counters.acceptedShares, 0, 'tmp never read');
      stats.recordShare({ worker: 'w', bookedDiff: 1, shareDiff: 1 });
      stats.save();
      const s2 = makeStats(dir);
      assertEq(s2.counters.acceptedShares, 1, 'atomic write works with stale tmp present');
    },
  },
  {
    name: 'reject histogram normalizes variable reasons',
    fn() {
      const dir = tmpDir();
      const stats = makeStats(dir);
      stats.recordReject({ worker: 'w', code: 23, reason: 'low difficulty share of 1.23' });
      stats.recordReject({ worker: 'w', code: 23, reason: 'low difficulty share of 99.7' });
      stats.recordReject({ worker: 'w', code: 20, reason: 'invalid solution' });
      assertEq(stats.rejects.get('23: low difficulty share'), 2);
      assertEq(stats.rejects.get('20: invalid solution'), 1);
      assertEq(normalizeReason(23, 'low difficulty share of 5'), '23: low difficulty share');
    },
  },
  {
    name: 'block registry dedupes on (height, cbTxid) and caps rejected blocks',
    fn() {
      const dir = tmpDir();
      const stats = makeStats(dir);
      const evt = {
        height: 100, cbTxid: 'aa', worker: 'w', foundAt: 1,
        rewardSat: 1, shareDiff: 1, accepted: true, submitResult: null,
      };
      stats.registerBlock(evt);
      stats.registerBlock(evt); // submit retry / duplicate result
      assertEq(stats.blocks.length, 1);
      assertEq(stats.counters.blocksFound, 1);
      stats.registerBlock(Object.assign({}, evt, { height: 101, accepted: false, submitResult: 'high-hash' }));
      assertEq(stats.blocks.length, 2);
      assertEq(stats.counters.blocksFound, 1, 'rejected block not counted as found');
      assertEq(stats.blocks[0].status, 'rejected');
      assertEq(stats.blocks[0].submitResult, 'high-hash');
    },
  },
  {
    name: 'confirm sweep drives pending -> confirmed and -> orphaned',
    async fn() {
      const dir = tmpDir();
      const stats = makeStats(dir);
      stats.registerBlock({ height: 100, cbTxid: 'good', worker: 'w', foundAt: 1, rewardSat: 1, shareDiff: 1, accepted: true, submitResult: null });
      stats.registerBlock({ height: 101, cbTxid: 'gone', worker: 'w', foundAt: 2, rewardSat: 1, shareDiff: 1, accepted: true, submitResult: null });
      const daemon = {
        async classifyBlock(height) {
          if (height === 100) return { status: 'confirmed', confirmations: 12, hash: 'h100' };
          return { status: 'orphaned', confirmations: 0, hash: 'h101x' };
        },
      };
      await stats._confirmSweep(daemon);
      const b100 = stats.blocks.find(b => b.height === 100);
      const b101 = stats.blocks.find(b => b.height === 101);
      assertEq(b100.status, 'confirmed');
      assertEq(b100.confirmations, 12);
      assertEq(b100.hash, 'h100');
      assertEq(b101.status, 'orphaned');
      // Orphaned/rejected blocks are left alone on later sweeps.
      let calls = 0;
      await stats._confirmSweep({ async classifyBlock() { calls++; return { status: 'confirmed', confirmations: 13, hash: 'h' }; } });
      assertEq(calls, 1, 'only the confirmed-but-<100-conf block is rechecked');
    },
  },
  {
    name: 'sharesPerMin tracks share cadence, per worker and pool-wide',
    fn() {
      const dir = tmpDir();
      const nowRef = { t: 1_000_000_000_000 };
      const stats = makeStats(dir, nowRef);
      // w1: one share every 15s (the vardiff target -> 4/min)
      // w2: one every 30s (-> 2/min)
      for (let i = 0; i < 40; i++) {
        nowRef.t += 15000;
        stats.recordShare({ worker: 'w1', bookedDiff: 8, shareDiff: 9 });
        if (i % 2 === 0) stats.recordShare({ worker: 'w2', bookedDiff: 8, shareDiff: 9 });
      }
      assertClose(stats.sharesPerMin(300, 'w1'), 4, 0.06, 'w1 near the 15s target');
      assertClose(stats.sharesPerMin(300, 'w2'), 2, 0.06, 'w2 at half cadence');
      assertClose(stats.sharesPerMin(300), 6, 0.06, 'pool-wide is the sum');
      assertEq(stats.sharesPerMin(300, 'nobody'), 0);
    },
  },
  {
    name: 'a freshly connected worker is not averaged against time it missed',
    fn() {
      const dir = tmpDir();
      const nowRef = { t: 1_000_000_000_000 };
      const stats = makeStats(dir, nowRef);
      nowRef.t += 600000; // pool up 10 minutes before this worker arrives
      const joined = nowRef.t;
      for (let i = 0; i < 4; i++) {
        nowRef.t += 15000;
        stats.recordShare({ worker: 'new', bookedDiff: 8, shareDiff: 9 });
      }
      const naive = stats.sharesPerMin(300, 'new');
      const fair = stats.sharesPerMin(300, 'new', joined);
      assert(naive < 1.5, 'unclamped divisor under-reports: ' + naive);
      assertClose(fair, 4, 0.1, 'clamped to the worker lifetime');
      assert(stats.solsRate(300, 'new', joined) > stats.solsRate(300, 'new'), 'sols corrected too');
    },
  },
  {
    name: 'two connections sharing a worker name get independent rates',
    fn() {
      const dir = tmpDir();
      const nowRef = { t: 1_000_000_000_000 };
      const stats = makeStats(dir, nowRef);
      const busy = { id: 1 };   // 4 shares/min
      const slow = { id: 2 };   // 1 share/min
      const solo = { id: 3 };   // different name entirely, 4/min
      for (let i = 0; i < 60; i++) {
        nowRef.t += 15000;
        stats.recordShare({ worker: 'rent2', session: busy, bookedDiff: 10, shareDiff: 11 });
        stats.recordShare({ worker: 'other', session: solo, bookedDiff: 10, shareDiff: 11 });
        if (i % 4 === 0) stats.recordShare({ worker: 'rent2', session: slow, bookedDiff: 10, shareDiff: 11 });
      }
      const b = stats.sessionRates(300, 1);
      const s2 = stats.sessionRates(300, 2);
      assertClose(b.sharesPerMin, 4, 0.08, 'busy session reports its own rate');
      assertClose(s2.sharesPerMin, 1, 0.15, 'slow session is NOT inflated by its namesake');
      assert(b.sharesPerMin > s2.sharesPerMin * 3, 'the two rows differ');
      // name-scoped aggregation still sums them (used by pool-wide views)
      assertClose(stats.sharesPerMin(300, 'rent2'), 5, 0.08, 'by-name is the sum of both');
      assertClose(stats.sessionRates(300, 3).sharesPerMin, 4, 0.08, 'unrelated worker unaffected');
      // sols follow the same split
      assert(b.sols > s2.sols * 3, 'sol/s split per session too');
      assertEq(stats.sessionRates(300, 99).sharesPerMin, 0, 'unknown session');
    },
  },
  {
    name: 'effort accumulates, resets only on an accepted block, and averages across blocks',
    fn() {
      const dir = tmpDir();
      const nowRef = { t: 1_000_000_000_000 };
      const stats = makeStats(dir, nowRef);
      const netDiff = 1000;
      const share = d => stats.recordShare({ worker: 'w', bookedDiff: 10, shareDiff: 10, netDiff: d === undefined ? netDiff : d });
      const block = (height, extra) => Object.assign({
        height, cbTxid: 'cb' + height, worker: 'w', foundAt: nowRef.t,
        rewardSat: 5e8, shareDiff: 1, netDiff, accepted: true, submitResult: null,
      }, extra || {});

      // Half the expected work done so far -> 50% effort, nothing finished yet.
      for (let i = 0; i < 50; i++) share();
      assertEq(stats.counters.roundWork, 500);
      assertClose(stats.roundEffort(), 0.5, 1e-9);
      assertEq(stats.avgEffort(), null, 'no completed rounds yet');

      // A CHEAP block: found at half the expected work -> 50% effort.
      stats.registerBlock(block(1));
      assertEq(stats.counters.roundWork, 0, 'round reset');
      assertClose(stats.counters.roundEffort, 0, 1e-12);
      assertClose(stats.blocks[0].effort, 0.5, 1e-6);
      assertClose(stats.avgEffort().effort, 0.5, 1e-9, 'half a block spent on a block');

      // A daemon-REJECTED submission finds nothing, so the round must continue.
      for (let i = 0; i < 100; i++) share();
      stats.registerBlock(block(2, { accepted: false, submitResult: 'high-hash' }));
      assertEq(stats.counters.roundWork, 1000, 'rejected block does not end the round');
      assertClose(stats.avgEffort().effort, 0.5, 1e-9, 'and is excluded from the average');

      // An EXPENSIVE block: 3x the expected work -> 300% effort.
      for (let i = 0; i < 200; i++) share();
      assertEq(stats.counters.roundWork, 3000);
      stats.registerBlock(block(3));
      // Effort averages with a plain mean, because every block's expected
      // cost is exactly 1: (0.5 + 3.0) / 2 = 1.75.
      assertClose(stats.avgEffort().effort, 3.5 / 2, 1e-6, 'plain mean of per-block effort');

      // Survives a restart mid-round: both counters are persisted.
      for (let i = 0; i < 7; i++) share();
      stats.stop();
      const s2 = makeStats(dir, nowRef);
      assertEq(s2.counters.roundWork, 70, 'effort clock is not reset by a restart');
      assertClose(s2.counters.roundEffort, 0.07, 1e-9);
      assertClose(s2.avgEffort().effort, 3.5 / 2, 1e-6, 'the average survives too');

      // Blocks predating the tracking carry nothing to measure and are skipped.
      s2.blocks.push({ height: 0, cbTxid: 'old', status: 'confirmed', foundAt: 1 });
      assertClose(s2.avgEffort().effort, 3.5 / 2, 1e-6, 'legacy blocks ignored, not counted as zero');
    },
  },
  {
    // The reason effort is accumulated per share rather than divided out at
    // the end: on this chain network difficulty moves tens of percent inside a
    // single round, and the old formula answered with whatever it happened to
    // be at the final instant.
    name: 'a round spanning a difficulty change is weighted per share, not by the closing difficulty',
    fn() {
      const stats = makeStats(tmpDir(), { t: 1_000_000_000_000 });
      // Half a block's worth at difficulty 1000, then half at 4000.
      for (let i = 0; i < 50; i++) stats.recordShare({ worker: 'w', bookedDiff: 10, shareDiff: 10, netDiff: 1000 });
      for (let i = 0; i < 200; i++) stats.recordShare({ worker: 'w', bookedDiff: 10, shareDiff: 10, netDiff: 4000 });
      assertEq(stats.counters.roundWork, 2500, 'raw work is the plain sum');
      assertClose(stats.roundEffort(), 1.0, 1e-9, '0.5 + 0.5 of a block');

      stats.registerBlock({
        height: 9, cbTxid: 'cb9', worker: 'w', foundAt: 1, rewardSat: 5e8,
        shareDiff: 1, netDiff: 4000, accepted: true, submitResult: null,
      });
      // The old maths would read 2500/4000 = 63% effort, i.e. cheaper than it
      // really was. It cost exactly average.
      assertClose(stats.avgEffort().effort, 1.0, 1e-6, 'exactly average, not cheap');
    },
  },
  {
    // How a real block record was lost: an unreadable state file was treated
    // as "first run", and the next save overwrote it with empty counters.
    name: 'state that cannot be read is left alone rather than overwritten',
    fn() {
      const dir = tmpDir();
      const nowRef = { t: 1_000_000_000_000 };
      const s1 = makeStats(dir, nowRef);
      s1.registerBlock({
        height: 500, cbTxid: 'cb500', worker: 'w', foundAt: nowRef.t, rewardSat: 5e8,
        shareDiff: 1, netDiff: 1000, accepted: true, submitResult: null,
      });
      s1.stop();
      const statePath = path.join(dir, 'state.json');
      const good = fs.readFileSync(statePath, 'utf8');

      // Make it unreadable the way a bad chown does. Root ignores the mode, so
      // fall back to a directory in its place — same errno class, same rule.
      let simulated = 'chmod';
      fs.chmodSync(statePath, 0o000);
      try {
        fs.readFileSync(statePath, 'utf8');
        fs.unlinkSync(statePath);
        fs.mkdirSync(statePath);
        simulated = 'EISDIR';
      } catch { /* chmod worked */ }

      const s2 = makeStats(dir, nowRef);
      assertEq(s2.readOnly, true, `unreadable state must set readOnly (via ${simulated})`);
      assertEq(s2.counters.blocksFound, 0, 'it starts empty, as it must');

      // …and must NOT write that empty state over the real one.
      s2.registerBlock({
        height: 501, cbTxid: 'cb501', worker: 'w', foundAt: nowRef.t, rewardSat: 5e8,
        shareDiff: 1, netDiff: 1000, accepted: true, submitResult: null,
      });
      s2.stop();

      if (simulated === 'chmod') {
        fs.chmodSync(statePath, 0o600);
        assertEq(fs.readFileSync(statePath, 'utf8'), good, 'the original survived untouched');
        const s3 = makeStats(dir, nowRef);
        assertEq(s3.readOnly, false, 'recovers once readable again');
        assertEq(s3.blocks[0].height, 500, 'and the block is still there');
      } else {
        assert(fs.statSync(statePath).isDirectory(), 'nothing was written over it');
      }
    },
  },
  {
    name: 'a genuinely absent state file is a normal first run',
    fn() {
      const stats = makeStats(tmpDir(), { t: 1_000_000_000_000 });
      assertEq(stats.readOnly, false, 'ENOENT is not a fault');
      assertEq(stats.counters.blocksFound, 0);
      stats.registerBlock({
        height: 1, cbTxid: 'cb1', worker: 'w', foundAt: 1, rewardSat: 5e8,
        shareDiff: 1, netDiff: 1000, accepted: true, submitResult: null,
      });
      assertEq(stats.blocks.length, 1, 'and it saves normally');
    },
  },
  {
    name: 'recordSample captures both series, and leaves a gap when there is no job',
    fn() {
      const nowRef = { t: 1_000_000_000_000 };
      const stats = makeStats(tmpDir(), nowRef);
      stats.recordShare({ worker: 'w', bookedDiff: 100, shareDiff: 100 });
      nowRef.t += 20000;
      stats.recordSample(46463.476);
      nowRef.t += 20000;
      stats.recordSample(null);

      assertEq(stats.history.length, 2);
      const [a, b] = stats.history;
      assert(a.sols > 0, 'pool series populated');
      assertEq(a.netDiff, 46463.476, 'raw difficulty kept for the tooltip');
      assertClose(a.netSols, util.netSolsFromDiff(46463.476), 0.05, 'network Sol/s');

      // The whole point: a missing template is a hole, never a zero.
      assertEq(b.netSols, null);
      assertEq(b.netDiff, null);
      assert(b.netSols !== 0, 'must not record 0 — that would draw a crash to the floor');
      assertEq(b.t, nowRef.t, 'sample carries its own timestamp');

      // A zero/negative/garbage difficulty is treated as "unknown", not as data.
      for (const bad of [0, -1, NaN, undefined, 'x']) {
        nowRef.t += 20000;
        stats.recordSample(bad);
        assertEq(stats.history[stats.history.length - 1].netSols, null, 'rejects ' + String(bad));
      }
      // recordSample must not dirty state.json — see the comment on the
      // method. (recordShare legitimately does, so clear it first.)
      stats.dirty = false;
      nowRef.t += 20000;
      stats.recordSample(123);
      assertEq(stats.dirty, false, 'chart samples never mark the block registry dirty');
    },
  },
  {
    name: 'history is capped at historySamples, even when it starts over the cap',
    fn() {
      const nowRef = { t: 1_000_000_000_000 };
      const stats = makeStats(tmpDir(), nowRef); // historySamples: 5
      for (let i = 0; i < 12; i++) {
        nowRef.t += 20000;
        stats.recordSample(100 + i);
      }
      assertEq(stats.history.length, 5);
      assertEq(stats.history[4].netDiff, 111, 'newest survived');
      assertEq(stats.history[0].netDiff, 107, 'oldest five dropped');

      // Over-cap by more than one (a restored file, or a lowered config):
      // a single shift() would leave it over the cap forever.
      stats.history = Array.from({ length: 9 }, (_, i) => ({ t: nowRef.t + i, sols: 1, netSols: null, netDiff: null }));
      nowRef.t += 20000;
      stats.recordSample(1);
      assertEq(stats.history.length, 5, 'splice trims all the way down');
    },
  },
  {
    name: 'chart history survives a save/load round trip, separately from state.json',
    fn() {
      const dir = tmpDir();
      // One clock for both instances: the loader prunes samples more than 60s
      // in the future, and the injected clock is decades behind the real one.
      const nowRef = { t: 1_000_000_000_000 };
      const s1 = makeStats(dir, nowRef);
      nowRef.t += 20000;
      s1.recordSample(46463.476);
      nowRef.t += 20000;
      s1.recordSample(null);
      s1.stop(); // must persist BOTH files

      const s2 = makeStats(dir, nowRef);
      assertEq(s2.history.length, 2, 'graph is not empty after a restart');
      assertEq(s2.history[0].netDiff, 46463.476);
      assertClose(s2.history[0].netSols, util.netSolsFromDiff(46463.476), 0.05);
      assertEq(s2.history[1].netSols, null, 'the gap survives too');
      assertEq(s2.history[0].t, 1_000_000_020_000, 'timestamps preserved');

      // state.json must NOT have grown a history key — it is fsync'd on every
      // found block and the chart has no business on that path.
      const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      assertEq('history' in state, false, 'history stays out of state.json');
      assertEq(state.version, 1, 'state.json shape unchanged, no migration needed');
      assert(fs.existsSync(path.join(dir, 'history.json')), 'history.json written');
    },
  },
  {
    name: 'stale, malformed and legacy history samples are dropped or normalized on load',
    fn() {
      const dir = tmpDir();
      const nowRef = { t: 1_000_000_000_000 };
      const maxAgeMs = 5 * 20000; // historySamples x sampleMs defaults = 100 s
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({
        version: 1,
        history: [
          { t: nowRef.t - maxAgeMs - 1, sols: 5, netSols: 1, netDiff: 1 }, // too old
          { t: nowRef.t + 120000, sols: 5, netSols: 1, netDiff: 1 },       // future (clock step)
          { t: nowRef.t - 40000, sols: 'abc' },                            // sols not a number
          null,                                                            // not an object
          'nope',                                                          // not an object
          { sols: 5 },                                                     // no timestamp
          { t: nowRef.t - 30000, sols: 700 },                              // LEGACY: pre-upgrade
          { t: nowRef.t - 10000, sols: 800, shares: 12.5, netSols: 2400, netDiff: 46000, evil: 'x' },
        ],
      }));
      const stats = makeStats(dir, nowRef);

      assertEq(stats.history.length, 2, 'only the two usable samples survive');
      assertEq(stats.history[0].t, nowRef.t - 30000, 'sorted oldest first');
      assertEq(stats.history[0].sols, 700);
      assertEq(stats.history[0].netSols, null, 'legacy sample normalized to a gap');
      assertEq(stats.history[0].netDiff, null);
      assertEq(stats.history[1].netSols, 2400);
      // Rebuilt, not trusted: /api/stats publishes this array.
      assertEq(Object.keys(stats.history[1]).sort(), ['netDiff', 'netSols', 'sols', 't']);
      assert(!('shares' in stats.history[1]), 'a shares field in an old file is dropped, not carried forward');
      assert(!('evil' in stats.history[1]), 'and neither is anything else the file happened to hold');
    },
  },
  {
    name: 'start() feeds the difficulty source into samples and survives one that throws',
    async fn() {
      const dir = tmpDir();
      const stats = makeStats(dir, null, { sampleMs: 5 });
      stats.start(null, () => 42);  // null daemon is safe: _confirmSweep guards it
      await sleep(40);
      stats.stop();
      assert(stats.history.length >= 1, 'the timer sampled');
      assertEq(stats.history[0].netDiff, 42, 'source wired through to the sample');
      assert(fs.existsSync(path.join(dir, 'history.json')), 'sampling persists as it goes');

      const s2 = makeStats(tmpDir(), null, { sampleMs: 5 });
      s2.start(null, () => { throw new Error('daemon exploded'); });
      await sleep(40);
      s2.stop();
      assert(s2.history.length >= 1, 'a throwing source does not kill the sampler');
      assertEq(s2.history[0].netDiff, null, 'and records a gap');
    },
  },
];
module.exports = { tests };
