'use strict';
const { assert, assertEq } = require('./t');
const logLib = require('../lib/log');
const util = require('../lib/util');
const { StratumServer } = require('../lib/stratum');
const { ShareProcessor } = require('../lib/shares');
const { VarDiff } = require('../lib/vardiff');
const { FakeMiner } = require('./fake-miner');
const fixtures = require('./fixtures');
const algos = require('../lib/algos');

logLib.setLevel('error');
const log = logLib.make('test-stratum');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function stubDaemon() {
  return {
    submits: [],
    forcePolled: 0,
    result: { ok: true, result: null },
    async submitBlock(hex) { this.submits.push(hex); return this.result; },
    forcePoll() { this.forcePolled++; },
  };
}

async function startPool(opts, vdOpts) {
  const vardiff = new VarDiff(Object.assign({
    targetTime: 15, retargetTime: 90, variancePercent: 30, minDiff: 0.0001, maxDiff: 1e7,
  }, vdOpts || {}));
  const stratum = new StratumServer(Object.assign({
    port: 0, bind: '127.0.0.1', startDiff: 0.0001, maxConnections: 16, retainJobs: 5, idleCheckMs: 0,
  }, opts || {}), vardiff, log);
  const daemon = stubDaemon();
  const shares = new ShareProcessor(stratum, daemon, { nTimeToleranceSec: 7200 }, log);
  const port = await stratum.listen();
  return { stratum, shares, daemon, port, vardiff };
}

