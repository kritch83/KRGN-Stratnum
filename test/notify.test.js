'use strict';
// Pushover transport. Everything runs against a local http server standing in
// for api.pushover.net, so there is no TLS fixture and no network.

const http = require('http');
const { assert, assertEq } = require('./t');
const logLib = require('../lib/log');
const { createNotifier, formEncode, clip, MIN_RETRY_MS } = require('../lib/notify');

logLib.setLevel('error');

// Captures every request and replies with whatever the test queued.
async function mockPushover(replies) {
  const seen = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ method: req.method, path: req.url, contentType: req.headers['content-type'], body,
        fields: Object.fromEntries(new URLSearchParams(body)) });
      const r = replies[Math.min(i++, replies.length - 1)] || { code: 200, body: '{"status":1,"request":"x"}' };
      res.writeHead(r.code, { 'Content-Type': 'application/json' });
      res.end(r.body);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    seen,
    endpoint: `http://127.0.0.1:${server.address().port}/1/messages.json`,
    close: () => new Promise(r => server.close(r)),
  };
}

// Collects log lines so "was this reported exactly once?" is assertable.
function capturingLog() {
  const lines = [];
  const rec = lvl => (...args) => lines.push(lvl + ' ' + args.join(' '));
  return { lines, error: rec('error'), warn: rec('warn'), info: rec('info'), debug: rec('debug') };
}

