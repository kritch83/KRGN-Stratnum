'use strict';
// Everything that differs between 192/7 and 200/9 lives in lib/algos.js. These
// pin those constants against the real chain data, and check that each algo's
// stats keep to their own files and their own rate scale.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertEq, assertClose, assertThrows } = require('./t');
const logLib = require('../lib/log');
const util = require('../lib/util');
const algos = require('../lib/algos');
const { Stats } = require('../lib/stats');
const fixtures = require('./fixtures');

logLib.setLevel('error');
const log = logLib.make('test-algos');

const tests = [
  {
    name: 'profiles match the real blocks: version nibble, solution prefix and size',
    fn() {
      for (const key of ['equihash192', 'equihash200']) {
        const a = algos.get(key);
        const blk = fixtures.parseRealBlock(key);
        assertEq((blk.fields.version >> 8) & 0xf, a.versionNibble, `${key} nibble`);
        assertEq(blk.solutionWithPrefix.subarray(0, 3).toString('hex'), a.eq.SOLUTION_PREFIX, `${key} prefix`);
        assertEq(blk.solution.length, a.eq.SOLUTION_BYTES, `${key} solution size`);
      }
    },
  },
  {
    name: 'profile constants: names, notify strings, personalization, difficulty scale',
    fn() {
      const a192 = algos.get('equihash192');
      const a200 = algos.get('equihash200');
      assertEq([a192.key, a192.notifyAlgo, a192.personalization, a192.eq.N, a192.eq.K],
        ['equihash192', '192_7', 'kerrigan', 192, 7]);
      assertEq([a200.key, a200.notifyAlgo, a200.personalization, a200.eq.N, a200.eq.K],
        ['equihash200', '200_9', 'ZcashPoW', 200, 9]);
      assertEq(a192.diff1, util.DIFF1_192);
      assertEq(a200.diff1, util.DIFF1_200);
      assertClose(a192.solsPerDiff1, 24.6747, 1e-4);
      assertClose(a200.solsPerDiff1, 8192, 1e-9);
      assertEq(a200.diffToTarget(1), util.DIFF1_200);
      assertClose(a200.targetToDiff(a200.diffToTarget(0.25)), 0.25, 1e-9);
      assertClose(a200.netSolsFromDiff(480), 8192, 1e-9, 'diff 480 at 480 s a block = one diff-1 share a second');
    },
  },
  {
    name: 'algos.get: the default is 192/7; an unknown name throws rather than becoming 192/7',
    fn() {
      assertEq(algos.get().key, 'equihash192');
      assertEq(algos.get(null).key, 'equihash192');
      assertThrows(() => algos.get('equihash210'));
      assertThrows(() => algos.get('toString'), 'prototype names are not algos');
      assertEq(algos.list().map(a => a.key), ['equihash192', 'equihash200']);
    },
  },
  {
    name: 'stats: an algo gets its own files beside 192/7\'s, and its own rate scale',
    fn() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratnum-algos-'));
      const nowRef = { t: 1_000_000_000_000 };
      const a200 = algos.get('equihash200');
      const mk = extra => new Stats(Object.assign({ dataDir: dir, historySamples: 5, now: () => nowRef.t }, extra || {}), log);
      const s192 = mk();
      const s200 = mk({ fileTag: 'equihash200', solsPerDiff1: a200.solsPerDiff1 });
      assertEq(path.basename(s192.statePath), 'state.json', '192/7 keeps the original name');
      assertEq(path.basename(s192.historyPath), 'history.json');
      assertEq(path.basename(s200.statePath), 'state-equihash200.json');
      assertEq(path.basename(s200.historyPath), 'history-equihash200.json');

      s200.registerBlock({
        height: 122284, cbTxid: 'cb', worker: 'w', foundAt: 1, rewardSat: 5e8, shareDiff: 1, accepted: true, submitResult: null,
      });
      s200.recordSample(19172.409);
      s200.saveHistory();
      assertEq(mk().counters.blocksFound, 0, 'the 200/9 block did not land in the 192/7 file');
      const back = mk({ fileTag: 'equihash200', solsPerDiff1: a200.solsPerDiff1 });
      assertEq(back.counters.blocksFound, 1);
      assertEq(back.history.length, 1);
      assertClose(back.history[0].netSols, (19172.409 * 8192) / 480, 1e-6, 'network Sol/s on the 200/9 scale');

      nowRef.t += 5000;
      back.recordShare({ worker: 'w', bookedDiff: 1, shareDiff: 1 });
      assertClose(back.solsRate(300), 8192 / 30, 1e-9, 'one diff-1 share is 8192 solutions');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  },
];

module.exports = { tests };
