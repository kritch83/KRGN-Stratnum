'use strict';
// Equihash solution verifier — a pure-JS port of the semantics of zcash's
// Equihash<N,K>::IsValidSolution (as used by kerrigan's equihashverify).
//
// Parameterised over (N, K) because Kerrigan offers two equihash algos:
//   192/7 — 24-bit collisions, byte-aligned
//   200/9 — 20-bit collisions, NOT byte-aligned
// The collision test therefore works in BITS rather than bytes. For 192/7 that
// is exactly equivalent to the old whole-byte comparison, so the mainnet-block
// oracle still pins this file's behaviour.

const b2b = require('./blake2b');

// Every derived constant for one parameter set, computed once and frozen.
function params(N, K) {
  if (!Number.isInteger(N) || !Number.isInteger(K) || K < 1 || K > 16) {
    throw new Error(`equihash: bad parameters ${N}/${K}`);
  }
  const COLLISION_BITS = N / (K + 1);
  if (!Number.isInteger(COLLISION_BITS)) throw new Error(`equihash: N/(K+1) is not an integer for ${N}/${K}`);
  if (N % 8 !== 0) throw new Error(`equihash: N must be a multiple of 8, got ${N}`);
  const INDICES = 1 << K;                          // 128 (192/7) | 512 (200/9)
  const INDEX_BITS = COLLISION_BITS + 1;           // 25 | 21
  const HASH_LEN = N / 8;                          // 24 | 25 bytes per leaf
  const INDICES_PER_HASH = Math.floor(512 / N);    // 2 for both
  const DIGEST_LEN = INDICES_PER_HASH * HASH_LEN;  // 48 | 50
  const solnBits = INDICES * INDEX_BITS;
  if (solnBits % 8 !== 0) throw new Error(`equihash: solution is not a whole number of bytes for ${N}/${K}`);
  const SOLUTION_BYTES = solnBits / 8;             // 400 | 1344
  return Object.freeze({
    N, K, INDICES, COLLISION_BITS, INDEX_BITS, HASH_LEN, INDICES_PER_HASH,
    DIGEST_LEN, SOLUTION_BYTES,
    // CompactSize length prefix the wire format carries ahead of the solution.
    SOLUTION_PREFIX: compactSize(SOLUTION_BYTES),
    NAME: `${N}_${K}`,
  });
}

// CompactSize for the solution length: 'fd9001' (400) | 'fd4005' (1344).
function compactSize(n) {
  if (n < 0xfd) return Buffer.from([n]).toString('hex');
  if (n <= 0xffff) return 'fd' + Buffer.from([n & 0xff, (n >> 8) & 0xff]).toString('hex');
  throw new Error('equihash: solution too large for a 3-byte CompactSize');
}

const EQ192 = params(192, 7);
const EQ200 = params(200, 9);

// 16-byte blake2b personal field: 8-char ASCII string + LE32(N) + LE32(K).
function personalization(persString, p = EQ192) {
  if (typeof persString !== 'string' || persString.length !== 8) {
    throw new Error('equihash: personalization string must be exactly 8 chars, got ' + JSON.stringify(persString));
  }
  const buf = Buffer.alloc(16);
  buf.write(persString, 0, 'ascii');
  buf.writeUInt32LE(p.N, 8);
  buf.writeUInt32LE(p.K, 12);
  return buf;
}

// INDICES x INDEX_BITS big-endian values, MSB-first bit stream. The accumulator
// can reach 2^32, so Number arithmetic is used instead of int32 shift operators.
function unpackIndices(soln, p = EQ192) {
  const out = new Array(p.INDICES);
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (let i = 0; i < soln.length; i++) {
    acc = acc * 256 + soln[i];
    bits += 8;
    while (bits >= p.INDEX_BITS) {
      const shift = 2 ** (bits - p.INDEX_BITS);
      out[n++] = Math.floor(acc / shift);
      acc %= shift;
      bits -= p.INDEX_BITS;
    }
  }
  return out;
}