const tests = [
  {
    name: 'sends a form-encoded POST carrying token, user and message',
    async fn() {
      const mock = await mockPushover([{ code: 200, body: '{"status":1,"request":"abc"}' }]);
      try {
        const n = createNotifier({
          enabled: true, apiToken: 'TOKEN', userKey: 'USER', device: 'phone',
          priority: 0, endpoint: mock.endpoint, now: () => 1700000000000,
        }, capturingLog());
        assertEq(await n.send({ title: 'Block found', message: 'rig1 · 5 KRGN' }), true);

        assertEq(mock.seen.length, 1);
        const r = mock.seen[0];
        assertEq(r.method, 'POST');
        assertEq(r.path, '/1/messages.json');
        assertEq(r.contentType, 'application/x-www-form-urlencoded');
        assertEq(r.fields.token, 'TOKEN');
        assertEq(r.fields.user, 'USER');
        assertEq(r.fields.message, 'rig1 · 5 KRGN');
        assertEq(r.fields.title, 'Block found');
        assertEq(r.fields.device, 'phone');
        assertEq(r.fields.timestamp, '1700000000');
        assertEq(n.stats.sent, 1);
      } finally {
        await mock.close();
      }
    },
  },
  {
    name: 'empty optional fields are omitted, not sent blank',
    fn() {
      const body = formEncode({ token: 't', user: 'u', message: 'm', device: '', sound: undefined, priority: 0 });
      assert(!body.includes('device'), 'empty device omitted');
      assert(!body.includes('sound'), 'undefined sound omitted');
      assert(body.includes('priority=0'), 'priority 0 is a real value, not "empty"');
    },
  },
  {
    name: 'a 4xx is never retried — repeating bad input just burns the quota',
    async fn() {
      const mock = await mockPushover([{ code: 400, body: '{"status":0,"errors":["user identifier is invalid"]}' }]);
      const log = capturingLog();
      try {
        const n = createNotifier({ enabled: true, apiToken: 'T', userKey: 'BAD', endpoint: mock.endpoint }, log);
        assertEq(await n.send({ title: 'x', message: 'y' }), false);
        assertEq(mock.seen.length, 1, 'exactly one attempt');
        assertEq(n.stats.dropped, 1);
        const errs = log.lines.filter(l => l.startsWith('error'));
        assertEq(errs.length, 1, 'reported once, not once per retry');
        assert(/user identifier is invalid/.test(errs[0]), errs[0]);
      } finally {
        await mock.close();
      }
    },
  },
  {
    name: '429 says the monthly limit was hit rather than blaming the token',
    async fn() {
      const mock = await mockPushover([{ code: 429, body: '{"status":0,"errors":["limit reached"]}' }]);
      const log = capturingLog();
      try {
        const n = createNotifier({ enabled: true, apiToken: 'T', userKey: 'U', endpoint: mock.endpoint }, log);
        await n.send({ title: 'x', message: 'y' });
        assert(/monthly message limit/.test(log.lines.join('\n')), log.lines.join('\n'));
      } finally {
        await mock.close();
      }
    },
  },
  {
    name: '5xx is retried, spaced by at least the documented 5 seconds',
    async fn() {
      const mock = await mockPushover([
        { code: 500, body: 'server error' },
        { code: 500, body: 'server error' },
        { code: 200, body: '{"status":1}' },
      ]);
      const slept = [];
      let clock = 0;
      try {
        const n = createNotifier({
          enabled: true, apiToken: 'T', userKey: 'U', endpoint: mock.endpoint,
          now: () => clock,
          sleep: ms => { slept.push(ms); clock += ms; return Promise.resolve(); },
        }, capturingLog());
        assertEq(await n.send({ title: 'x', message: 'y' }), true, 'third attempt succeeds');
        assertEq(mock.seen.length, 3);
        assertEq(slept.length, 2, 'slept before each retry');
        for (const ms of slept) assert(ms >= MIN_RETRY_MS, `waited ${ms}ms, need >= ${MIN_RETRY_MS}`);
      } finally {
        await mock.close();
      }
    },
  },
  {
    name: '5xx that never clears gives up after a bounded number of attempts',
    async fn() {
      const mock = await mockPushover([{ code: 503, body: 'nope' }]);
      let clock = 0;
      try {
        const n = createNotifier({
          enabled: true, apiToken: 'T', userKey: 'U', endpoint: mock.endpoint,
          now: () => clock, sleep: ms => { clock += ms; return Promise.resolve(); },
        }, capturingLog());
        assertEq(await n.send({ title: 'x', message: 'y' }), false);
        assertEq(mock.seen.length, 3, 'initial + 2 retries, then stop');
        assertEq(n.stats.failed, 1);
      } finally {
        await mock.close();
      }
    },
  },
  {
    name: 'disabled opens no socket at all',
    async fn() {
      const mock = await mockPushover([{ code: 200, body: '{"status":1}' }]);
      try {
        const n = createNotifier({ enabled: false, apiToken: 'T', userKey: 'U', endpoint: mock.endpoint }, capturingLog());
        assertEq(await n.send({ title: 'x', message: 'y' }), false);
        assertEq(mock.seen.length, 0, 'nothing sent');
      } finally {
        await mock.close();
      }
    },
  },
  {
    name: 'over-long message and title are clipped below the API limits',
    fn() {
      assertEq(clip('x'.repeat(2000), 1024).length, 1024);
      assertEq(clip('y'.repeat(400), 250).length, 250);
      assert(clip('z'.repeat(300), 250).endsWith('…'), 'clipping is visible');
      assertEq(clip('short', 250), 'short', 'under the limit is untouched');
      assertEq(clip(null, 250), '', 'null is not the string "null"');
    },
  },
  {
    name: 'a dead endpoint never throws into the caller — mining must not care',
    async fn() {
      let clock = 0;
      const n = createNotifier({
        enabled: true, apiToken: 'T', userKey: 'U',
        endpoint: 'http://127.0.0.1:1/1/messages.json',  // nothing listening
        now: () => clock, sleep: ms => { clock += ms; return Promise.resolve(); },
      }, capturingLog());
      assertEq(await n.send({ title: 'x', message: 'y' }), false, 'resolves false rather than rejecting');
      assertEq(n.stats.failed, 1);
    },
  },
  {
    name: 'sends are serialised, so ordering on the phone matches reality',
    async fn() {
      const mock = await mockPushover([{ code: 200, body: '{"status":1}' }]);
      try {
        const n = createNotifier({ enabled: true, apiToken: 'T', userKey: 'U', endpoint: mock.endpoint }, capturingLog());
        await Promise.all([
          n.send({ title: 'first', message: '1' }),
          n.send({ title: 'second', message: '2' }),
          n.send({ title: 'third', message: '3' }),
        ]);
        assertEq(mock.seen.map(r => r.fields.title), ['first', 'second', 'third']);
      } finally {
        await mock.close();
      }
    },
  },
];

module.exports = { tests };
