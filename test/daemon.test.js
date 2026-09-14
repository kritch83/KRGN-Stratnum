'use strict';
const { assert, assertEq } = require('./t');
const rpcLib = require('../lib/rpc');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Daemon, pickPublicIp, isPrivateAddr, externalIpFromConf } = require('../lib/daemon');
const logLib = require('../lib/log');
const fixtures = require('./fixtures');
const algos = require('../lib/algos');
const { createMockDaemon } = require('./mock-daemon');

const quietLog = logLib.make('test-daemon');
logLib.setLevel('error');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeDaemon(port, opts) {
  const rpc = rpcLib.createClient({ host: '127.0.0.1', port, user: 'u', pass: 'p', timeoutMs: 2000 });
  const daemon = new Daemon(rpc, Object.assign({
    address: 'KTestAddress',
    pollMs: 15,
    jobRefreshSec: 3600,
    backoffMs: 50,
    connectionsPollMs: 0,
  }, opts || {}), quietLog);
  return { rpc, daemon };
}

const tests = [
  {
    name: 'GBT request carries pooladdress + algo + coinbasetxn capability',
    async fn() {
      const mock = await createMockDaemon();
      const { rpc, daemon } = makeDaemon(mock.port);
      try {
        daemon.start();
        await sleep(60);
        assert(mock.state.gbtRequests.length >= 1, 'gbt called');
        const p = mock.state.gbtRequests[0].params[0];
        assertEq(p.pooladdress, 'KTestAddress');
        assertEq(p.algo, 'equihash192');
        assert(p.capabilities.includes('coinbasetxn'));
        assert(mock.state.gbtRequests[0].auth && mock.state.gbtRequests[0].auth.startsWith('Basic '), 'basic auth sent');
      } finally {
        daemon.stop(); rpc.destroy(); await mock.close();
      }
    },
  },
  {
    name: 'clean template first, refresh on tx change, clean on prevhash change',
    async fn() {
      const mock = await createMockDaemon();
      const { rpc, daemon } = makeDaemon(mock.port);
      const events = [];
      daemon.on('template', (tpl, clean) => events.push({ height: tpl.height, clean }));
      try {
        daemon.start();
        await sleep(60);
        assertEq(events.length, 1, 'single event while template unchanged');
        assertEq(events[0].clean, true, 'first template is clean');

        // tx-set change -> non-clean refresh
        mock.state.template = fixtures.gbtFromRealBlock({ transactions: [] });
        await sleep(60);
        assertEq(events.length, 2);
        assertEq(events[1].clean, false, 'tx change is not clean');

        // prevhash change -> clean
        mock.state.template = fixtures.gbtFromRealBlock({ previousblockhash: 'ab'.repeat(32), height: 116371 });
        await sleep(60);
        assertEq(events.length, 3);
        assertEq(events[2].clean, true, 'prevhash change is clean');
        assertEq(events[2].height, 116371);
        assertEq(daemon.state.up, true);
        assertEq(daemon.state.statusText, 'ok');
      } finally {
        daemon.stop(); rpc.destroy(); await mock.close();
      }
    },
  },
  {
    name: 'periodic non-clean refresh when jobRefreshSec elapses',
    async fn() {
      const mock = await createMockDaemon();
      const { rpc, daemon } = makeDaemon(mock.port, { jobRefreshSec: 0.05 });
      const events = [];
      daemon.on('template', (tpl, clean) => events.push(clean));
      try {
        daemon.start();
        await sleep(200);
        assert(events.length >= 3, `expected several refreshes, got ${events.length}`);
        assertEq(events[0], true, 'first clean');
        assert(events.slice(1).every(c => c === false), 'refreshes are non-clean');
      } finally {
        daemon.stop(); rpc.destroy(); await mock.close();
      }
    },
  },
  {
    name: 'warming-up RPC error becomes status; recovery emits clean template',
    async fn() {
      const mock = await createMockDaemon({ warmupError: { code: -28, message: 'Loading block index...' } });
      const { rpc, daemon } = makeDaemon(mock.port);
      const events = [];
      daemon.on('template', (tpl, clean) => events.push(clean));
      try {
        daemon.start();
        await sleep(60);
        assertEq(daemon.state.up, false);
        assert(daemon.state.statusText.includes('not ready'), daemon.state.statusText);
        assertEq(events.length, 0);

        mock.state.warmupError = null;
        await sleep(80);
        assertEq(daemon.state.up, true);
        assert(events.length >= 1 && events[0] === true, 'recovered with clean template');
      } finally {
        daemon.stop(); rpc.destroy(); await mock.close();
      }
    },
  },
  {
    name: 'unusable template -> templateError, no template event',
    async fn() {
      const bad = fixtures.gbtFromRealBlock();
      bad.version = (bad.version & ~0xf00) | 0x000; // x11 algo nibble
      const mock = await createMockDaemon({ template: bad });
      const { rpc, daemon } = makeDaemon(mock.port);
      const templates = [];
      const errors = [];
      daemon.on('template', () => templates.push(1));
      daemon.on('templateError', r => errors.push(r));
      try {
        daemon.start();
        await sleep(60);
        assertEq(templates.length, 0, 'no template served');
        assert(errors.length >= 1, 'templateError emitted');
        assert(errors[0].includes('not equihash192'), errors[0]);
        assertEq(daemon.state.up, true, 'daemon itself is reachable');
      } finally {
        daemon.stop(); rpc.destroy(); await mock.close();
      }
    },
  },
  {
    name: 'polls never overlap even when the daemon is slower than pollMs',
    async fn() {
      const mock = await createMockDaemon({ delayMs: 50 });
      const { rpc, daemon } = makeDaemon(mock.port, { pollMs: 5 });
      try {
        daemon.start();
        await sleep(250);
        assert(mock.state.gbtRequests.length >= 2, 'multiple polls happened');
        assertEq(mock.state.maxConcurrentGbt, 1, 'no overlap');
      } finally {
        daemon.stop(); rpc.destroy(); await mock.close();
      }
    },
  },
  {
    name: 'notifyNewBlock refreshes the template immediately and is rate-limited',
    async fn() {
      const mock = await createMockDaemon();
      // A deliberately slow poll: without the notification a new template
      // would not be seen for a full second.
      const { rpc, daemon } = makeDaemon(mock.port, { pollMs: 1000 });
      const events = [];
      daemon.on('template', (tpl, clean) => events.push({ height: tpl.height, clean }));
      try {
        daemon.start();
        await sleep(60);
        assertEq(events.length, 1, 'initial template');
        const callsBefore = mock.state.gbtRequests.length;

        // The node mines a block; the notification should pull the new
        // template in far sooner than the next scheduled poll.
        mock.state.template = fixtures.gbtFromRealBlock({ previousblockhash: 'cd'.repeat(32), height: 116371 });
        const t0 = Date.now();
        assertEq(daemon.notifyNewBlock('af99a2f4'.repeat(8)), true, 'notification accepted');
        await sleep(80);
        const elapsed = Date.now() - t0;
        assertEq(events.length, 2, 'new template arrived without waiting for the poll');
        assertEq(events[1].clean, true, 'prevhash change -> clean job');
        assertEq(events[1].height, 116371);
        assert(elapsed < 500, `should be immediate, took ${elapsed}ms`);
        assert(mock.state.gbtRequests.length > callsBefore, 'an extra getblocktemplate was issued');

        // Rate limit: a flood on the notification socket must not become a
        // getblocktemplate flood against the node.
        const flooded = mock.state.gbtRequests.length;
        let accepted = 0;
        for (let i = 0; i < 50; i++) if (daemon.notifyNewBlock('ab')) accepted++;
        assertEq(accepted, 0, '50 rapid notifications all rate-limited');
        await sleep(40);
        assert(mock.state.gbtRequests.length - flooded <= 2, 'node was not hammered');
        assert(daemon.state.lastNotifyAt > 0, 'timestamp recorded for the dashboard');
      } finally {
        daemon.stop(); rpc.destroy(); await mock.close();
      }
    },
  },
  {
    name: 'submitBlock: accepted (null), rejected (string), transport error',
    async fn() {
      const mock = await createMockDaemon();
      const { rpc, daemon } = makeDaemon(mock.port);
      try {
        assertEq(await daemon.submitBlock('00ff'), { ok: true, result: null });
        mock.state.submitResult = 'bad-txnmrklroot';
        const rej = await daemon.submitBlock('00ff');
        assertEq(rej.ok, false);
        assertEq(rej.result, 'bad-txnmrklroot');
        assertEq(mock.state.submits.length, 2);
      } finally {
        daemon.stop(); rpc.destroy(); await mock.close();
      }
      // transport error path (mock closed)
      const { rpc: rpc2, daemon: d2 } = makeDaemon(1, {});
      const res = await d2.submitBlock('00ff');
      assertEq(res.ok, false);
      assert(String(res.result).startsWith('rpc error:'), res.result);
      rpc2.destroy();
    },
  },
  {
    name: 'classifyBlock: pending / confirmed / orphaned',
    async fn() {
      const mock = await createMockDaemon();
      const { rpc, daemon } = makeDaemon(mock.port);
      try {
        mock.state.blockcount = 100;
        assertEq((await daemon.classifyBlock(101, 'aa')).status, 'pending', 'tip below height');

        mock.state.blockcount = 120;
        mock.state.blockhashes[110] = 'deadbeef';
        mock.state.blocks['deadbeef'] = { tx: ['cbtxid', 'other'], confirmations: 11 };
        const conf = await daemon.classifyBlock(110, 'cbtxid');
        assertEq(conf.status, 'confirmed');
        assertEq(conf.confirmations, 11);
        assertEq(conf.hash, 'deadbeef');

        const orph = await daemon.classifyBlock(110, 'nottheone');
        assertEq(orph.status, 'orphaned', 'mismatching coinbase with deep tip');

        mock.state.blockcount = 112; // tip - height < 6
        assertEq((await daemon.classifyBlock(110, 'nottheone')).status, 'pending', 'shallow mismatch stays pending');
      } finally {
        daemon.stop(); rpc.destroy(); await mock.close();
      }
    },
  },
  {
    name: 'health poll fills peers, chain position and masternode sync',
    async fn() {
      const mock = await createMockDaemon();
      const { rpc, daemon } = makeDaemon(mock.port);
      try {
        await daemon._pollHealth();
        assertEq(daemon.state.connections, 57);
        assertEq(daemon.state.connectionsIn, 12);
        assertEq(daemon.state.connectionsOut, 45);
        assertEq(daemon.state.chainBlocks, 116369);
        assertEq(daemon.state.chainHeaders, 116369);
        assertEq(daemon.state.ibd, false);
        assertEq(daemon.state.mnSynced, true);
      } finally {
        daemon.stop(); rpc.destroy(); await mock.close();
      }
    },
  },
  {
    name: 'health poll: each RPC fails independently',
    async fn() {
      const mock = await createMockDaemon();
      const { rpc, daemon } = makeDaemon(mock.port);
      try {
        // getnetworkinfo down: peers unknown, chain info still lands.
        mock.state.networkInfo = null;
        await daemon._pollHealth();
        assertEq(daemon.state.connections, null, 'peers blanked');
        assertEq(daemon.state.chainBlocks, 116369, 'chain unaffected');
        assertEq(daemon.state.mnSynced, true, 'mnsync unaffected');

        // …and the reverse.
        mock.state.networkInfo = { connections: 3, connections_in: 1, connections_out: 2 };
        mock.state.chainInfo = null;
        await daemon._pollHealth();
        assertEq(daemon.state.connections, 3, 'peers recovered');
        assertEq(daemon.state.chainBlocks, null, 'chain blanked');
        assertEq(daemon.state.ibd, null);
      } finally {
        daemon.stop(); rpc.destroy(); await mock.close();
      }
    },
  },
  {
    name: 'health poll: missing mnsync RPC is unknown, not a fault',
    async fn() {
      const mock = await createMockDaemon({ mnSyncStatus: null }); // replies -32601
      const { rpc, daemon } = makeDaemon(mock.port);
      try {
        daemon.state.up = true;
        await daemon._pollHealth();
        assertEq(daemon.state.mnSynced, null, 'unknown rather than false');
        assertEq(daemon.health().level, 'good', 'an absent RPC must not degrade health');
      } finally {
        daemon.stop(); rpc.destroy(); await mock.close();
      }
    },
  },
  {
    name: 'health(): only mining blockers are critical',
    async fn() {
      const { rpc, daemon } = makeDaemon(1);
      // Resets every field it can affect, so cases cannot leak into each other.
      const set = extra => Object.assign(daemon.state, {
        up: true, statusText: 'ok', connections: 57,
        chainBlocks: 100, chainHeaders: 100, ibd: false, mnSynced: true,
      }, extra || {});

      set();
      assertEq(daemon.health().level, 'good');

      // The Node tile prints the transport error; health must not repeat it.
      set({ up: false, statusText: 'ECONNREFUSED connecting to 127.0.0.1:7121' });
      assertEq(daemon.health().level, 'critical', 'daemon down');
      assert(!/ECONNREFUSED/.test(daemon.health().reason), 'reason does not echo the Node tile');

      // Reachable but the template is unusable: no jobs go out, so still red.
      set({ statusText: 'bad template: missing coinbasetxn' });
      assertEq(daemon.health().level, 'critical', 'unusable template');
      assert(/coinbasetxn/.test(daemon.health().reason), daemon.health().reason);

      // Zero peers stops getblocktemplate outright (RPC_CLIENT_NOT_CONNECTED),
      // so it is critical — not a warning.
      set({ connections: 0 });
      assertEq(daemon.health().level, 'critical', 'zero peers');

      set({ ibd: true });
      assertEq(daemon.health().level, 'critical', 'initial block download');

      set({ chainBlocks: 90, chainHeaders: 100 });
      assertEq(daemon.health().level, 'warn', 'behind the tip');
      assertEq(daemon.health().reason, '10 blocks behind');

      // One block behind is just the tip arriving; not worth an alert.
      set({ chainBlocks: 99, chainHeaders: 100 });
      assertEq(daemon.health().level, 'good', 'one block of lag is normal');

      set({ mnSynced: false });
      assertEq(daemon.health().level, 'warn', 'masternode sync incomplete');

      // Unknown peer count must not be mistaken for zero.
      set({ connections: null });
      assertEq(daemon.health().level, 'good', 'unknown peers is not zero peers');

      rpc.destroy();
    },
  },
  {
    name: 'healthChecks(): each item answered on its own, unknown is not a fault',
    async fn() {
      const { rpc, daemon } = makeDaemon(1);
      const set = extra => Object.assign(daemon.state, {
        up: true, statusText: 'ok', connections: 57,
        chainBlocks: 100, chainHeaders: 100, ibd: false, mnSynced: true,
      }, extra || {});
      const by = k => daemon.healthChecks().find(c => c.key === k);

      set();
      assertEq(daemon.healthChecks().map(c => c.key), ['rpc', 'peers', 'sync', 'jobs', 'mnsync'],
        'fixed order — the tile renders these as a row and they must not jump');
      assertEq(daemon.healthChecks().every(c => c.status === 'pass'), true);

      set({ up: false });
      assertEq(by('rpc').status, 'fail');
      assertEq(by('jobs').status, 'unknown', 'templates are unknowable, not failed, while the node is down');

      set({ connections: 0 });
      assertEq(by('peers').status, 'fail');
      set({ connections: null });
      assertEq(by('peers').status, 'unknown', 'an unanswered RPC is never read as zero peers');

      set({ ibd: true });
      assertEq(by('sync').status, 'fail');
      set({ chainBlocks: 90, chainHeaders: 100 });
      assertEq(by('sync').status, 'warn');
      assert(/10 blocks behind/.test(by('sync').detail), by('sync').detail);
      set({ chainBlocks: 99, chainHeaders: 100 });
      assertEq(by('sync').status, 'pass', 'one block of lag is just the tip arriving');
      set({ chainHeaders: null });
      assertEq(by('sync').status, 'unknown');

      set({ statusText: 'bad template: missing coinbasetxn' });
      assertEq(by('jobs').status, 'fail');

      set({ mnSynced: false });
      assertEq(by('mnsync').status, 'warn');
      set({ mnSynced: null });
      assertEq(by('mnsync').status, 'unknown', 'a fork without the RPC must not look broken');

      // Every check carries a human-readable detail for the pip tooltip.
      set();
      for (const c of daemon.healthChecks()) assert(c.detail && c.label, `${c.key} has label + detail`);
      rpc.destroy();
    },
  },
  {
    name: 'health() is derived from the checks: worst status wins',
    async fn() {
      const { rpc, daemon } = makeDaemon(1);
      const set = extra => Object.assign(daemon.state, {
        up: true, statusText: 'ok', connections: 57,
        chainBlocks: 100, chainHeaders: 100, ibd: false, mnSynced: true,
      }, extra || {});

      set();
      assertEq(daemon.health().level, 'good');
      set({ mnSynced: false });
      assertEq(daemon.health().level, 'warn');
      // A fail alongside a warn must still read critical.
      set({ mnSynced: false, connections: 0 });
      assertEq(daemon.health().level, 'critical');
      assert(/peers/.test(daemon.health().reason), daemon.health().reason);
      // Unknowns on their own never degrade the verdict.
      set({ connections: null, chainHeaders: null, mnSynced: null });
      assertEq(daemon.health().level, 'good');
      rpc.destroy();
    },
  },
  {
    name: 'public IP: highest score wins, private addresses are skipped',
    fn() {
      // Score IS the precedence rule — a manual `externalip` is added by the
      // node with the highest score, discovery scores lower.
      assertEq(pickPublicIp([
        { address: '10.0.0.20', port: 7120, score: 1 },
        { address: '203.0.113.5', port: 7120, score: 4 },
        { address: '198.51.100.9', port: 7120, score: 2 },
      ]), '203.0.113.5');

      // discover=1 surfaces interface addresses; none of them are the WAN one.
      assertEq(pickPublicIp([
        { address: '10.0.0.20', score: 4 },
        { address: '192.168.1.5', score: 4 },
        { address: '172.16.0.1', score: 4 },
        { address: '127.0.0.1', score: 4 },
        { address: 'fe80::1', score: 4 },
      ]), null, 'all private -> unknown, never a wrong answer');

      assertEq(pickPublicIp([{ address: '172.15.0.1', score: 1 }]), '172.15.0.1',
        'the private block is 172.16-31, not all of 172');
      assertEq(pickPublicIp([{ address: '2001:db8::1', score: 1 }]), '2001:db8::1', 'IPv6 is fine');
      assertEq(pickPublicIp([{ address: 'abcd1234.onion', score: 4 }]), null, 'not reachable as an IP');
      assertEq(pickPublicIp(undefined), null);
      assertEq(pickPublicIp([]), null);
      assert(isPrivateAddr('10.1.2.3') && !isPrivateAddr('8.8.8.8'));
    },
  },
  {
    name: 'the health poll picks the public IP up and keeps it across a blip',
    async fn() {
      const mock = await createMockDaemon({
        networkInfo: {
          connections: 57, connections_in: 12, connections_out: 45, networkactive: true,
          localaddresses: [
            { address: '10.0.0.20', port: 7120, score: 1 },
            { address: '203.0.113.5', port: 7120, score: 4 },
          ],
        },
      });
      const { rpc, daemon } = makeDaemon(mock.port);
      try {
        await daemon._pollHealth();
        assertEq(daemon.state.publicIp, '203.0.113.5');
        // A failed poll must not blank an address we already know.
        mock.state.networkInfo = null;
        await daemon._pollHealth();
        assertEq(daemon.state.connections, null, 'peers really are unknown now');
        assertEq(daemon.state.publicIp, '203.0.113.5', 'but the address is remembered');
      } finally {
        daemon.stop(); rpc.destroy(); await mock.close();
      }
    },
  },
  {
    name: 'externalip is read from kerrigan.conf only as a fallback',
    fn() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratnum-conf-'));
      const p = path.join(dir, 'kerrigan.conf');

      fs.writeFileSync(p, [
        '# a comment',
        'server=1',
        'rpcuser=bob',
        'externalip=203.0.113.77',
        'listen=1',
      ].join('\n'));
      assertEq(externalIpFromConf(p, quietLog), '203.0.113.77');

      fs.writeFileSync(p, '#externalip=1.2.3.4\nserver=1\n');
      assertEq(externalIpFromConf(p, quietLog), null, 'commented out is not set');

      fs.writeFileSync(p, 'externalip = 198.51.100.4 \n');
      assertEq(externalIpFromConf(p, quietLog), '198.51.100.4', 'whitespace tolerated');

      fs.writeFileSync(p, 'externalip=1.1.1.1\nexternalip=2.2.2.2\n');
      assertEq(externalIpFromConf(p, quietLog), '2.2.2.2', 'last wins, as the daemon does');

      assertEq(externalIpFromConf('', quietLog), null, 'unset path is not an error');
      assertEq(externalIpFromConf(path.join(dir, 'nope.conf'), quietLog), null, 'missing file warns, returns null');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: 'a 200/9 poller asks for equihash200 and refuses a 192/7 template',
    async fn() {
      const mock = await createMockDaemon();   // serves the 192/7 template to anyone
      const { rpc, daemon } = makeDaemon(mock.port, { algo: algos.get('equihash200') });
      const templates = [];
      const errors = [];
      daemon.on('template', t => templates.push(t));
      daemon.on('templateError', r => errors.push(r));
      try {
        daemon.start();
        await sleep(60);
        assertEq(mock.state.gbtRequests[0].params[0].algo, 'equihash200');
        assertEq(templates.length, 0, 'the wrong algo is never served');
        assert(errors.length >= 1 && /not equihash200/.test(errors[0]), errors[0]);
        mock.state.template = fixtures.gbtFromRealBlock({}, 'equihash200');
        await sleep(60);
        assertEq(templates.length, 1);
        assertEq(templates[0].height, 122284);
        assertEq(daemon.state.statusText, 'ok');
      } finally {
        daemon.stop(); rpc.destroy(); await mock.close();
      }
    },
  },
  {
    name: 'two pollers on one node each get their own algo\'s template',
    async fn() {
      const mock = await createMockDaemon({
        templates: {
          equihash192: fixtures.gbtFromRealBlock(),
          equihash200: fixtures.gbtFromRealBlock({}, 'equihash200'),
        },
      });
      const a = makeDaemon(mock.port);
      const b = makeDaemon(mock.port, { algo: algos.get('equihash200') });
      const got = { a: [], b: [] };
      a.daemon.on('template', t => got.a.push(t.height));
      b.daemon.on('template', t => got.b.push(t.height));
      try {
        a.daemon.start();
        b.daemon.start();
        await sleep(80);
        assertEq(got.a[0], 116370, '192/7 poller');
        assertEq(got.b[0], 122284, '200/9 poller');
      } finally {
        a.daemon.stop(); b.daemon.stop(); a.rpc.destroy(); b.rpc.destroy(); await mock.close();
      }
    },
  },
  {
    name: 'the Jobs check covers sibling pollers: one algo without usable templates turns it red',
    fn() {
      const main = makeDaemon(1);
      const sib = makeDaemon(1, { algo: algos.get('equihash200') });
      main.daemon.siblings = [sib.daemon];
      Object.assign(main.daemon.state, {
        up: true, statusText: 'ok', connections: 57, chainBlocks: 100, chainHeaders: 100, ibd: false, mnSynced: true,
      });
      const jobs = () => main.daemon.healthChecks().find(c => c.key === 'jobs');

      assertEq(sib.daemon.state.statusText, 'starting');
      assertEq(jobs().status, 'pass', 'a sibling that has not polled yet is not a fault');

      Object.assign(sib.daemon.state, { up: true, statusText: 'bad template: equihash_n=192, expected 200' });
      assertEq(jobs().status, 'fail');
      assert(/^200\/9: bad template/.test(jobs().detail), jobs().detail);
      assertEq(main.daemon.health().level, 'critical');

      // The node answers the first poller, but that algo's own request fails.
      Object.assign(sib.daemon.state, { up: false, statusText: 'RPC error -8: unknown algo' });
      assertEq(jobs().status, 'fail');
      assert(/^200\/9: RPC error -8/.test(jobs().detail), jobs().detail);

      Object.assign(sib.daemon.state, { up: true, statusText: 'ok' });
      assertEq(jobs().status, 'pass');

      // With two algos, even the first poller's own fault says which it is.
      main.daemon.state.statusText = 'bad template: missing coinbasetxn';
      assert(/^192\/7: bad template/.test(jobs().detail), jobs().detail);
      main.rpc.destroy();
      sib.rpc.destroy();
    },
  },
];

module.exports = { tests };
