'use strict';
// Notification POLICY: which events fire, when, and what they say.
// The transport is stubbed — lib/notify.js is tested separately — so these
// drive the sweep by hand against a fake clock instead of waiting on timers.

const EventEmitter = require('events');
const { assert, assertEq } = require('./t');
const logLib = require('../lib/log');
const { createAlerts, fmtDur } = require('../lib/alerts');
const algos = require('../lib/algos');

logLib.setLevel('error');
const quietLog = logLib.make('test-alerts');

function fakeNotifier() {
  const sent = [];
  return { enabled: true, sent, send(m) { sent.push(m); return Promise.resolve(true); } };
}

// A stand-in for the pieces alerts reads: a session set, daemon state, stats.
function harness(opts) {
  const clock = { t: 1_000_000 };
  const notifier = fakeNotifier();
  const stratum = { sessions: new Set() };
  const daemon = { state: { up: true, statusText: 'ok', height: 122389 } };
  const stats = { readOnly: false, blocks: [], counters: { blocksFound: 3, roundEffort: 0.42 } };
  const shares = new EventEmitter();
  const alerts = createAlerts(notifier, Object.assign({
    events: {}, workerOfflineSec: 30, sweepMs: 0, now: () => clock.t,
  }, opts || {}), quietLog);
  alerts.attach({ shares, stratum, daemon, stats });
  const connect = (name, remote) => {
    const s = { authorized: true, workerName: name, remote: remote || '10.0.0.9' };
    stratum.sessions.add(s);
    return s;
  };
  return { clock, notifier, stratum, daemon, stats, shares, alerts, connect,
    tick: ms => { clock.t += ms; alerts._sweep(); } };
}

// Two algos: two share pipelines and two stratum ports feeding ONE alerts.
function harness2(opts) {
  const clock = { t: 1_000_000 };
  const notifier = fakeNotifier();
  const pipe = key => ({
    algo: algos.get(key),
    shares: new EventEmitter(),
    stratum: { sessions: new Set() },
    stats: { readOnly: false, blocks: [], counters: { blocksFound: 0, roundEffort: 0 } },
  });
  const p192 = pipe('equihash192');
  const p200 = pipe('equihash200');
  const daemon = { state: { up: true, statusText: 'ok', height: 142781 } };
  const alerts = createAlerts(notifier, Object.assign({
    events: {}, workerOfflineSec: 30, sweepMs: 0, now: () => clock.t,
  }, opts || {}), quietLog);
  alerts.attach({ daemon, pipelines: [p192, p200] });
  const connect = (p, name) => {
    const s = { authorized: true, workerName: name, remote: '10.0.0.9' };
    p.stratum.sessions.add(s);
    return s;
  };
  return { clock, notifier, p192, p200, alerts, connect, tick: ms => { clock.t += ms; alerts._sweep(); } };
}

