'use strict';
const { assert, assertEq } = require('./t');
const equihash = require('../lib/equihash');
const fixtures = require('./fixtures');

function realParts() {
  const blk = fixtures.parseRealBlock();
  return { header: Buffer.from(blk.header), soln: Buffer.from(blk.solution) };
}

// The real equihash200 block (mainnet 122284): 1344-byte solution, "ZcashPoW".
function real200() {
  const blk = fixtures.parseRealBlock('equihash200');
  return { header: Buffer.from(blk.header), soln: Buffer.from(blk.solution) };
}
const EQ200 = equihash.EQ200;

const tests = [
  {
    name: 'real mainnet block solution verifies with "kerrigan" personalization',
    fn() {
      const { header, soln } = realParts();
      const res = equihash.verify(header, soln, 'kerrigan');
      assert(res.ok, 'expected valid, got: ' + res.reason);
    },
  },
  {
    name: 'wrong personalization ("ZcashPoW") fails',
    fn() {
      const { header, soln } = realParts();
      assert(!equihash.verify(header, soln, 'ZcashPoW').ok);
    },
  },
  {
    name: 'single-bit mutations in solution fail',
    fn() {
      for (const byteIdx of [0, 200, 399]) {
        const { header, soln } = realParts();
        soln[byteIdx] ^= 0x01;
        assert(!equihash.verify(header, soln, 'kerrigan').ok, `mutation at byte ${byteIdx} accepted`);
      }
    },
  },
  {
    name: 'single-bit mutation in header (nonce) fails',
    fn() {
      const { header, soln } = realParts();
      header[120] ^= 0x80;
      assert(!equihash.verify(header, soln, 'kerrigan').ok);
    },
  },
  {
    name: 'index pack/unpack round-trips the real solution',
    fn() {
      const { soln } = realParts();
      const indices = equihash.unpackIndices(soln);
      assertEq(indices.length, 128);
      assert(indices.every(i => Number.isInteger(i) && i >= 0 && i < 2 ** 25), 'index range');
      assertEq(equihash.packIndices(indices), soln, 'round trip');
    },
  },
  {
    name: 'swapped adjacent indices fail (ordering rule)',
    fn() {
      const { header, soln } = realParts();
      const indices = equihash.unpackIndices(soln);
      [indices[0], indices[1]] = [indices[1], indices[0]];
      const res = equihash.verify(header, equihash.packIndices(indices), 'kerrigan');
      assert(!res.ok, 'swap accepted');
      assert(String(res.reason).includes('ordering'), 'expected ordering failure, got: ' + res.reason);
    },
  },
  {
    name: 'duplicated index fails (distinctness rule)',
    fn() {
      const { header, soln } = realParts();
      const indices = equihash.unpackIndices(soln);
      indices[1] = indices[0];
      const res = equihash.verify(header, equihash.packIndices(indices), 'kerrigan');
      assert(!res.ok, 'duplicate accepted');
    },
  },
  {
    name: 'wrong-size inputs rejected',
    fn() {
      const { header, soln } = realParts();
      assert(!equihash.verify(header.subarray(0, 139), soln, 'kerrigan').ok);
      assert(!equihash.verify(header, soln.subarray(0, 399), 'kerrigan').ok);
      assert(!equihash.verify(header, Buffer.concat([soln, Buffer.from([0])]), 'kerrigan').ok);
    },
  },
  {
    name: 'performance: average verify < 25ms',
    fn() {
      const { header, soln } = realParts();
      const t0 = process.hrtime.bigint();
      const rounds = 20;
      for (let i = 0; i < rounds; i++) {
        assert(equihash.verify(header, soln, 'kerrigan').ok);
      }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6 / rounds;
      console.log(`     (${ms.toFixed(2)} ms/verify)`);
      assert(ms < 25, `too slow: ${ms} ms`);
    },
  },
  {
    name: '200/9: real mainnet block verifies with "ZcashPoW" and the 200/9 parameters',
    fn() {
      const { header, soln } = real200();
      assertEq(soln.length, 1344);
      const res = equihash.verify(header, soln, 'ZcashPoW', EQ200);
      assert(res.ok, 'expected valid, got: ' + res.reason);
    },
  },
  {
    name: '200/9: the wrong personalization, or the other algo\'s parameters, fail',
    fn() {
      const { header, soln } = real200();
      const pers = equihash.verify(header, soln, 'kerrigan', EQ200);
      assert(!pers.ok && /collision/.test(pers.reason), JSON.stringify(pers));
      assertEq(equihash.verify(header, soln, 'ZcashPoW').reason, 'bad solution length', '192/7 params');
      const { soln: s192 } = realParts();
      assertEq(equihash.verify(header, s192, 'ZcashPoW', EQ200).reason, 'bad solution length', 'a 192/7 solution');
    },
  },
  {
    name: '200/9: single-bit mutations in solution or nonce fail',
    fn() {
      for (const byteIdx of [0, 2, 671, 1343]) {
        const { header, soln } = real200();
        soln[byteIdx] ^= 0x01;
        assert(!equihash.verify(header, soln, 'ZcashPoW', EQ200).ok, `mutation at byte ${byteIdx} accepted`);
      }
      const { header, soln } = real200();
      header[120] ^= 0x80;
      assert(!equihash.verify(header, soln, 'ZcashPoW', EQ200).ok, 'nonce mutation accepted');
    },
  },
  {
    name: 'collision prefixes are measured in bits — 200/9 boundaries land mid-byte',
    fn() {
      // First 20 bits zero, the next four set: a pass at 20 bits, which a
      // whole-byte comparison would wrongly reject.
      assert(equihash.hasZeroPrefix(Buffer.from([0x00, 0x00, 0x0f]), 20));
      assert(!equihash.hasZeroPrefix(Buffer.from([0x00, 0x00, 0x10]), 20));
      assert(equihash.hasZeroPrefix(Buffer.from([0x00, 0x00, 0x00, 0xff]), 24));
      assert(!equihash.hasZeroPrefix(Buffer.from([0x00, 0x00, 0x01]), 24));
      // 40 bits is five whole bytes; 60 ends mid-byte again.
      assert(equihash.hasZeroPrefix(Buffer.from([0, 0, 0, 0, 0, 0xff]), 40));
      assert(equihash.hasZeroPrefix(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0x0f]), 60));
      assert(!equihash.hasZeroPrefix(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0x1f]), 60));
    },
  },
  {
    name: '200/9: index pack/unpack round-trips the real solution (512 x 21-bit)',
    fn() {
      const { soln } = real200();
      const indices = equihash.unpackIndices(soln, EQ200);
      assertEq(indices.length, 512);
      assert(indices.every(i => Number.isInteger(i) && i >= 0 && i < 2 ** 21), 'index range');
      assertEq(equihash.packIndices(indices, EQ200), soln, 'round trip');
    },
  },
  {
    name: '200/9: swapped adjacent indices fail on ordering',
    fn() {
      const { header, soln } = real200();
      const indices = equihash.unpackIndices(soln, EQ200);
      [indices[0], indices[1]] = [indices[1], indices[0]];
      const res = equihash.verify(header, equihash.packIndices(indices, EQ200), 'ZcashPoW', EQ200);
      assert(!res.ok && /ordering/.test(res.reason), JSON.stringify(res));
    },
  },
  {
    name: '200/9 performance: average verify < 50ms',
    fn() {
      const { header, soln } = real200();
      const t0 = process.hrtime.bigint();
      const rounds = 20;
      for (let i = 0; i < rounds; i++) {
        assert(equihash.verify(header, soln, 'ZcashPoW', EQ200).ok);
      }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6 / rounds;
      console.log(`     (${ms.toFixed(2)} ms/verify)`);
      assert(ms < 50, `too slow: ${ms} ms`);
    },
  },
];

module.exports = { tests };
