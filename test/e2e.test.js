'use strict';
// Capstone: the REAL server process against the mock daemon, driven by a
// scripted miner over real TCP. The oracle is byte-identity between the
// captured submitblock body and the on-chain mainnet block — no pair of
// compensating serialization bugs can satisfy it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const { assert, assertEq } = require('./t');
const util = require('../lib/util');
const fixtures = require('./fixtures');
const { createMockDaemon } = require('./mock-daemon');
const { FakeMiner } = require('./fake-miner');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise(resolve => {
      const sock = net.connect(port, '127.0.0.1');
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
    });
    if (ok) return;
    await sleep(50);
  }
  throw new Error(`port ${port} never came up`);
}

const tests = [
  {
    name: 'full system: real server process, handshake order, block byte-identity, reject matrix, clean shutdown',
    async fn() {
      const blk = fixtures.parseRealBlock();
      const f = blk.fields;
      const en1 = f.nonce.subarray(0, 4).toString('hex');
      const en2 = f.nonce.subarray(4).toString('hex');
      const nTime = util.u32LEHex(f.nTime);
      const soln = blk.solutionWithPrefix.toString('hex');

      const mock = await createMockDaemon();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratnum-e2e-'));
      const stratumPort = await getFreePort();
      const dashPort = await getFreePort();
      const configPath = path.join(dir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({
        node: { host: '127.0.0.1', port: mock.port, user: 'u', pass: 'p', pollMs: 100 },
        pool: {
          address: 'KTestPayoutAddress1234567890', port: stratumPort,
          bind: '127.0.0.1', startDiff: 8,
        },
        dashboard: { enabled: true, host: '127.0.0.1', port: dashPort },
        data: { dir: './data' },
        log: { level: 'debug' },
      }, null, 2));

      const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), configPath], {
        env: Object.assign({}, process.env, { STRATNUM_FORCE_EN1: en1 }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let childLog = '';
      child.stdout.on('data', c => { childLog += c; });
      child.stderr.on('data', c => { childLog += c; });
      const childExit = new Promise(resolve => child.on('exit', resolve));

      const m = new FakeMiner(stratumPort);
      try {
        await waitForPort(stratumPort, 5000);

        // -- handshake --
        await m.connect();
        const sub = await m.request('mining.subscribe', ['e2e-miner/1.0']);
        assertEq(sub.result[1], en1, 'forced extraNonce1');
        const auth = await m.request('mining.authorize', ['KTestPayoutAddress1234567890.rig1', 'x']);
        assertEq(auth.result, true);
        const n1 = await m.nextNotification(undefined, 3000);
        const n2 = await m.nextNotification(undefined, 3000);
        assert(n1 && n1.method === 'mining.set_target', 'set_target first, got ' + (n1 && n1.method));
        assert(n2 && n2.method === 'mining.notify', 'notify second');
        assertEq(n2.params[1], '00060020', 'version bytes verbatim');
        assertEq(n2.params[8], '192_7');
        assertEq(n2.params[9], 'kerrigan');
        const jobId = n2.params[0];

        // -- the real share, submitted WITHOUT the CompactSize prefix (800 hex) --
        const r1 = await m.request('mining.submit',
          ['KTestPayoutAddress1234567890.rig1', jobId, nTime, en2, soln.slice(6)]);
        assertEq(r1.error, null, 'real share accepted: ' + JSON.stringify(r1.error));
        assertEq(r1.result, true);
        await sleep(150);
        assertEq(mock.state.submits.length, 1, 'block submitted to daemon');
        assertEq(mock.state.submits[0], blk.rawHex, 'submitblock body BYTE-IDENTICAL to the on-chain block');

        // -- duplicate (806-hex form normalizes to the same share) --
        const r2 = await m.request('mining.submit',
          ['KTestPayoutAddress1234567890.rig1', jobId, nTime, en2, soln]);
        assertEq(r2.error[0], 22, 'duplicate');

        // -- mutated solution --
        const mutated = soln.slice(0, 500) + (soln[500] === '0' ? '1' : '0') + soln.slice(501);
        const r3 = await m.request('mining.submit',
          ['KTestPayoutAddress1234567890.rig1', jobId, nTime, en2, mutated]);
        assertEq(r3.error[0], 20);
        assertEq(r3.error[1], 'invalid solution');

        // -- dashboard reflects the block and the worker --
        const statsRes = await httpGet(dashPort, '/api/stats');
        assertEq(statsRes.status, 200);
        const snap = JSON.parse(statsRes.body);
        assertEq(snap.totals.blocksFound, 1);
        assertEq(snap.blocks[0].height, 116370);
        assertEq(snap.pool.minersConnected, 1);
        assertEq(snap.workers[0].name, 'KTestPayoutAddress1234567890.rig1');
        assert(snap.node.up === true, 'node up on dashboard');

        // -- prevhash flip: clean job, old job becomes stale --
        mock.state.template = fixtures.gbtFromRealBlock({
          previousblockhash: 'ab'.repeat(32),
          height: 116371,
          header_hex: undefined,
        });
        const n3 = await m.nextNotification('mining.notify', 3000);
        assert(n3, 'clean notify after prevhash change');
        assertEq(n3.params[7], true, 'cleanJobs on prevhash change');
        // Miners are told to switch, but the superseded job stays recognisable
        // server-side: this exact submission already found the real block, and
        // discarding it for a stale job id is how one gets lost. Here it is a
        // duplicate of the share sent earlier in this test, so 22 proves the
        // job was found and the pipeline ran — not 21, which would mean it
        // never got as far as looking.
        const r4 = await m.request('mining.submit',
          ['KTestPayoutAddress1234567890.rig1', jobId, nTime, en2, soln]);
        assertEq(r4.error[0], 22, 'superseded job is still checked, not discarded');
        const r5 = await m.request('mining.submit',
          ['KTestPayoutAddress1234567890.rig1', 'nosuchjob', nTime, en2, soln]);
        assertEq(r5.error[0], 21, 'a genuinely unknown job id is still 21');

        // -- graceful shutdown persists state --
        child.kill('SIGTERM');
        const code = await Promise.race([childExit, sleep(4000).then(() => 'timeout')]);
        assert(code !== 'timeout', 'server exited on SIGTERM');
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'state.json'), 'utf8'));
        assertEq(state.counters.blocksFound, 1, 'state persisted on shutdown');
        assertEq(state.blocks[0].height, 116370);
      } catch (err) {
        err.message += '\n--- server log tail ---\n' + childLog.split('\n').slice(-25).join('\n');
        throw err;
      } finally {
        m.close();
        if (child.exitCode === null) child.kill('SIGKILL');
        await mock.close();
      }
    },
  },
  {
    name: 'both algos at once: one process, two ports, each replays its real block byte-identically',
    async fn() {
      const s192 = fixtures.realShare('equihash192');
      const s200 = fixtures.realShare('equihash200');
      const mock = await createMockDaemon({
        templates: {
          equihash192: fixtures.gbtFromRealBlock(),
          equihash200: fixtures.gbtFromRealBlock({}, 'equihash200'),
        },
      });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratnum-e2e2-'));
      const port192 = await getFreePort();
      const port200 = await getFreePort();
      const dashPort = await getFreePort();
      const configPath = path.join(dir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({
        node: { host: '127.0.0.1', port: mock.port, user: 'u', pass: 'p', pollMs: 100 },
        pool: {
          address: 'KTestPayoutAddress1234567890', port: port192, bind: '127.0.0.1', startDiff: 8,
          // Only the port: everything else takes the 200/9 defaults.
          equihash200: { port: port200 },
        },
        dashboard: { enabled: true, host: '127.0.0.1', port: dashPort },
        data: { dir: './data' },
        log: { level: 'debug' },
      }, null, 2));

      const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), configPath], {
        env: Object.assign({}, process.env, {
          STRATNUM_FORCE_EN1: `equihash192=${s192.en1},equihash200=${s200.en1}`,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let childLog = '';
      child.stdout.on('data', c => { childLog += c; });
      child.stderr.on('data', c => { childLog += c; });
      const childExit = new Promise(resolve => child.on('exit', resolve));

      const m192 = new FakeMiner(port192);
      const m200 = new FakeMiner(port200);
      const worker = 'KTestPayoutAddress1234567890.rig';
      try {
        await waitForPort(port192, 5000);
        await waitForPort(port200, 5000);
        const hello = async (m, en1) => {
          await m.connect();
          const sub = await m.request('mining.subscribe', ['e2e-miner/1.0']);
          assertEq(sub.result[1], en1, 'forced extraNonce1 for this port');
          assertEq((await m.request('mining.authorize', [worker, 'x'])).result, true);
          const t = await m.nextNotification('mining.set_target', 3000);
          const n = await m.nextNotification('mining.notify', 3000);
          assert(t && n, 'target and job');
          return { target: t.params[0], notify: n.params };
        };
        const j192 = await hello(m192, s192.en1);
        const j200 = await hello(m200, s200.en1);
        assertEq([j192.notify[1], j192.notify[8], j192.notify[9]], ['00060020', '192_7', 'kerrigan']);
        assertEq([j200.notify[1], j200.notify[8], j200.notify[9]], ['00040020', '200_9', 'ZcashPoW']);
        // Each port sets its targets on its own difficulty scale.
        assertEq(j192.target, util.bigIntToHex64(util.diffToTarget(8, util.DIFF1_192)));
        assertEq(j200.target, util.bigIntToHex64(util.diffToTarget(1, util.DIFF1_200)));

        // Crossed wires: a 200/9 solution sent to the 192/7 port is the wrong shape.
        const crossed = await m192.request('mining.submit', [worker, j192.notify[0], s192.nTime, s192.en2, s200.soln]);
        assertEq(crossed.error[1], 'incorrect size of solution');

        const r200 = await m200.request('mining.submit', [worker, j200.notify[0], s200.nTime, s200.en2, s200.soln]);
        assertEq(r200.error, null, '200/9 share accepted: ' + JSON.stringify(r200.error));
        const r192 = await m192.request('mining.submit', [worker, j192.notify[0], s192.nTime, s192.en2, s192.soln]);
        assertEq(r192.error, null, '192/7 share accepted: ' + JSON.stringify(r192.error));
        await sleep(150);
        assertEq(mock.state.submits.length, 2, 'both blocks submitted');
        assert(mock.state.submits.includes(s200.rawHex), '200/9 submitblock BYTE-IDENTICAL to the on-chain block');
        assert(mock.state.submits.includes(s192.rawHex), '192/7 submitblock BYTE-IDENTICAL to the on-chain block');
        const asked = [...new Set(mock.state.gbtRequests.map(g => g.params[0].algo))].sort();
        assertEq(asked, ['equihash192', 'equihash200'], 'each poller asked for its own algo');

        // One dashboard, answering per algo.
        const snap192 = JSON.parse((await httpGet(dashPort, '/api/stats')).body);
        const snap200 = JSON.parse((await httpGet(dashPort, '/api/stats?algo=equihash200')).body);
        assertEq(snap192.algo.key, 'equihash192');
        assertEq(snap200.algo.key, 'equihash200');
        assertEq(snap192.algos.map(a => a.key), ['equihash192', 'equihash200']);
        assertEq(snap192.blocks.map(b => b.height), [116370]);
        assertEq(snap200.blocks.map(b => b.height), [122284]);
        assertEq(snap200.pool.stratumPort, port200);
        assertEq(snap200.pool.minersConnected, 1);

        child.kill('SIGTERM');
        const code = await Promise.race([childExit, sleep(4000).then(() => 'timeout')]);
        assert(code !== 'timeout', 'server exited on SIGTERM');
        // Separate state files, the 192/7 one under its original name.
        const st192 = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'state.json'), 'utf8'));
        const st200 = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'state-equihash200.json'), 'utf8'));
        assertEq(st192.blocks.map(b => b.height), [116370]);
        assertEq(st200.blocks.map(b => b.height), [122284]);
      } catch (err) {
        err.message += '\n--- server log tail ---\n' + childLog.split('\n').slice(-30).join('\n');
        throw err;
      } finally {
        m192.close();
        m200.close();
        if (child.exitCode === null) child.kill('SIGKILL');
        await mock.close();
      }
    },
  },
  {
    name: 'an algo with its own nodePort takes its templates from that port, and only from it',
    async fn() {
      // Two stand-in nodes. The main one would hand a 200/9 poller a 192/7
      // template (its default), so a 200/9 job can only come from the second.
      const main = await createMockDaemon({ templates: { equihash192: fixtures.gbtFromRealBlock() } });
      const second = await createMockDaemon({ template: fixtures.gbtFromRealBlock({}, 'equihash200') });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratnum-e2e3-'));
      const port192 = await getFreePort();
      const port200 = await getFreePort();
      const configPath = path.join(dir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({
        node: { host: '127.0.0.1', port: main.port, user: 'u', pass: 'p', pollMs: 100 },
        pool: {
          address: 'KTestPayoutAddress1234567890', port: port192, bind: '127.0.0.1',
          equihash200: { port: port200, nodePort: second.port },
        },
        dashboard: { enabled: false },
        data: { dir: './data' },
        log: { level: 'debug' },
      }));
      const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let childLog = '';
      child.stdout.on('data', c => { childLog += c; });
      child.stderr.on('data', c => { childLog += c; });
      const m = new FakeMiner(port200);
      try {
        await waitForPort(port200, 5000);
        await m.connect();
        await m.request('mining.subscribe', ['e2e/1.0']);
        await m.request('mining.authorize', ['KTestPayoutAddress1234567890.rig', 'x']);
        const n = await m.nextNotification('mining.notify', 3000);
        assert(n, 'a 200/9 job arrived');
        assertEq(n.params[8], '200_9', 'built from the second node\'s template');
        const asked = r => [...new Set(r.state.gbtRequests.map(g => g.params[0].algo))].sort();
        assertEq(asked(second), ['equihash200'], 'the second node was asked for 200/9 only');
        assertEq(asked(main), ['equihash192'], 'and the main node never was');
        assert(/templates from node port \d+/.test(childLog), 'the startup log says which port');
      } catch (err) {
        err.message += '\n--- server log tail ---\n' + childLog.split('\n').slice(-20).join('\n');
        throw err;
      } finally {
        m.close();
        child.kill('SIGKILL');
        await main.close();
        await second.close();
      }
    },
  },
  {
    name: 'KawPoW in the real server: its own port, a byte-identical block, H/s on the dashboard, its own state file',
    async fn() {
      const s192 = fixtures.realShare('equihash192');
      const kp = fixtures.realShare('kawpow');
      const mock = await createMockDaemon({
        templates: { equihash192: fixtures.gbtFromRealBlock(), kawpow: fixtures.gbtFromRealBlock({}, 'kawpow') },
      });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratnum-e2e-kp-'));
      const port192 = await getFreePort();
      const portKp = await getFreePort();
      const dashPort = await getFreePort();
      const configPath = path.join(dir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({
        node: { host: '127.0.0.1', port: mock.port, user: 'u', pass: 'p', pollMs: 100 },
        pool: {
          address: 'KTestPayoutAddress1234567890', port: port192, bind: '127.0.0.1',
          kawpow: { port: portKp, startDiff: 0.0001, minDiff: 0.0001 },
        },
        dashboard: { enabled: true, host: '127.0.0.1', port: dashPort },
        data: { dir: './data' },
        log: { level: 'info' },
      }));
      const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), configPath], {
        env: Object.assign({}, process.env, {
          STRATNUM_FORCE_EN1: `equihash192=${s192.en1},kawpow=${kp.en1}`,
          STRATNUM_KAWPOW_CACHE_DIR: path.join(os.tmpdir(), 'stratnum-kawpow-cache'),
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let childLog = '';
      child.stdout.on('data', c => { childLog += c; });
      child.stderr.on('data', c => { childLog += c; });
      const childExit = new Promise(resolve => child.on('exit', resolve));
      const m = new FakeMiner(portKp);
      try {
        await waitForPort(portKp, 5000);
        await m.connect();
        const sub = await m.request('mining.subscribe', ['kawpowminer/1.2']);
        assertEq(sub.result[1], kp.en1, 'forced 2-byte extranonce1');
        await m.request('mining.authorize', ['KTestPayoutAddress1234567890.gpu', 'x']);
        const n = await m.nextNotification('mining.notify', 3000);
        assert(n, 'a KawPoW job arrived');
        assertEq(n.params[1], kp.headerHashHex);
        const resp = await m.request('mining.submit',
          ['KTestPayoutAddress1234567890.gpu', n.params[0], '0x' + kp.nonceHex, '0x' + kp.headerHashHex, '0x' + kp.mixHex]);
        assertEq(resp.error, null, 'accepted: ' + JSON.stringify(resp.error));
        await sleep(150);
        assert(mock.state.submits.includes(kp.rawHex), 'submitblock BYTE-IDENTICAL to KawPoW block 122281');
        assertEq([...new Set(mock.state.gbtRequests.map(g => g.params[0].algo))].sort(), ['equihash192', 'kawpow']);

        const snap = JSON.parse((await httpGet(dashPort, '/api/stats?algo=kawpow')).body);
        assertEq([snap.algo.key, snap.algo.unit], ['kawpow', 'H/s']);
        assertEq(snap.algos.map(a => [a.key, a.unit]), [['equihash192', 'Sol/s'], ['kawpow', 'H/s']]);
        assertEq(snap.blocks.map(b => b.height), [122281]);
        assertEq(snap.pool.stratumPort, portKp);

        child.kill('SIGTERM');
        const code = await Promise.race([childExit, sleep(4000).then(() => 'timeout')]);
        assert(code !== 'timeout', 'server exited on SIGTERM');
        const st = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'state-kawpow.json'), 'utf8'));
        assertEq(st.blocks.map(b => b.height), [122281]);
      } catch (err) {
        err.message += '\n--- server log tail ---\n' + childLog.split('\n').slice(-25).join('\n');
        throw err;
      } finally {
        m.close();
        if (child.exitCode === null) child.kill('SIGKILL');
        await mock.close();
      }
    },
  },
  {
    name: 'all four algos in one server: X11 on its own port, the miner\'s block submitted as built, four tabs, its own state file',
    async fn() {
      const mock = await createMockDaemon({
        templates: {
          equihash192: fixtures.gbtFromRealBlock(),
          equihash200: fixtures.gbtFromRealBlock({}, 'equihash200'),
          kawpow: fixtures.gbtFromRealBlock({}, 'kawpow'),
          // Any share is a block, so the one share below must be submitted.
          x11: fixtures.gbtFromRealBlock({ target: 'f'.repeat(64) }, 'x11'),
        },
      });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratnum-e2e-x11-'));
      const [port192, port200, portKp, portX11, dashPort] =
        [await getFreePort(), await getFreePort(), await getFreePort(), await getFreePort(), await getFreePort()];
      const configPath = path.join(dir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({
        node: { host: '127.0.0.1', port: mock.port, user: 'u', pass: 'p', pollMs: 100 },
        pool: {
          address: 'KTestPayoutAddress1234567890', port: port192, bind: '127.0.0.1', coinbaseTag: '/stratnum/',
          equihash200: { port: port200 },
          kawpow: { port: portKp },
          x11: { port: portX11 },
        },
        dashboard: { enabled: true, host: '127.0.0.1', port: dashPort },
        data: { dir: './data' },
        log: { level: 'info' },
      }));
      const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), configPath], {
        env: Object.assign({}, process.env, {
          STRATNUM_FORCE_EN1: 'x11=aabbccdd',
          STRATNUM_KAWPOW_CACHE_DIR: path.join(os.tmpdir(), 'stratnum-kawpow-cache'),
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let childLog = '';
      child.stdout.on('data', c => { childLog += c; });
      child.stderr.on('data', c => { childLog += c; });
      const childExit = new Promise(resolve => child.on('exit', resolve));
      const m = new FakeMiner(portX11);
      try {
        await waitForPort(portX11, 5000);
        await m.connect();
        assertEq((await m.request('mining.configure', [['version-rolling'], {}])).result, { 'version-rolling': false });
        const sub = await m.request('mining.subscribe', ['cgminer/4.11.1']);
        assertEq([sub.result[1], sub.result[2]], ['aabbccdd', 4]);
        await m.request('mining.authorize', ['KTestPayoutAddress1234567890.asic', 'x']);
        const d = await m.nextNotification('mining.set_difficulty', 3000);
        assertEq(d.params, [1024], 'the X11 start difficulty');
        const n = await m.nextNotification('mining.notify', 3000);
        assert(n, 'an X11 job arrived');
        const built = fixtures.x11MinerAssemble(n.params, 'aabbccdd', 'c0ffee00', n.params[7], '7a11ce55');
        const resp = await m.request('mining.submit',
          ['KTestPayoutAddress1234567890.asic', n.params[0], 'c0ffee00', n.params[7], '7a11ce55']);
        assertEq(resp.error, null, 'accepted: ' + JSON.stringify(resp.error));
        await sleep(150);
        assert(mock.state.submits.includes(built.block.toString('hex')), 'submitblock = the block the miner assembled');
        assertEq([...new Set(mock.state.gbtRequests.map(g => g.params[0].algo))].sort(),
          ['equihash192', 'equihash200', 'kawpow', 'x11']);

        const snap = JSON.parse((await httpGet(dashPort, '/api/stats?algo=x11')).body);
        assertEq([snap.algo.key, snap.algo.unit], ['x11', 'H/s']);
        assertEq(snap.algos.map(a => [a.key, a.unit]),
          [['equihash192', 'Sol/s'], ['equihash200', 'Sol/s'], ['kawpow', 'H/s'], ['x11', 'H/s']]);
        assertEq(snap.blocks.map(b => b.height), [122283]);
        assertEq(snap.pool.stratumPort, portX11);

        child.kill('SIGTERM');
        const code = await Promise.race([childExit, sleep(4000).then(() => 'timeout')]);
        assert(code !== 'timeout', 'server exited on SIGTERM');
        const st = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'state-x11.json'), 'utf8'));
        // The confirmation check finds the block by this txid, and on X11 it
        // is the share's own coinbase, not the template's.
        assertEq(st.blocks.map(b => [b.height, b.cbTxid]), [[122283, built.cbTxid]]);
      } catch (err) {
        err.message += '\n--- server log tail ---\n' + childLog.split('\n').slice(-25).join('\n');
        throw err;
      } finally {
        m.close();
        if (child.exitCode === null) child.kill('SIGKILL');
        await mock.close();
      }
    },
  },
];

module.exports = { tests };