const tests = [
  {
    name: 'a worker back inside the grace period is never mentioned',
    fn() {
      const h = harness();
      const s = h.connect('kritchRig');
      h.tick(1000);
      h.stratum.sessions.delete(s);        // drops...
      h.tick(11000);                       // ...for 11s, like the real 11:35 blip
      h.connect('kritchRig');
      h.tick(1000);
      assertEq(h.notifier.sent.length, 0, 'a short flap is not worth a push');
    },
  },
  {
    name: 'a worker gone past the threshold fires exactly one alert, not one per sweep',
    fn() {
      const h = harness();
      const s = h.connect('rig03', '5.42.102.4');
      h.tick(1000);
      h.stratum.sessions.delete(s);
      h.tick(20000);
      assertEq(h.notifier.sent.length, 0, 'still inside the grace period');
      h.tick(15000);                       // now 35s gone
      assertEq(h.notifier.sent.length, 1);
      assert(/rig03/.test(h.notifier.sent[0].title), h.notifier.sent[0].title);
      assert(/5\.42\.102\.4/.test(h.notifier.sent[0].message), 'says which address');
      h.tick(60000); h.tick(60000);
      assertEq(h.notifier.sent.length, 1, 'does not re-alert every sweep');
    },
  },
  {
    name: 'three rigs dropping together coalesce into ONE message',
    fn() {
      // This is the 11:25 incident from the live log: one uplink hiccup, three
      // rigs gone. Three separate pushes would be noise.
      const h = harness();
      const a = h.connect('rig03'), b = h.connect('kritchRig'), c = h.connect('rigclore3060ti');
      h.tick(1000);
      h.stratum.sessions.delete(a); h.stratum.sessions.delete(b); h.stratum.sessions.delete(c);
      h.tick(35000);
      assertEq(h.notifier.sent.length, 1, 'one message, not three');
      assertEq(h.notifier.sent[0].title, '3 workers are offline');
      for (const name of ['rig03', 'kritchRig', 'rigclore3060ti']) {
        assert(h.notifier.sent[0].message.includes(name), `${name} listed`);
      }
    },
  },
  {
    name: 'back-online is only sent for a worker that was actually reported offline',
    fn() {
      const h = harness();
      const s = h.connect('rig03');
      h.tick(1000);
      h.stratum.sessions.delete(s);
      h.tick(35000);                       // offline alert
      h.connect('rig03');
      h.tick(1000);                        // recovery alert
      assertEq(h.notifier.sent.length, 2);
      assert(/back online/.test(h.notifier.sent[1].title), h.notifier.sent[1].title);
      assert(/Offline for/.test(h.notifier.sent[1].message), 'says how long it was gone');

      // A flap that never crossed the threshold produces no pair at all.
      const h2 = harness();
      const s2 = h2.connect('rig03');
      h2.tick(1000); h2.stratum.sessions.delete(s2); h2.tick(5000); h2.connect('rig03'); h2.tick(1000);
      assertEq(h2.notifier.sent.length, 0);
    },
  },
  {
    name: 'a name with several sessions is offline only when the LAST one goes',
    fn() {
      const h = harness();
      const a = h.connect('rig03', '1.1.1.1');
      const b = h.connect('rig03', '2.2.2.2');   // same name, second rig
      h.tick(1000);
      h.stratum.sessions.delete(a);
      h.tick(40000);
      assertEq(h.notifier.sent.length, 0, 'still one session under that name');
      h.stratum.sessions.delete(b);
      h.tick(40000);
      assertEq(h.notifier.sent.length, 1, 'now genuinely gone');
    },
  },
  {
    name: 'workers connected at startup are not reported as having just gone offline',
    fn() {
      const h = harness();
      h.connect('rig03');
      h.tick(40000);
      assertEq(h.notifier.sent.length, 0);
    },
  },
  {
    name: 'block found carries worker, reward, effort and network difficulty',
    fn() {
      const h = harness();
      h.stats.blocks.push({ height: 122389, cbTxid: 'cb1', effort: 0.63 });
      h.shares.emit('block', {
        height: 122389, cbTxid: 'cb1', worker: 'rigclore3060ti', accepted: true,
        rewardSat: 5e8, netDiff: 48431.2, submitResult: null,
      });
      assertEq(h.notifier.sent.length, 1);
      const m = h.notifier.sent[0];
      assertEq(m.title, 'Block found — height 122,389');
      assert(/rigclore3060ti/.test(m.message), m.message);
      assert(/5 KRGN/.test(m.message), m.message);
      assert(/effort 63%/.test(m.message), m.message);
      assert(/48,431/.test(m.message), m.message);
    },
  },
  {
    name: 'block effort is read from the stored record, not the counter it resets',
    fn() {
      // registerBlock zeroes roundEffort, so reading the live counter would
      // report every block as 0% depending on listener order.
      const h = harness();
      h.stats.counters.roundEffort = 0;                            // already reset
      h.stats.blocks.push({ height: 500, cbTxid: 'cbX', effort: 1.75 });
      h.shares.emit('block', { height: 500, cbTxid: 'cbX', worker: 'w', accepted: true, rewardSat: 5e8, netDiff: 1000 });
      assert(/effort 175%/.test(h.notifier.sent[0].message), h.notifier.sent[0].message);
    },
  },
  {
    name: 'a daemon-rejected block is high priority and quotes the reject string',
    fn() {
      const h = harness();
      h.shares.emit('block', {
        height: 122390, cbTxid: 'cb2', worker: 'rig03', accepted: false,
        rewardSat: 5e8, netDiff: 1000, submitResult: 'bad-txnmrklroot',
      });
      assertEq(h.notifier.sent.length, 1);
      assertEq(h.notifier.sent[0].priority, 1);
      assert(/REJECTED/.test(h.notifier.sent[0].title), h.notifier.sent[0].title);
      assert(/bad-txnmrklroot/.test(h.notifier.sent[0].message), h.notifier.sent[0].message);
    },
  },
  {
    name: 'node down waits out the grace period, then alerts once, then reports recovery',
    fn() {
      const h = harness();
      h.tick(1000);
      h.daemon.state.up = false;
      h.daemon.state.statusText = 'ECONNREFUSED connecting to 127.0.0.1:7121';
      // The clock starts at the first sweep that OBSERVES the outage, which in
      // production is within one sweep interval of the real thing.
      h.tick(10000);
      assertEq(h.notifier.sent.length, 0, 'a single failed poll is not an outage');
      h.tick(20000);
      assertEq(h.notifier.sent.length, 0, '20s down is still inside the grace period');
      h.tick(15000);
      assertEq(h.notifier.sent.length, 1, '35s down crosses it');
      assertEq(h.notifier.sent[0].priority, 1);
      assert(/ECONNREFUSED/.test(h.notifier.sent[0].message), h.notifier.sent[0].message);
      h.tick(30000);
      assertEq(h.notifier.sent.length, 1, 'no repeat while it stays down');

      h.daemon.state.up = true;
      h.tick(1000);
      assertEq(h.notifier.sent.length, 2);
      assert(/back online/.test(h.notifier.sent[1].title), h.notifier.sent[1].title);
    },
  },
  {
    name: 'the rig grace and the node grace are independent',
    fn() {
      // A rig flapping is an annoyance; the node being gone stops all mining,
      // so they get separate patience settings.
      const h = harness({ workerOfflineSec: 300, nodeDownSec: 30 });
      const s = h.connect('rig03');
      h.tick(1000);
      h.stratum.sessions.delete(s);
      h.daemon.state.up = false;
      h.tick(1000);            // both clocks start here
      h.tick(60000);           // 60s: past the node's 30s, well inside the rig's 300s
      assertEq(h.notifier.sent.length, 1, 'only the node alerted');
      assert(/Node unreachable/.test(h.notifier.sent[0].title), h.notifier.sent[0].title);
      h.tick(260000);          // now past 300s for the rig too
      assertEq(h.notifier.sent.length, 2);
      assert(/rig03/.test(h.notifier.sent[1].title), h.notifier.sent[1].title);
    },
  },
  {
    name: 'nodeDownSec falls back to the rig grace when it is not configured',
    fn() {
      // Older configs have only workerOfflineSec; the node must not end up on
      // a 30-second default the operator never asked for.
      const h = harness({ workerOfflineSec: 120 });   // no nodeDownSec
      h.tick(1000);
      h.daemon.state.up = false;
      h.tick(1000);
      h.tick(60000);
      assertEq(h.notifier.sent.length, 0, '60s is inside the inherited 120s grace');
      h.tick(65000);
      assertEq(h.notifier.sent.length, 1);
    },
  },
  {
    name: 'unreadable state file alerts once per process, not once per sweep',
    fn() {
      const h = harness();
      h.stats.readOnly = true;
      h.tick(1000);
      h.tick(1000);
      h.tick(1000);
      assertEq(h.notifier.sent.length, 1);
      assertEq(h.notifier.sent[0].priority, 1);
      assert(/not being recorded/.test(h.notifier.sent[0].title), h.notifier.sent[0].title);
    },
  },
  {
    name: 'events switched off in config produce nothing',
    fn() {
      const h = harness({ events: { blockFound: false, workerOffline: false } });
      const s = h.connect('rig03');
      h.tick(1000); h.stratum.sessions.delete(s); h.tick(40000);
      h.stats.blocks.push({ height: 1, cbTxid: 'c', effort: 1 });
      h.shares.emit('block', { height: 1, cbTxid: 'c', worker: 'w', accepted: true, rewardSat: 5e8, netDiff: 1 });
      assertEq(h.notifier.sent.length, 0);
    },
  },
  {
    name: 'durations read naturally at every scale',
    fn() {
      assertEq(fmtDur(30), '30s');
      assertEq(fmtDur(240), '4m');
      assertEq(fmtDur(7200), '2.0h');
      assertEq(fmtDur(NaN), '—');
    },
  },
  {
    name: 'two algos: a rig moving from one port to the other is not "offline"',
    fn() {
      const h = harness2();
      const s = h.connect(h.p192, 'rig03');
      h.tick(1000);
      h.p192.stratum.sessions.delete(s);   // leaves the 192/7 port…
      h.connect(h.p200, 'rig03');          // …and turns up on 200/9
      h.tick(60000);
      assertEq(h.notifier.sent.length, 0, 'same rig, different algo');
      h.p200.stratum.sessions.clear();     // now gone from both
      h.tick(35000);
      assertEq(h.notifier.sent.length, 1);
      assert(/rig03/.test(h.notifier.sent[0].title), h.notifier.sent[0].title);
    },
  },
  {
    name: 'two algos: block pushes say which algo, and the total counts both',
    fn() {
      const h = harness2();
      h.p192.stats.counters.blocksFound = 3;
      h.p200.stats.counters.blocksFound = 1;
      h.p200.stats.blocks.push({ height: 142781, cbTxid: 'cb', effort: 0.5 });
      h.p200.shares.emit('block', { height: 142781, cbTxid: 'cb', worker: 'rig', accepted: true, rewardSat: 5e8, netDiff: 19172 });
      assertEq(h.notifier.sent[0].title, 'Block found — height 142,781 (200/9)');
      assert(/effort 50%/.test(h.notifier.sent[0].message), 'effort from the 200/9 record: ' + h.notifier.sent[0].message);
      assert(/4 blocks found in total/.test(h.notifier.sent[0].message), h.notifier.sent[0].message);
      h.p192.shares.emit('block', {
        height: 142782, cbTxid: 'x', worker: 'rig', accepted: false, rewardSat: 5e8, netDiff: 1, submitResult: 'high-hash',
      });
      assertEq(h.notifier.sent[1].title, 'BLOCK REJECTED at height 142782 (192/7)');
    },
  },
  {
    name: 'two algos: an unreadable state file is reported per algo, once each',
    fn() {
      const h = harness2();
      h.p200.stats.readOnly = true;
      h.tick(1000);
      h.tick(1000);
      assertEq(h.notifier.sent.length, 1);
      assert(/\(200\/9\)$/.test(h.notifier.sent[0].title), h.notifier.sent[0].title);
      h.p192.stats.readOnly = true;
      h.tick(1000);
      h.tick(1000);
      assertEq(h.notifier.sent.length, 2, 'the other algo gets its own, once');
    },
  },
];

module.exports = { tests };
