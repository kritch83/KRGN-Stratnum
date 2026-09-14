'use strict';
// The ZMTP client is hand-written protocol code, so the tests that matter run
// it against a REAL libzmq publisher (pyzmq), not only against a mock of my
// own understanding. Those tests skip visibly when the venv is absent, so the
// suite stays offline-clean; the adversarial cases use a JS mock because
// libzmq will not emit malformed frames on request.

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { assert, assertEq, assertThrows } = require('./t');
const logLib = require('../lib/log');
const zmq = require('../lib/zmq');

logLib.setLevel('error');
const log = logLib.make('test-zmq');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const VENV = '/private/tmp/claude-501/-Users-kritch-Desktop-stratnum/4aeb6737-4dc8-4319-8f9a-5b511dfd9ac2/scratchpad/zmqvenv/bin/python';
const HAVE_PYZMQ = fs.existsSync(VENV);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

// A real libzmq PUB that republishes on an interval until killed, so the
// subscriber is guaranteed to catch one however the handshake races.
function startRealPublisher(port, topic, hashHex) {
  const script = `
import zmq, time, binascii, sys
ctx = zmq.Context()
s = ctx.socket(zmq.PUB)
s.bind("tcp://127.0.0.1:${port}")
seq = 0
while True:
    s.send_multipart([b"${topic}", binascii.unhexlify("${hashHex}"), seq.to_bytes(4, "little")])
    seq += 1
    time.sleep(0.05)
`;
  const p = spawn(VENV, ['-c', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  return p;
}

function firstMessage(sub, timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs || 8000);
    sub.once('message', frames => { clearTimeout(timer); resolve(frames); });
  });
}

