'use strict';
// The payout-address check: reading whom a coinbase pays, and comparing the
// node's own fallback (-mineraddress) with pool.address.

const { assert, assertEq, assertThrows } = require('./t');
const util = require('../lib/util');
const rpcLib = require('../lib/rpc');
const logLib = require('../lib/log');
const coinbaseLib = require('../lib/coinbase');
const { Daemon } = require('../lib/daemon');
const { createPayoutCheck } = require('../lib/payout-check');
const { createMockDaemon } = require('./mock-daemon');
const fixtures = require('./fixtures');

const quietLog = { error() {}, warn() {}, info() {}, debug() {} };

// A log that remembers what it was told.
function recordingLog() {
  const lines = [];
  return { lines, error: m => lines.push(['error', m]), warn: m => lines.push(['warn', m]),
    info: m => lines.push(['info', m]), debug() {} };
}

// Base58Check, decoded here so the test owes nothing to the code under test.
function base58Decode(s) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error('not base58: ' + c);
    n = n * 58n + BigInt(v);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const lead = s.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, 'hex')]);
}

// A stand-in node for the check alone: scripts by address, a fallback script.
function stubDaemon(over) {
  return Object.assign({
    calls: 0,
    poolScript: '76a914' + '11'.repeat(20) + '88ac',
    fallback: '76a914' + '11'.repeat(20) + '88ac',
    async addressInfo() { return { valid: true, scriptHex: this.poolScript }; },
    async fallbackPayoutScript() {
      this.calls++;
      if (this.fail) throw new Error(this.fail);
      return this.fallback;
    },
    async scriptAddress(hex) { return hex === '76a914' + '22'.repeat(20) + '88ac' ? 'KNodeOwnAddress' : null; },
  }, over || {});
}

const tests = [
  {
    name: 'a coinbase\'s first output is its payee: block 116370 pays the explorer\'s minerAddress',
    fn() {
      const blk = fixtures.parseRealBlock();
      const json = fixtures.loadBlockJson();
      const script = coinbaseLib.firstOutputScript(blk.txs[0].toString('hex'));
      const raw = base58Decode(json.minerAddress);
      assertEq(raw.length, 25, 'version byte, hash160, checksum');
      assertEq(util.sha256d(raw.subarray(0, 21)).subarray(0, 4), raw.subarray(21), 'a valid address');
      assertEq(script.toString('hex'), '76a914' + raw.subarray(1, 21).toString('hex') + '88ac',
        'pay-to-pubkey-hash of that address');
      // The rewrite the mock node uses agrees with the reader.
      const other = '76a914' + 'ab'.repeat(20) + '88ac';
      assertEq(coinbaseLib.firstOutputScript(fixtures.withFirstOutputScript(blk.txs[0].toString('hex'), other))
        .toString('hex'), other);
      assertThrows(() => coinbaseLib.firstOutputScript(blk.txs[0].subarray(0, 50).toString('hex')), 'truncated');
    },
  },
  {
    name: 'the check: match, differs and unset, each logged once when it changes; a failed check keeps the last answer',
    async fn() {
      const log = recordingLog();
      const d = stubDaemon();
      const c = createPayoutCheck({ daemon: d, address: 'KPoolAddress', log });
      assertEq(c.state.status, 'unknown', 'nothing known before the first answer');

      assert(await c.check());
      assertEq([c.state.status, c.state.nodeAddress], ['match', 'KPoolAddress']);
      assert(c.state.checkedAt > 0);
      await c.check();
      assertEq(log.lines.length, 1, 'an unchanged answer is not logged again');
      assertEq(log.lines[0][0], 'info');

      d.fallback = '76a914' + '22'.repeat(20) + '88ac';
      await c.check();
      assertEq([c.state.status, c.state.nodeAddress], ['differs', 'KNodeOwnAddress'], 'named via decodescript');
      assertEq(log.lines[1][0], 'warn');
      assert(/mineraddress=KPoolAddress/.test(log.lines[1][1]), 'the log says what to set');

      d.fallback = '51';   // OP_TRUE: no -mineraddress
      await c.check();
      assertEq([c.state.status, c.state.nodeAddress], ['unset', null]);
      assert(/anyone can spend/.test(log.lines[2][1]));

      d.fail = 'connect ECONNREFUSED';
      assertEq(await c.check(), false);
      assertEq([c.state.status, c.state.error], ['unset', 'connect ECONNREFUSED'], 'last answer kept, reason recorded');
      assertEq(log.lines.length, 3, 'a failure is not a change');
      d.fail = null;
      d.fallback = d.poolScript;
      await c.check();
      assertEq([c.state.status, c.state.error], ['match', null]);

      // A node that cannot say whom pool.address pays leaves it unknown.
      const blind = createPayoutCheck({ daemon: stubDaemon({ poolScript: null }), address: 'K', log: quietLog });
      assertEq(await blind.check(), false);
      assertEq(blind.state.status, 'unknown');
    },
  },
  {
    name: 'against the mock node: the probe names no pooladdress, and each fallback is read back',
    async fn() {
      const mock = await createMockDaemon({ blockcount: 116369 });
      const rpc = rpcLib.createClient({ host: '127.0.0.1', port: mock.port, user: 'u', pass: 'p', timeoutMs: 2000 });
      const daemon = new Daemon(rpc, { address: 'KTestAddress', pollMs: 1000, jobRefreshSec: 3600,
        backoffMs: 50, connectionsPollMs: 0 }, quietLog);
      try {
        const c = createPayoutCheck({ daemon, address: 'KTestAddress', log: quietLog });
        assert(await c.check());
        assertEq(c.state.status, 'match', 'by default the mock node pays the pool address either way');
        const probe = mock.state.gbtRequests[mock.state.gbtRequests.length - 1].params[0];
        assertEq(probe.pooladdress, undefined, 'the probe must not name an address');
        assert(probe.capabilities.includes('coinbasetxn'), 'and asks for the coinbase');

        const other = '76a914' + 'cd'.repeat(20) + '88ac';
        mock.state.mineraddressScript = other;
        mock.state.scriptAddresses[other] = 'KSomeoneElse';
        await c.check();
        assertEq([c.state.status, c.state.nodeAddress], ['differs', 'KSomeoneElse']);
        mock.state.mineraddressScript = '51';
        await c.check();
        assertEq(c.state.status, 'unset');
      } finally {
        if (rpc.destroy) rpc.destroy();
        await mock.close();
      }
    },
  },
];

module.exports = { tests };
