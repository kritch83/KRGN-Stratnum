'use strict';
// IPv6 support: dual-stack binding and address display. Skips gracefully on
// hosts without an IPv6 loopback.

const net = require('net');
const http = require('http');
const { assert, assertEq } = require('./t');
const logLib = require('../lib/log');
const { StratumServer, displayAddress } = require('../lib/stratum');
const { VarDiff } = require('../lib/vardiff');
const rpcLib = require('../lib/rpc');

logLib.setLevel('error');
const log = logLib.make('test-ipv6');

function hasIPv6() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(0, '::1', () => srv.close(() => resolve(true)));
  });
}

function subscribe(host, port, family) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port, family });
    let buf = '';
    const done = v => { try { sock.destroy(); } catch {} resolve(v); };
    sock.on('connect', () => sock.write('{"id":1,"method":"mining.subscribe","params":[]}\n'));
    sock.on('data', c => {
      buf += c;
      if (buf.includes('\n')) {
        try { done(JSON.parse(buf.split('\n')[0])); } catch { done(null); }
      }
    });
    sock.on('error', () => done(null));
    setTimeout(() => done(null), 3000);
  });
}

function makeStratum(bind) {
  const vardiff = new VarDiff({ targetTime: 15, retargetTime: 90, variancePercent: 30, minDiff: 0.5, maxDiff: 1e5 });
  return new StratumServer({ port: 0, bind, startDiff: 8, maxConnections: 8, retainJobs: 5, idleCheckMs: 0 }, vardiff, log);
}

const tests = [
  {
    name: 'displayAddress unwraps IPv4-mapped IPv6, leaves real IPv6 alone',
    fn() {
      assertEq(displayAddress('::ffff:192.168.1.50'), '192.168.1.50');
      assertEq(displayAddress('::ffff:127.0.0.1'), '127.0.0.1');
      assertEq(displayAddress('2001:db8::42'), '2001:db8::42');
      assertEq(displayAddress('::1'), '::1');
      assertEq(displayAddress('10.0.0.7'), '10.0.0.7');
      assertEq(displayAddress(undefined), '?');
    },
  },
  {
    name: 'binding "::" serves both IPv6 and IPv4 miners on one socket',
    async fn() {
      if (!(await hasIPv6())) return 'skip';
      const stratum = makeStratum('::');
      try {
        const port = await stratum.listen();
        const v6 = await subscribe('::1', port, 6);
        assert(v6 && v6.result && /^[0-9a-f]{8}$/.test(v6.result[1]), 'IPv6 miner subscribed');
        const v4 = await subscribe('127.0.0.1', port, 4);
        assert(v4 && v4.result && /^[0-9a-f]{8}$/.test(v4.result[1]), 'IPv4 miner subscribed on the same socket');
        // IPv4 peers on a dual-stack socket must not display as ::ffff:...
        for (const s of stratum.sessions) {
          assert(!s.remote.startsWith('::ffff:'), 'peer address normalized, got ' + s.remote);
        }
      } finally {
        await stratum.close();
      }
    },
  },
  {
    name: 'binding an IPv6 literal works',
    async fn() {
      if (!(await hasIPv6())) return 'skip';
      const stratum = makeStratum('::1');
      try {
        const port = await stratum.listen();
        const res = await subscribe('::1', port, 6);
        assert(res && res.result, 'subscribed over IPv6 literal bind');
      } finally {
        await stratum.close();
      }
    },
  },
  {
    name: 'RPC client reaches a node at an IPv6 address (bracketed Host header)',
    async fn() {
      if (!(await hasIPv6())) return 'skip';
      let seenHost = null;
      const server = http.createServer((req, res) => {
        let b = '';
        req.on('data', c => { b += c; });
        req.on('end', () => {
          seenHost = req.headers.host;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result: 42, error: null, id: JSON.parse(b).id }));
        });
      });
      await new Promise(r => server.listen(0, '::1', r));
      const port = server.address().port;
      const rpc = rpcLib.createClient({ host: '::1', port, user: 'u', pass: 'p', timeoutMs: 3000 });
      try {
        assertEq(await rpc.call('getblockcount', []), 42);
        assertEq(seenHost, `[::1]:${port}`, 'IPv6 literal bracketed in Host header');
      } finally {
        rpc.destroy();
        await new Promise(r => server.close(r));
      }
    },
  },
];

module.exports = { tests };
