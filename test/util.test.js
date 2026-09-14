'use strict';
const { assert, assertEq, assertClose, assertThrows } = require('./t');
const util = require('../lib/util');
const algos = require('../lib/algos');

const tests = [
  {
    name: 'DIFF1 constant shape',
    fn() {
      assertEq(util.DIFF1_HEX.length, 64, 'hex length');
      const s = util.DIFF1.toString(16);
      assertEq(s.length, 63, 'leading zero nibble dropped');
      assert(s.startsWith('a5f'), 'starts a5f');
      assert(s.endsWith('eb4'), 'ends eb4');
      assertClose(util.SOLS_PER_DIFF1, 24.6747, 1e-4, 'sols per diff1 share');
    },
  },
  {
    name: 'varint encodings',
    fn() {
      assertEq(util.varint(0), Buffer.from([0]));
      assertEq(util.varint(252), Buffer.from([252]));
      assertEq(util.varint(253).toString('hex'), 'fdfd00');
      assertEq(util.varint(400).toString('hex'), 'fd9001', 'solution preamble');
      assertEq(util.varint(0xffff).toString('hex'), 'fdffff');
      assertEq(util.varint(0x10000).toString('hex'), 'fe00000100');
      for (const n of [0, 1, 252, 253, 400, 65535, 65536, 4294967295]) {
        const enc = util.varint(n);
        const dec = util.readVarint(enc, 0);
        assertEq(dec.value, n, `roundtrip ${n}`);
        assertEq(dec.size, enc.length, `roundtrip size ${n}`);
      }
    },
  },
  {
    name: 'reverseHex is byte reversal, not nibble reversal',
    fn() {
      assertEq(util.reverseHex('0102ff'), 'ff0201');
      assertEq(util.reverseHex('abcdef12'), '12efcdab');
      assertThrows(() => util.reverseHex('abc'), 'odd length rejected');
      assertThrows(() => util.reverseHex('zz'), 'non-hex rejected');
    },
  },
  {
    name: 'sha256d known vector',
    fn() {
      assertEq(
        util.sha256d(Buffer.alloc(0)).toString('hex'),
        '5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456'
      );
    },
  },
  {
    name: 'u32LE packing',
    fn() {
      assertEq(util.u32LEHex(0x20000600), '00060020', 'real block version LE');
      assertEq(util.u32LEHex(1785860212), '7410726a', 'real block time LE');
    },
  },
  {
    name: 'diff/target round trips',
    fn() {
      assertEq(util.diffToTarget(1), util.DIFF1, 'diff 1 == DIFF1');
      for (const d of [0.5, 1, 8, 12.5, 100, 100000]) {
        const t = util.diffToTarget(d);
        assertClose(util.targetToDiff(t), d, 1e-6, `roundtrip ${d}`);
      }
      assertEq(util.diffToTarget(1e-12), util.MAX256, 'tiny diff clamps to max');
      assert(util.diffToTarget(1e15) >= 1n, 'huge diff stays >= 1');
      assertThrows(() => util.diffToTarget(0));
      assertThrows(() => util.diffToTarget(-1));
    },
  },
  {
    name: 'compactToTarget',
    fn() {
      assertEq(util.compactToTarget('1e14d128').toString(16), '14d128' + '0'.repeat(54), 'real block bits');
      assertEq(util.compactToTarget(0x03001234), 0x1234n, 'exp=3 no shift');
      assertEq(util.compactToTarget(0x01120000), 0x12n, 'exp=1 shifts right');
    },
  },
  {
    name: 'bufToBigInt endianness',
    fn() {
      const b = Buffer.from('01000000', 'hex');
      assertEq(util.bufToBigIntLE(b), 1n);
      assertEq(util.bufToBigIntBE(b), 0x01000000n);
    },
  },
  {
    name: 'netSolsFromDiff converts difficulty to network Sol/s',
    fn() {
      assertClose(util.netSolsFromDiff(100), (100 * util.SOLS_PER_DIFF1) / 480, 1e-12);
      assertClose(util.netSolsFromDiff(46463.476), (46463.476 * util.SOLS_PER_DIFF1) / util.PER_ALGO_BLOCK_SEC, 1e-9);
      // null, never 0 — a zero would draw a false crash to the chart floor.
      for (const bad of [null, undefined, 0, -5, NaN, Infinity, '100']) {
        assertEq(util.netSolsFromDiff(bad), null, 'rejects ' + String(bad));
      }
    },
  },
  {
    name: 'jobNetDiff reads a job block target, null when absent or not a BigInt',
    fn() {
      assertClose(util.jobNetDiff({ blockTarget: util.diffToTarget(64) }), 64, 1e-6);
      assertClose(util.jobNetDiff({ blockTarget: util.DIFF1 }), 1, 1e-9);
      for (const bad of [null, undefined, {}, { blockTarget: 0n }, { blockTarget: -1n }]) {
        assertEq(util.jobNetDiff(bad), null, 'rejects ' + JSON.stringify(bad === undefined ? 'undefined' : bad, (k, v) => typeof v === 'bigint' ? String(v) : v));
      }
      // targetToDiff answers 0 for a non-BigInt; jobNetDiff must answer null.
      assertEq(util.targetToDiff('0xff'), 0, 'precondition: targetToDiff returns 0');
      assertEq(util.jobNetDiff({ blockTarget: '0xff' }), null);
    },
  },
  {
    name: 'merkleRoot edge cases',
    fn() {
      const a = util.sha256d(Buffer.from('a'));
      const b = util.sha256d(Buffer.from('b'));
      const c = util.sha256d(Buffer.from('c'));
      assertEq(util.merkleRoot([a]), a, 'single leaf is the root');
      assertEq(util.merkleRoot([a, b]), util.sha256d(Buffer.concat([a, b])), 'pair');
      const ab = util.sha256d(Buffer.concat([a, b]));
      const cc = util.sha256d(Buffer.concat([c, c]));
      assertEq(util.merkleRoot([a, b, c]), util.sha256d(Buffer.concat([ab, cc])), 'odd duplicates last');
      assertThrows(() => util.merkleRoot([]));
    },
  },
  {
    name: 'DIFF1 for 200/9 is the zcash-family 0x0007ff…ff: 8192 solutions per diff-1 share',
    fn() {
      assertEq(util.DIFF1_200.toString(16), '7' + 'f'.repeat(60), 'shape');
      assertEq(util.DIFF1, util.DIFF1_192, 'the pre-200/9 name still means 192/7');
      assertClose(util.solsPerDiff1(util.DIFF1_200), 8192, 1e-9);
      assertClose(util.solsPerDiff1(util.DIFF1_192), util.SOLS_PER_DIFF1, 1e-12);
      // ~332x apart — why a 200/9 port needs difficulty numbers of its own.
      assertClose(Number((util.DIFF1_192 * 1000000n) / util.DIFF1_200) / 1e6, 332, 1e-4);
    },
  },
  {
    name: 'diff/target conversions honour an explicit diff1; jobNetDiff reads the job\'s algo',
    fn() {
      assertEq(util.diffToTarget(1, util.DIFF1_200), util.DIFF1_200);
      for (const d of [0.05, 1, 19172.409]) {
        assertClose(util.targetToDiff(util.diffToTarget(d, util.DIFF1_200), util.DIFF1_200), d, 1e-6, `roundtrip ${d}`);
      }
      // One target, two scales.
      const t = util.diffToTarget(10, util.DIFF1_200);
      assertClose(util.targetToDiff(t), 3320, 1e-4, 'read on the 192/7 scale');
      assertClose(util.jobNetDiff({ blockTarget: t, algo: algos.get('equihash200') }), 10, 1e-6);
      assertClose(util.jobNetDiff({ blockTarget: t }), 3320, 1e-4, 'a job with no algo is 192/7');
      assertClose(util.netSolsFromDiff(100, 8192), (100 * 8192) / 480, 1e-12);
    },
  },
];

module.exports = { tests };