const tests = [
  {
    name: 'handshake: subscribe -> authorize -> set_target strictly before notify',
    async fn() {
      delete process.env.STRATNUM_FORCE_EN1;
      const { stratum, port } = await startPool();
      const m = new FakeMiner(port);
      try {
        stratum.setTemplate(fixtures.gbtFromRealBlock(), true);
        await m.connect();
        const sub = await m.request('mining.subscribe', ['test-miner/1.0']);
        assertEq(sub.error, null);
        assertEq(sub.result[0], null);
        assert(/^[0-9a-f]{8}$/.test(sub.result[1]), 'en1 is 8 hex chars');
        const auth = await m.request('mining.authorize', ['KAddr.rig1', 'x']);
        assertEq(auth.result, true);
        const n1 = await m.nextNotification();
        const n2 = await m.nextNotification();
        assertEq(n1.method, 'mining.set_target', 'target first');
        assert(/^[0-9a-f]{64}$/.test(n1.params[0]), 'full 64-hex target');
        assertEq(n2.method, 'mining.notify');
        assertEq(n2.params.length, 10);
        assertEq(n2.params[1], '00060020', 'version LE verbatim');
        assertEq(n2.params[7], true, 'cleanJobs');
        assertEq(n2.params[8], '192_7');
        assertEq(n2.params[9], 'kerrigan');
      } finally {
        m.close();
        await stratum.close();
      }
    },
  },
  {
    name: 're-subscribe is idempotent; distinct sessions get distinct en1',
    async fn() {
      delete process.env.STRATNUM_FORCE_EN1;
      const { stratum, port } = await startPool();
      const m1 = new FakeMiner(port);
      const m2 = new FakeMiner(port);
      try {
        await m1.connect();
        await m2.connect();
        const a = (await m1.request('mining.subscribe', [])).result[1];
        const b = (await m1.request('mining.subscribe', [])).result[1];
        const c = (await m2.request('mining.subscribe', [])).result[1];
        assertEq(a, b, 'same session same en1');
        assert(a !== c, 'different sessions differ');
      } finally {
        m1.close(); m2.close();
        await stratum.close();
      }
    },
  },
  {
    name: 'framing: fragmented writes, coalesced messages, CRLF endings',
    async fn() {
      const { stratum, port } = await startPool();
      const m = new FakeMiner(port);
      try {
        await m.connect();
        // Fragmented single message
        const line = JSON.stringify({ id: 5, method: 'mining.subscribe', params: [] }) + '\n';
        const resp5 = new Promise(res => m.pending.set(5, res));
        for (let i = 0; i < line.length; i += 7) {
          m.sendRaw(line.slice(i, i + 7));
          await sleep(2);
        }
        assert(/^[0-9a-f]{8}$/.test((await resp5).result[1]), 'fragmented subscribe handled');

        // Two messages in one write, CRLF on the first
        const resp6 = new Promise(res => m.pending.set(6, res));
        const resp7 = new Promise(res => m.pending.set(7, res));
        m.sendRaw('{"id":6,"method":"mining.authorize","params":["w","x"]}\r\n' +
                  '{"id":7,"method":"mining.get_transactions","params":[]}\n');
        assertEq((await resp6).result, true, 'authorize in coalesced write');
        assertEq((await resp7).result, [], 'second message in same write');
      } finally {
        m.close();
        await stratum.close();
      }
    },
  },
  {
    name: 'flood without newline disconnects',
    async fn() {
      const { stratum, port } = await startPool();
      const m = new FakeMiner(port);
      try {
        await m.connect();
        m.sendRaw('a'.repeat(11000));
        assert(await m.waitClose(), 'connection dropped');
      } finally {
        m.close();
        await stratum.close();
      }
    },
  },
  {
    name: 'TLS client hello is detected and disconnected',
    async fn() {
      const { stratum, port } = await startPool();
      const m = new FakeMiner(port);
      try {
        await m.connect();
        m.sendRaw(Buffer.from([0x16, 0x03, 0x01, 0x00, 0xa5]));
        assert(await m.waitClose(), 'connection dropped');
      } finally {
        m.close();
        await stratum.close();
      }
    },
  },
  {
    name: 'malformed JSON: 9 strikes tolerated, 10th disconnects',
    async fn() {
      const { stratum, port } = await startPool();
      const m = new FakeMiner(port);
      try {
        await m.connect();
        for (let i = 0; i < 9; i++) m.sendRaw('this is not json\n');
        await sleep(30);
        const sub = await m.request('mining.subscribe', []);
        assertEq(sub.error, null, 'still alive after 9 bad lines');
        m.sendRaw('still not json\n');
        assert(await m.waitClose(), 'dropped at 10 strikes');
      } finally {
        m.close();
        await stratum.close();
      }
    },
  },
  {
    name: 'state machine: submit -> 25 unsubscribed, 24 unauthorized; unknown method -> 20',
    async fn() {
      const { stratum, port } = await startPool();
      const m = new FakeMiner(port);
      try {
        await m.connect();
        const dummy = ['w', '1', '00000000', '0'.repeat(56), '0'.repeat(806)];
        assertEq((await m.request('mining.submit', dummy)).error[0], 25);
        await m.request('mining.subscribe', []);
        assertEq((await m.request('mining.submit', dummy)).error[0], 24);
        assertEq((await m.request('mining.bogus_method', [])).error[0], 20);
        assertEq((await m.request('mining.extranonce.subscribe', [])).error[0], 20);
        assertEq((await m.request('mining.suggest_difficulty', [1000])).result, true);
      } finally {
        m.close();
        await stratum.close();
      }
    },
  },
  {
    name: 'response id echo preserves numbers and strings',
    async fn() {
      const { stratum, port } = await startPool();
      const m = new FakeMiner(port);
      try {
        await m.connect();
        assertEq((await m.request('mining.subscribe', [], 42)).id, 42);
        assertEq((await m.request('mining.get_transactions', [], 'abc')).id, 'abc');
      } finally {
        m.close();
        await stratum.close();
      }
    },
  },
  {
    name: 'connection cap: third connection is rejected when maxConnections=2',
    async fn() {
      const { stratum, port } = await startPool({ maxConnections: 2 });
      const m1 = new FakeMiner(port);
      const m2 = new FakeMiner(port);
      const m3 = new FakeMiner(port);
      try {
        await m1.connect();
        await m2.connect();
        await m1.request('mining.subscribe', []);
        await m2.request('mining.subscribe', []);
        await m3.connect();
        assert(await m3.waitClose(), 'third connection dropped');
      } finally {
        m1.close(); m2.close(); m3.close();
        await stratum.close();
      }
    },
  },
  {
    name: 'job registry: a clean job retains the previous ones, cap enforced by age',
    async fn() {
      const { stratum } = await startPool({ retainJobs: 3 });
      try {
        const tpl = fixtures.gbtFromRealBlock();
        const j1 = stratum.setTemplate(tpl, true);
        const j2 = stratum.setTemplate(tpl, false);
        assertEq(stratum.jobs.size, 2, 'refresh retains previous');
        assert(stratum.jobs.has(j1.id) && stratum.jobs.has(j2.id));
        stratum.setTemplate(tpl, false);
        stratum.setTemplate(tpl, false);
        stratum.setTemplate(tpl, false);
        assertEq(stratum.jobs.size, 3, 'cap enforced');
        assert(!stratum.jobs.has(j1.id), 'oldest evicted');

        // A clean job must NOT purge the registry. Miners are told to switch
        // (that is what the clean flag on the wire does), but a share already
        // in flight has to stay recognisable — if it turns out to be a block,
        // an unknown job id would throw it away before anything checked it
        // against the block target.
        const prev = [...stratum.jobs.keys()];
        const j6 = stratum.setTemplate(fixtures.gbtFromRealBlock({
          previousblockhash: 'ab'.repeat(32), header_hex: undefined,
        }), true);
        assertEq(stratum.currentJob.id, j6.id, 'current job advances');
        assertEq(stratum.jobs.size, 3, 'still bounded by retainJobs');
        assert(stratum.jobs.has(prev[prev.length - 1]), 'the just-superseded job survives');
      } finally {
        await stratum.close();
      }
    },
  },
  {
    name: 'unusable template does not crash: jobError emitted, jobs unchanged',
    async fn() {
      const { stratum } = await startPool();
      try {
        const errors = [];
        stratum.on('jobError', r => errors.push(r));
        const bad = fixtures.gbtFromRealBlock({ target: 'zz' });
        assertEq(stratum.setTemplate(bad, true), null);
        assertEq(errors.length, 1);
        assertEq(stratum.jobs.size, 0);
      } finally {
        await stratum.close();
      }
    },
  },
  {
    name: 'several ~2.9 KB submits in ONE read are all answered, not mistaken for a flood',
    async fn() {
      const { stratum, port } = await startPool();
      const m = new FakeMiner(port);
      try {
        await m.connect();
        await m.request('mining.subscribe', []);
        await m.request('mining.authorize', ['w', 'x']);
        // Five 200/9-sized submits in a single write: ~14.5 KB together, over
        // the line cap, while no single line comes near it.
        const replies = [];
        const lines = [];
        for (let id = 100; id < 105; id++) {
          replies.push(new Promise(res => m.pending.set(id, res)));
          lines.push(JSON.stringify({
            id, method: 'mining.submit', params: ['w', 'nojob', '00000000', '0'.repeat(56), '0'.repeat(2694)],
          }));
        }
        m.sendRaw(lines.join('\n') + '\n');
        const got = await Promise.race([Promise.all(replies), sleep(2000).then(() => null)]);
        assert(got, 'all five answered');
        assertEq(got.map(r => r.error && r.error[0]), [21, 21, 21, 21, 21], 'each reached the share pipeline');
        assertEq(m.closed, false, 'connection kept');
      } finally {
        m.close();
        await stratum.close();
      }
    },
  },
  {
    name: 'a 200/9 port serves 200/9 jobs on the 200/9 scale, and refuses 192/7 templates',
    async fn() {
      delete process.env.STRATNUM_FORCE_EN1;
      const { stratum, port } = await startPool({ algo: algos.get('equihash200'), startDiff: 2 });
      const m = new FakeMiner(port);
      try {
        stratum.setTemplate(fixtures.gbtFromRealBlock({}, 'equihash200'), true);
        await m.connect();
        await m.request('mining.subscribe', []);
        await m.request('mining.authorize', ['w', 'x']);
        const t = await m.nextNotification('mining.set_target');
        const n = await m.nextNotification('mining.notify');
        assertEq(t.params[0], util.bigIntToHex64(util.diffToTarget(2, util.DIFF1_200)), 'target on the 200/9 scale');
        assertEq(n.params[1], '00040020');
        assertEq(n.params[8], '200_9');
        assertEq(n.params[9], 'ZcashPoW');
        const before = stratum.currentJob;
        assertEq(stratum.setTemplate(fixtures.gbtFromRealBlock(), true), null, 'a 192/7 template builds no job here');
        assert(stratum.currentJob === before, 'and the current job is untouched');
      } finally {
        m.close();
        await stratum.close();
      }
    },
  },
  {
    name: 'STRATNUM_FORCE_EN1 can pin extraNonce1 per algo',
    async fn() {
      process.env.STRATNUM_FORCE_EN1 = 'equihash192=aaaaaaaa,equihash200=bbbbbbbb';
      const a = await startPool();
      const b = await startPool({ algo: algos.get('equihash200') });
      const ma = new FakeMiner(a.port);
      const mb = new FakeMiner(b.port);
      try {
        await ma.connect();
        await mb.connect();
        assertEq((await ma.request('mining.subscribe', [])).result[1], 'aaaaaaaa');
        assertEq((await mb.request('mining.subscribe', [])).result[1], 'bbbbbbbb');
      } finally {
        delete process.env.STRATNUM_FORCE_EN1;
        ma.close();
        mb.close();
        await a.stratum.close();
        await b.stratum.close();
      }
    },
  },
];

module.exports = { tests };
