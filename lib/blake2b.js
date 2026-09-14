'use strict';
// BLAKE2b with configurable digest length and 16-byte personalization,
// implemented on 32-bit word pairs (v[2i] = low word, v[2i+1] = high word).
// Validated against RFC 7693 vectors and python3 hashlib in the test suite.

// IV as 32-bit pairs of the SHA-512 IVs.
const IV32 = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85,
  0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c,
  0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
// 12 rounds (rounds 10/11 reuse schedules 0/1), entries doubled for pair indexing.
const SIGMA82 = new Uint8Array(
  SIGMA.concat([SIGMA[0], SIGMA[1]]).flat().map(x => x * 2)
);

// Shared scratch (single-threaded process).
const v = new Uint32Array(32);
const m = new Uint32Array(32);

// 64-bit add: v[a,a+1] += v[b,b+1]
function ADD64AA(a, b) {
  const o0 = v[a] + v[b];
  let o1 = v[a + 1] + v[b + 1];
  if (o0 >= 0x100000000) o1++;
  v[a] = o0;
  v[a + 1] = o1;
}

// 64-bit add of a constant pair: v[a,a+1] += (b1 << 32) | b0
function ADD64AC(a, b0, b1) {
  let o0 = v[a] + b0;
  if (b0 < 0) o0 += 0x100000000;
  let o1 = v[a + 1] + b1;
  if (o0 >= 0x100000000) o1++;
  v[a] = o0;
  v[a + 1] = o1;
}

function G(a, b, c, d, ix, iy) {
  const x0 = m[ix], x1 = m[ix + 1], y0 = m[iy], y1 = m[iy + 1];
  let xor0, xor1;

  ADD64AA(a, b); ADD64AC(a, x0, x1);
  xor0 = v[d] ^ v[a]; xor1 = v[d + 1] ^ v[a + 1];
  v[d] = xor1; v[d + 1] = xor0; // rotr 32

  ADD64AA(c, d);
  xor0 = v[b] ^ v[c]; xor1 = v[b + 1] ^ v[c + 1];
  v[b] = (xor0 >>> 24) ^ (xor1 << 8); v[b + 1] = (xor1 >>> 24) ^ (xor0 << 8); // rotr 24

  ADD64AA(a, b); ADD64AC(a, y0, y1);
  xor0 = v[d] ^ v[a]; xor1 = v[d + 1] ^ v[a + 1];
  v[d] = (xor0 >>> 16) ^ (xor1 << 16); v[d + 1] = (xor1 >>> 16) ^ (xor0 << 16); // rotr 16

  ADD64AA(c, d);
  xor0 = v[b] ^ v[c]; xor1 = v[b + 1] ^ v[c + 1];
  v[b] = (xor1 >>> 31) ^ (xor0 << 1); v[b + 1] = (xor0 >>> 31) ^ (xor1 << 1); // rotr 63
}

function compress(ctx, last) {
  for (let i = 0; i < 16; i++) {
    v[i] = ctx.h[i];
    v[i + 16] = IV32[i];
  }
  // t is a byte counter < 2^53; split into 32-bit halves.
  v[24] = v[24] ^ ctx.t;
  v[25] = v[25] ^ (ctx.t / 0x100000000);
  if (last) {
    v[28] = ~v[28];
    v[29] = ~v[29];
  }
  const b = ctx.b;
  for (let i = 0; i < 32; i++) {
    const o = 4 * i;
    m[i] = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
  }
  for (let r = 0; r < 12; r++) {
    const s = r * 16;
    G(0, 8, 16, 24, SIGMA82[s + 0], SIGMA82[s + 1]);
    G(2, 10, 18, 26, SIGMA82[s + 2], SIGMA82[s + 3]);
    G(4, 12, 20, 28, SIGMA82[s + 4], SIGMA82[s + 5]);
    G(6, 14, 22, 30, SIGMA82[s + 6], SIGMA82[s + 7]);
    G(0, 10, 20, 30, SIGMA82[s + 8], SIGMA82[s + 9]);
    G(2, 12, 22, 24, SIGMA82[s + 10], SIGMA82[s + 11]);
    G(4, 14, 16, 26, SIGMA82[s + 12], SIGMA82[s + 13]);
    G(6, 8, 18, 28, SIGMA82[s + 14], SIGMA82[s + 15]);
  }
  for (let i = 0; i < 16; i++) {
    ctx.h[i] = ctx.h[i] ^ v[i] ^ v[i + 16];
  }
}

// personal: exactly 16 bytes (or absent). Keys and salts are not needed here.
function createState(outlen, personal) {
  if (!Number.isInteger(outlen) || outlen < 1 || outlen > 64) {
    throw new Error('blake2b: bad digest length ' + outlen);
  }
  if (personal !== undefined && (!Buffer.isBuffer(personal) || personal.length !== 16)) {
    throw new Error('blake2b: personal must be a 16-byte Buffer');
  }
  const ctx = {
    b: new Uint8Array(128),
    h: new Uint32Array(16),
    t: 0,
    c: 0,
    outlen,
  };
  ctx.h.set(IV32);
  ctx.h[0] ^= 0x01010000 ^ outlen;
  if (personal) {
    // Parameter-block bytes 48..63 land in 64-bit words 6..7 => pairs 12..15.
    ctx.h[12] ^= personal.readUInt32LE(0);
    ctx.h[13] ^= personal.readUInt32LE(4);
    ctx.h[14] ^= personal.readUInt32LE(8);
    ctx.h[15] ^= personal.readUInt32LE(12);
  }
  return ctx;
}

function update(ctx, input) {
  for (let i = 0; i < input.length; i++) {
    if (ctx.c === 128) {
      ctx.t += ctx.c;
      compress(ctx, false);
      ctx.c = 0;
    }
    ctx.b[ctx.c++] = input[i];
  }
}

function clone(ctx) {
  return {
    b: ctx.b.slice(),
    h: ctx.h.slice(),
    t: ctx.t,
    c: ctx.c,
    outlen: ctx.outlen,
  };
}

function final(ctx) {
  ctx.t += ctx.c;
  while (ctx.c < 128) ctx.b[ctx.c++] = 0;
  compress(ctx, true);
  const out = Buffer.alloc(ctx.outlen);
  for (let i = 0; i < ctx.outlen; i++) {
    out[i] = ctx.h[i >> 2] >> (8 * (i & 3));
  }
  return out;
}

function blake2b(input, outlen, personal) {
  const ctx = createState(outlen, personal);
  update(ctx, input);
  return final(ctx);
}

module.exports = { blake2b, createState, update, clone, final };
