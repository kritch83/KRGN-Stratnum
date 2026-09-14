'use strict';
const { execFileSync } = require('child_process');
const { assert, assertEq } = require('./t');
const { blake2b, createState, update, clone, final } = require('../lib/blake2b');
const equihash = require('../lib/equihash');

// Deterministic PRNG for the python cross-check sweep.
function xorshift32(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

const tests = [
  {
    name: 'RFC 7693 "abc" vector (64-byte digest)',
    fn() {
      assertEq(
        blake2b(Buffer.from('abc'), 64).toString('hex'),
        'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1' +
        '7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923'
      );
    },
  },
  {
    name: 'empty input vector (64-byte digest)',
    fn() {
      assertEq(
        blake2b(Buffer.alloc(0), 64).toString('hex'),
        '786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419' +
        'd25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce'
      );
    },
  },
  {
    name: 'streaming/clone equals one-shot across block boundary',
    fn() {
      const data = Buffer.alloc(300);
      for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 13) & 0xff;
      const oneShot = blake2b(data, 48);
      const st = createState(48);
      update(st, data.subarray(0, 100));
      const branch = clone(st);
      update(st, data.subarray(100));
      update(branch, data.subarray(100));
      assertEq(final(st), oneShot, 'streamed');
      assertEq(final(branch), oneShot, 'cloned branch');
    },
  },
  {
    name: 'python3 hashlib cross-check (64 cases incl. kerrigan personalization)',
    fn() {
      const person = equihash.personalization('kerrigan');
      assertEq(person.toString('hex'), '6b6572726967616ec000000007000000', 'kerrigan person bytes');

      const rnd = xorshift32(0xdecafbad);
      const cases = [];
      for (let i = 0; i < 64; i++) {
        const len = rnd() % 301;
        const data = Buffer.alloc(len);
        for (let j = 0; j < len; j++) data[j] = rnd() & 0xff;
        const outlen = [32, 48, 64][i % 3];
        const usePerson = i % 2 === 1;
        cases.push({ data, outlen, usePerson });
      }

      const script = [
        'import sys, hashlib',
        'for line in sys.stdin:',
        '    hexdata, outlen, pers = line.strip().split(",")',
        '    kw = {"digest_size": int(outlen)}',
        '    if pers: kw["person"] = bytes.fromhex(pers)',
        '    print(hashlib.blake2b(bytes.fromhex(hexdata), **kw).hexdigest())',
      ].join('\n');

      const input = cases
        .map(c => `${c.data.toString('hex')},${c.outlen},${c.usePerson ? person.toString('hex') : ''}`)
        .join('\n') + '\n';

      let out;
      try {
        out = execFileSync('python3', ['-c', script], { input, timeout: 30000 }).toString().trim();
      } catch {
        console.log('     (python3 unavailable — skipping cross-check)');
        return 'skip';
      }
      const expected = out.split('\n');
      assertEq(expected.length, cases.length, 'python output count');
      cases.forEach((c, i) => {
        const got = blake2b(c.data, c.outlen, c.usePerson ? person : undefined).toString('hex');
        assertEq(got, expected[i], `case ${i} (len=${c.data.length} out=${c.outlen} pers=${c.usePerson})`);
      });
    },
  },
];

module.exports = { tests };