const tests = [
  {
    name: 'greeting is the 64-byte ZMTP layout the spec (and libzmq memcmp) demands',
    fn() {
      const g = zmq.buildGreeting();
      assertEq(g.length, 64);
      assertEq(g[0], 0xff, 'signature start');
      assertEq(g[9], 0x7f, 'signature end');
      assertEq(g[10], 3, 'major version');
      assertEq(g[11], 0, 'minor 0 -> ZMTP 3.0, which accepts 0x01-prefixed subscribes');
      assertEq(g.subarray(12, 32).toString('ascii'), 'NULL' + '\0'.repeat(16), 'mechanism NUL-padded to 20');
      assertEq(g[32], 0, 'as-server = 0 for a connecting client');
      assertEq(g.subarray(33, 64), Buffer.alloc(31), 'filler');
    },
  },
  {
    name: 'READY declares Socket-Type SUB with a BE32 value length',
    fn() {
      const f = zmq.buildReady();
      assertEq(f[0] & zmq.FLAG_COMMAND, zmq.FLAG_COMMAND, 'COMMAND flag');
      assertEq(f[0] & zmq.FLAG_LONG, 0, 'short frame');
      const body = f.subarray(2);
      assertEq(f[1], body.length, 'declared size matches');
      assertEq(body[0], 5);
      assertEq(body.subarray(1, 6).toString('ascii'), 'READY');
      assertEq(body[6], 11);
      assertEq(body.subarray(7, 18).toString('ascii'), 'Socket-Type');
      assertEq(body.readUInt32BE(18), 3, 'value length is big-endian');
      assertEq(body.subarray(22).toString('ascii'), 'SUB');
    },
  },
  {
    name: 'subscribe is a plain message frame with a 0x01 prefix byte',
    fn() {
      const all = zmq.buildSubscribe('');
      assertEq(all[0], 0, 'not a command — ZMTP 3.0 style');
      assertEq(all[1], 1, 'one byte of body');
      assertEq(all[2], 0x01, 'subscribe opcode');
      const topic = zmq.buildSubscribe('hashblock');
      assertEq(topic[1], 10);
      assertEq(topic.subarray(3).toString('ascii'), 'hashblock');
    },
  },
  {
    name: 'url parsing accepts tcp://host:port and IPv6, rejects the rest',
    fn() {
      assertEq(zmq.parseUrl('tcp://127.0.0.1:28332'), { host: '127.0.0.1', port: 28332 });
      assertEq(zmq.parseUrl('tcp://[::1]:28332'), { host: '::1', port: 28332 });
      for (const bad of ['', 'ipc:///tmp/x', 'tcp://host', 'tcp://host:0', 'tcp://host:99999', 'http://h:1']) {
        assertThrows(() => zmq.parseUrl(bad), 'should reject ' + JSON.stringify(bad));
      }
    },
  },
  {
    name: 'CROSS-CHECK vs real libzmq: receives a hashblock message intact',
    async fn() {
      if (!HAVE_PYZMQ) {
        console.log('     (pyzmq venv absent — skipping the libzmq cross-check)');
        return 'skip';
      }
      const hashHex = 'af99a2f470c6426c39eee4bfe4ba62106dcc58b152cc4d1badeb3d2c2b6b7f79';
      const port = await freePort();
      const pub = startRealPublisher(port, 'hashblock', hashHex);
      const sub = zmq.createSubscriber({ url: `tcp://127.0.0.1:${port}`, minBackoffMs: 50 }, log);
      try {
        await sleep(400); // let the publisher bind
        sub.start();
        const frames = await firstMessage(sub);
        assert(frames, 'no message arrived from a real libzmq publisher');
        assertEq(frames.length, 3, 'topic + payload + sequence');
        assertEq(frames[0].toString('ascii'), 'hashblock', 'topic frame, no NUL terminator');
        assertEq(frames[1].length, 32, '32-byte hash');
        // The daemon reverses uint256 before publishing, so the bytes on the
        // wire are already the display form — must NOT be reversed again.
        assertEq(frames[1].toString('hex'), hashHex, 'hash hex matches getbestblockhash form');
        assertEq(frames[2].length, 4, 'LE uint32 sequence');
        assert(sub.connected, 'subscriber reports connected');
        assertEq(sub.status, 'connected');
      } finally {
        sub.stop();
        pub.kill('SIGKILL');
      }
    },
  },
  {
    name: 'CROSS-CHECK vs real libzmq: reconnects after the publisher dies',
    async fn() {
      if (!HAVE_PYZMQ) return 'skip';
      const hashHex = '11'.repeat(32);
      const port = await freePort();
      let pub = startRealPublisher(port, 'hashblock', hashHex);
      const sub = zmq.createSubscriber({ url: `tcp://127.0.0.1:${port}`, minBackoffMs: 100, maxBackoffMs: 300 }, log);
      const events = [];
      sub.on('up', () => events.push('up'));
      sub.on('down', () => events.push('down'));
      try {
        await sleep(400);
        sub.start();
        assert(await firstMessage(sub), 'first message');
        pub.kill('SIGKILL');
        await sleep(300);
        assert(!sub.connected, 'noticed the publisher going away');
        pub = startRealPublisher(port, 'hashblock', hashHex);
        await sleep(500);
        const again = await firstMessage(sub, 6000);
        assert(again, 'did not recover after the publisher came back');
        assertEq(again[1].toString('hex'), hashHex);
        assert(events.filter(e => e === 'up').length >= 2, 'up fired again after reconnect');
      } finally {
        sub.stop();
        pub.kill('SIGKILL');
      }
    },
  },
  {
    name: 'CROSS-CHECK vs real libzmq: measure notification latency',
    async fn() {
      if (!HAVE_PYZMQ) return 'skip';
      const port = await freePort();
      const pub = startRealPublisher(port, 'hashblock', '22'.repeat(32));
      const sub = zmq.createSubscriber({ url: `tcp://127.0.0.1:${port}`, minBackoffMs: 50 }, log);
      try {
        await sleep(400);
        sub.start();
        assert(await firstMessage(sub), 'connected');
        // The publisher emits every 50 ms; measure the gap between arrivals to
        // confirm we are reading continuously rather than batching.
        const t0 = Date.now();
        let count = 0;
        await new Promise(resolve => {
          const done = () => { if (++count >= 5) { sub.off('message', done); resolve(); } };
          sub.on('message', done);
          setTimeout(resolve, 4000);
        });
        const perMsg = (Date.now() - t0) / Math.max(count, 1);
        console.log(`     (${count} messages, ${perMsg.toFixed(0)} ms apart — publisher interval is 50 ms)`);
        assert(count >= 3, 'stream keeps flowing, got ' + count);
      } finally {
        sub.stop();
        pub.kill('SIGKILL');
      }
    },
  },
  {
    name: 'hostile peer: an 8-byte LONG length cannot be used to exhaust memory',
    async fn() {
      const port = await freePort();
      const srv = net.createServer(sock => {
        sock.on('data', () => {});
        sock.write(zmq.buildGreeting());
        sock.write(zmq.buildReady());
        // LONG frame claiming ~18 exabytes
        const evil = Buffer.alloc(9);
        evil[0] = zmq.FLAG_LONG;
        evil.writeBigUInt64BE(0xffffffffffffff00n, 1);
        sock.write(evil);
      });
      await new Promise(r => srv.listen(port, '127.0.0.1', r));
      const sub = zmq.createSubscriber({ url: `tcp://127.0.0.1:${port}`, minBackoffMs: 60000 }, log);
      try {
        sub.start();
        await sleep(400);
        assert(!sub.connected, 'must have dropped the connection');
        assert(/exceeds cap/.test(sub.status), 'status explains why: ' + sub.status);
        assert(process.memoryUsage().rss < 600 * 1024 * 1024, 'no runaway allocation');
      } finally {
        sub.stop();
        await new Promise(r => srv.close(r));
      }
    },
  },
  {
    name: 'hostile peer: bad greeting, wrong mechanism and junk are all refused',
    async fn() {
      const cases = [
        ['bad signature', () => Buffer.alloc(64)],
        ['wrong mechanism', () => { const g = zmq.buildGreeting(); g.write('CURVE', 12, 'ascii'); return g; }],
        ['ancient ZMTP', () => { const g = zmq.buildGreeting(); g[10] = 1; return g; }],
        ['pure junk', () => Buffer.from('HTTP/1.1 200 OK\r\n\r\n<html>', 'ascii')],
      ];
      for (const [label, make] of cases) {
        const port = await freePort();
        const srv = net.createServer(sock => { sock.on('data', () => {}); sock.write(make()); });
        await new Promise(r => srv.listen(port, '127.0.0.1', r));
        const sub = zmq.createSubscriber({ url: `tcp://127.0.0.1:${port}`, minBackoffMs: 60000 }, log);
        try {
          sub.start();
          await sleep(250);
          assert(!sub.connected, label + ': must not report connected');
        } finally {
          sub.stop();
          await new Promise(r => srv.close(r));
        }
      }
    },
  },
  {
    name: 'a dead endpoint retries with backoff instead of spinning or throwing',
    async fn() {
      const port = await freePort(); // nothing listening
      const sub = zmq.createSubscriber({ url: `tcp://127.0.0.1:${port}`, minBackoffMs: 50, maxBackoffMs: 200 }, log);
      sub.start();
      await sleep(400);
      assert(!sub.connected, 'still down');
      assert(sub.status && sub.status !== 'off', 'status records the failure: ' + sub.status);
      sub.stop();
      assertEq(sub.status, 'off', 'stop() clears the status');
      await sleep(150); // a stopped subscriber must not keep reconnecting
      assertEq(sub.status, 'off');
    },
  },
];

module.exports = { tests };