// Inverse of unpackIndices (used by tests to construct invalid solutions).
function packIndices(indices, p = EQ192) {
  const out = Buffer.alloc(p.SOLUTION_BYTES);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const idx of indices) {
    acc = acc * (2 ** p.INDEX_BITS) + idx;
    bits += p.INDEX_BITS;
    while (bits >= 8) {
      const shift = 2 ** (bits - 8);
      out[o++] = Math.floor(acc / shift);
      acc %= shift;
      bits -= 8;
    }
  }
  return out;
}

// Are the first `bits` bits of buf zero? At 20-bit collisions the boundary
// lands mid-byte, so the trailing partial byte is masked rather than compared
// whole — comparing whole bytes there would reject valid solutions.
function hasZeroPrefix(buf, bits) {
  const whole = bits >> 3;
  for (let i = 0; i < whole; i++) if (buf[i] !== 0) return false;
  const rem = bits & 7;
  return rem === 0 || (buf[whole] >> (8 - rem)) === 0;
}

// header: exactly 140 bytes; soln: p.SOLUTION_BYTES (no CompactSize prefix);
// persString: 8-char ASCII (e.g. "kerrigan"). Returns { ok, reason? }.
function verify(header, soln, persString, p = EQ192) {
  if (!Buffer.isBuffer(header) || header.length !== 140) return { ok: false, reason: 'bad header length' };
  if (!Buffer.isBuffer(soln) || soln.length !== p.SOLUTION_BYTES) return { ok: false, reason: 'bad solution length' };

  const indices = unpackIndices(soln, p);
  if (new Set(indices).size !== p.INDICES) return { ok: false, reason: 'duplicate indices' };

  const base = b2b.createState(p.DIGEST_LEN, personalization(persString, p));
  b2b.update(base, header);

  // Leaves: blake2b(header || LE32(idx / INDICES_PER_HASH)), sliced into halves.
  const digestCache = new Map();
  const le = Buffer.alloc(4);
  let level = new Array(p.INDICES);
  for (let i = 0; i < p.INDICES; i++) {
    const idx = indices[i];
    const j = (idx - (idx % p.INDICES_PER_HASH)) / p.INDICES_PER_HASH;
    let digest = digestCache.get(j);
    if (!digest) {
      const st = b2b.clone(base);
      le.writeUInt32LE(j, 0);
      b2b.update(st, le);
      digest = b2b.final(st);
      digestCache.set(j, digest);
    }
    const off = (idx % p.INDICES_PER_HASH) * p.HASH_LEN;
    level[i] = { xor: Buffer.from(digest.subarray(off, off + p.HASH_LEN)), min: idx };
  }

  // K merge levels: growing zero prefix on the pair XOR, ordering by the
  // first index of each subtree, full-zero XOR at the top.
  for (let mLevel = 1; mLevel <= p.K; mLevel++) {
    const zeroBits = mLevel < p.K ? p.COLLISION_BITS * mLevel : p.HASH_LEN * 8;
    const next = new Array(level.length / 2);
    for (let q = 0; q < level.length; q += 2) {
      const L = level[q];
      const R = level[q + 1];
      if (!(L.min < R.min)) return { ok: false, reason: 'index ordering at level ' + mLevel };
      const x = Buffer.alloc(p.HASH_LEN);
      for (let byte = 0; byte < p.HASH_LEN; byte++) x[byte] = L.xor[byte] ^ R.xor[byte];
      if (!hasZeroPrefix(x, zeroBits)) return { ok: false, reason: 'collision failure at level ' + mLevel };
      next[q / 2] = { xor: x, min: L.min };
    }
    level = next;
  }
  return { ok: true };
}

module.exports = {
  verify, unpackIndices, packIndices, personalization, hasZeroPrefix, params,
  EQ192, EQ200,
  // Back-compat aliases: the 192/7 constants callers already import by name.
  N: EQ192.N, K: EQ192.K, INDICES: EQ192.INDICES,
  SOLUTION_BYTES: EQ192.SOLUTION_BYTES, DIGEST_LEN: EQ192.DIGEST_LEN,
};
