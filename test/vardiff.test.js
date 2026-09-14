'use strict';
const { assert, assertEq, assertClose } = require('./t');
const { VarDiff } = require('../lib/vardiff');

let T = 1000;
const clock = () => T;

function makeVd(opts) {
  return new VarDiff(Object.assign({
    targetTime: 15, retargetTime: 90, variancePercent: 30, minDiff: 0.5, maxDiff: 100000,
  }, opts || {}), clock);
}

const tests = [
  {
    name: 'fast miner ramps difficulty up to the max clamp',
    fn() {
      T = 1000;
      const vd = makeVd();
      const s = vd.createSession(8);
      const retargets = [];
      for (let i = 0; i < 600; i++) {
        T += 2; // one share every 2s, target is 15s
        const d = vd.onShare(s);
        if (d !== null) retargets.push(d);
      }
      assert(retargets.length >= 3, 'several retargets happened');
      for (let i = 1; i < retargets.length; i++) {
        assert(retargets[i] >= retargets[i - 1], 'monotonic ramp up');
      }
      assertEq(s.difficulty, 100000, 'clamped at maxDiff');
    },
  },
  {
    name: 'slow miner ramps down to the min clamp',
    fn() {
      T = 1000;
      const vd = makeVd();
      const s = vd.createSession(8);
      for (let i = 0; i < 60; i++) {
        T += 60;
        vd.onShare(s);
      }
      assertEq(s.difficulty, 0.5, 'clamped at minDiff');
    },
  },
  {
    name: 'dead band: on-target share rate never retargets',
    fn() {
      T = 1000;
      const vd = makeVd();
      const s = vd.createSession(8);
      for (let i = 0; i < 100; i++) {
        T += 15;
        assertEq(vd.onShare(s), null, `share ${i}`);
      }
      assertEq(s.difficulty, 8);
      // Edge of the band (10.5 .. 19.5) also holds.
      for (let i = 0; i < 50; i++) {
        T += 11;
        assertEq(vd.onShare(s), null);
      }
      assertEq(s.difficulty, 8);
    },
  },
  {
    name: 'no retarget before retargetTime elapses',
    fn() {
      T = 1000;
      const vd = makeVd();
      const s = vd.createSession(8);
      // First retarget is possible after retargetTime/2 = 45s from creation.
      let first = null;
      let elapsed = 0;
      while (first === null && elapsed < 500) {
        T += 2; elapsed += 2;
        first = vd.onShare(s);
      }
      assert(elapsed >= 44 && elapsed <= 48, `first retarget near 45s, got ${elapsed}`);
      // After that, nothing for another 90s.
      let second = null;
      let elapsed2 = 0;
      while (second === null && elapsed2 < 500) {
        T += 2; elapsed2 += 2;
        second = vd.onShare(s);
      }
      assert(elapsed2 >= 90 && elapsed2 <= 94, `second retarget after ~90s, got ${elapsed2}`);
    },
  },
  {
    name: 'previousDifficulty bookkeeping on retarget',
    fn() {
      T = 1000;
      const vd = makeVd();
      const s = vd.createSession(8);
      assertEq(s.previousDifficulty, null);
      let d = null;
      while (d === null) { T += 2; d = vd.onShare(s); }
      assertEq(s.previousDifficulty, 8);
      assertClose(s.difficulty, 8 * 15 / 2, 0.01);
    },
  },
  {
    name: 'createSession clamps the start difficulty',
    fn() {
      T = 1000;
      const vd = makeVd();
      assertEq(vd.createSession(1e9).difficulty, 100000);
      assertEq(vd.createSession(1e-9).difficulty, 0.5);
      assertEq(vd.createSession(8).difficulty, 8);
    },
  },
  {
    name: 'idle check halves difficulty, repeatedly, down to min',
    fn() {
      T = 1000;
      const vd = makeVd();
      const s = vd.createSession(64);
      assertEq(vd.onIdleCheck(s), null, 'not idle yet');
      T += 80; // > max(60, 5*15) = 75
      assertEq(vd.onIdleCheck(s), 32);
      assertEq(s.previousDifficulty, 64);
      assertEq(vd.onIdleCheck(s), null, 'idle clock restarted');
      T += 80;
      assertEq(vd.onIdleCheck(s), 16);
      for (let i = 0; i < 20; i++) { T += 80; vd.onIdleCheck(s); }
      assertEq(s.difficulty, 0.5, 'floors at minDiff');
      T += 80;
      assertEq(vd.onIdleCheck(s), null, 'no-op at minDiff');
    },
  },
];

module.exports = { tests };
