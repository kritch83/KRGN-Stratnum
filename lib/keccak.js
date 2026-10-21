'use strict';
// Keccak, as KawPoW needs it — nothing more:
//   keccakf800   the 32-bit-lane permutation ProgPoW uses for its seed and
//                final hash (22 rounds)
//   keccak512 / keccak256   the original Keccak (padding byte 0x01, not
//                SHA-3's 0x06) that ethash builds its light cache with
//
// JavaScript has no fast 64-bit integers, so Keccak-f1600 keeps each 64-bit
// lane as a pair of 32-bit words: s[2i] the low half, s[2i + 1] the high one.
//
// Ported from ethash (C/C++) by Pawel Bylica, Apache License 2.0 — see
// lib/LICENSE-ethash. Checked against the ProgPoW/KawPoW test vectors Kerrigan
// ships in src/crypto/ethash/progpow_test_vectors.hpp (test/kawpow.test.js).

// Rotation offset per lane (x + 5y), and where each lane lands after pi.
const RHO = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const PI = new Array(25);
for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) PI[x + 5 * y] = y + 5 * ((2 * x + 3 * y) % 5);

// Keccak-f1600 round constants as [low, high] word pairs.
const RC64 = new Uint32Array([
  0x00000001, 0x00000000, 0x00008082, 0x00000000, 0x0000808a, 0x80000000, 0x80008000, 0x80000000,
  0x0000808b, 0x00000000, 0x80000001, 0x00000000, 0x80008081, 0x80000000, 0x00008009, 0x80000000,
  0x0000008a, 0x00000000, 0x00000088, 0x00000000, 0x80008009, 0x00000000, 0x8000000a, 0x00000000,
  0x8000808b, 0x00000000, 0x0000008b, 0x80000000, 0x00008089, 0x80000000, 0x00008003, 0x80000000,
  0x00008002, 0x80000000, 0x00000080, 0x80000000, 0x0000800a, 0x00000000, 0x8000000a, 0x80000000,
  0x80008081, 0x80000000, 0x00008080, 0x80000000, 0x80000001, 0x00000000, 0x80008008, 0x80000000,
]);

// Keccak-f800 uses the low halves of the first 22.
const RC32 = new Uint32Array(22);
for (let i = 0; i < 22; i++) RC32[i] = RC64[2 * i];

// Keccak-f1600, unrolled: every half-lane lives in a local rather than an
// array slot. Written out mechanically from the same RHO/PI tables above —
// the light cache runs this over a million times per epoch, and the plain
// loop form was ten times slower.
function keccakf1600(s) {
  let a0l = s[0], a0h = s[1];
  let a1l = s[2], a1h = s[3];
  let a2l = s[4], a2h = s[5];
  let a3l = s[6], a3h = s[7];
  let a4l = s[8], a4h = s[9];
  let a5l = s[10], a5h = s[11];
  let a6l = s[12], a6h = s[13];
  let a7l = s[14], a7h = s[15];
  let a8l = s[16], a8h = s[17];
  let a9l = s[18], a9h = s[19];
  let a10l = s[20], a10h = s[21];
  let a11l = s[22], a11h = s[23];
  let a12l = s[24], a12h = s[25];
  let a13l = s[26], a13h = s[27];
  let a14l = s[28], a14h = s[29];
  let a15l = s[30], a15h = s[31];
  let a16l = s[32], a16h = s[33];
  let a17l = s[34], a17h = s[35];
  let a18l = s[36], a18h = s[37];
  let a19l = s[38], a19h = s[39];
  let a20l = s[40], a20h = s[41];
  let a21l = s[42], a21h = s[43];
  let a22l = s[44], a22h = s[45];
  let a23l = s[46], a23h = s[47];
  let a24l = s[48], a24h = s[49];
  let b0l, b0h, b1l, b1h, b2l, b2h, b3l, b3h, b4l, b4h, b5l, b5h, b6l, b6h, b7l, b7h, b8l, b8h, b9l, b9h, b10l, b10h, b11l, b11h, b12l, b12h, b13l, b13h, b14l, b14h, b15l, b15h, b16l, b16h, b17l, b17h, b18l, b18h, b19l, b19h, b20l, b20h, b21l, b21h, b22l, b22h, b23l, b23h, b24l, b24h;
  let c0l, c0h, c1l, c1h, c2l, c2h, c3l, c3h, c4l, c4h, dl, dh;
  for (let r = 0; r < 48; r += 2) {
    c0l = a0l ^ a5l ^ a10l ^ a15l ^ a20l;
    c0h = a0h ^ a5h ^ a10h ^ a15h ^ a20h;
    c1l = a1l ^ a6l ^ a11l ^ a16l ^ a21l;
    c1h = a1h ^ a6h ^ a11h ^ a16h ^ a21h;
    c2l = a2l ^ a7l ^ a12l ^ a17l ^ a22l;
    c2h = a2h ^ a7h ^ a12h ^ a17h ^ a22h;
    c3l = a3l ^ a8l ^ a13l ^ a18l ^ a23l;
    c3h = a3h ^ a8h ^ a13h ^ a18h ^ a23h;
    c4l = a4l ^ a9l ^ a14l ^ a19l ^ a24l;
    c4h = a4h ^ a9h ^ a14h ^ a19h ^ a24h;
    dl = c4l ^ ((c1l << 1) | (c1h >>> 31));
    dh = c4h ^ ((c1h << 1) | (c1l >>> 31));
    a0l ^= dl; a0h ^= dh;
    a5l ^= dl; a5h ^= dh;
    a10l ^= dl; a10h ^= dh;
    a15l ^= dl; a15h ^= dh;
    a20l ^= dl; a20h ^= dh;
    dl = c0l ^ ((c2l << 1) | (c2h >>> 31));
    dh = c0h ^ ((c2h << 1) | (c2l >>> 31));
    a1l ^= dl; a1h ^= dh;
    a6l ^= dl; a6h ^= dh;
    a11l ^= dl; a11h ^= dh;
    a16l ^= dl; a16h ^= dh;
    a21l ^= dl; a21h ^= dh;
    dl = c1l ^ ((c3l << 1) | (c3h >>> 31));
    dh = c1h ^ ((c3h << 1) | (c3l >>> 31));
    a2l ^= dl; a2h ^= dh;
    a7l ^= dl; a7h ^= dh;
    a12l ^= dl; a12h ^= dh;
    a17l ^= dl; a17h ^= dh;
    a22l ^= dl; a22h ^= dh;
    dl = c2l ^ ((c4l << 1) | (c4h >>> 31));
    dh = c2h ^ ((c4h << 1) | (c4l >>> 31));
    a3l ^= dl; a3h ^= dh;
    a8l ^= dl; a8h ^= dh;
    a13l ^= dl; a13h ^= dh;
    a18l ^= dl; a18h ^= dh;
    a23l ^= dl; a23h ^= dh;
    dl = c3l ^ ((c0l << 1) | (c0h >>> 31));
    dh = c3h ^ ((c0h << 1) | (c0l >>> 31));
    a4l ^= dl; a4h ^= dh;
    a9l ^= dl; a9h ^= dh;
    a14l ^= dl; a14h ^= dh;
    a19l ^= dl; a19h ^= dh;
    a24l ^= dl; a24h ^= dh;
    b0l = a0l; b0h = a0h;
    b10l = (a1l << 1) | (a1h >>> 31); b10h = (a1h << 1) | (a1l >>> 31);
    b20l = (a2h << 30) | (a2l >>> 2); b20h = (a2l << 30) | (a2h >>> 2);
    b5l = (a3l << 28) | (a3h >>> 4); b5h = (a3h << 28) | (a3l >>> 4);
    b15l = (a4l << 27) | (a4h >>> 5); b15h = (a4h << 27) | (a4l >>> 5);
    b16l = (a5h << 4) | (a5l >>> 28); b16h = (a5l << 4) | (a5h >>> 28);
    b1l = (a6h << 12) | (a6l >>> 20); b1h = (a6l << 12) | (a6h >>> 20);
    b11l = (a7l << 6) | (a7h >>> 26); b11h = (a7h << 6) | (a7l >>> 26);
    b21l = (a8h << 23) | (a8l >>> 9); b21h = (a8l << 23) | (a8h >>> 9);
    b6l = (a9l << 20) | (a9h >>> 12); b6h = (a9h << 20) | (a9l >>> 12);
    b7l = (a10l << 3) | (a10h >>> 29); b7h = (a10h << 3) | (a10l >>> 29);
    b17l = (a11l << 10) | (a11h >>> 22); b17h = (a11h << 10) | (a11l >>> 22);
    b2l = (a12h << 11) | (a12l >>> 21); b2h = (a12l << 11) | (a12h >>> 21);
    b12l = (a13l << 25) | (a13h >>> 7); b12h = (a13h << 25) | (a13l >>> 7);
    b22l = (a14h << 7) | (a14l >>> 25); b22h = (a14l << 7) | (a14h >>> 25);
    b23l = (a15h << 9) | (a15l >>> 23); b23h = (a15l << 9) | (a15h >>> 23);
    b8l = (a16h << 13) | (a16l >>> 19); b8h = (a16l << 13) | (a16h >>> 19);
    b18l = (a17l << 15) | (a17h >>> 17); b18h = (a17h << 15) | (a17l >>> 17);
    b3l = (a18l << 21) | (a18h >>> 11); b3h = (a18h << 21) | (a18l >>> 11);
    b13l = (a19l << 8) | (a19h >>> 24); b13h = (a19h << 8) | (a19l >>> 24);
    b14l = (a20l << 18) | (a20h >>> 14); b14h = (a20h << 18) | (a20l >>> 14);
    b24l = (a21l << 2) | (a21h >>> 30); b24h = (a21h << 2) | (a21l >>> 30);
    b9l = (a22h << 29) | (a22l >>> 3); b9h = (a22l << 29) | (a22h >>> 3);
    b19l = (a23h << 24) | (a23l >>> 8); b19h = (a23l << 24) | (a23h >>> 8);
    b4l = (a24l << 14) | (a24h >>> 18); b4h = (a24h << 14) | (a24l >>> 18);
    a0l = b0l ^ (~b1l & b2l); a0h = b0h ^ (~b1h & b2h);
    a1l = b1l ^ (~b2l & b3l); a1h = b1h ^ (~b2h & b3h);
    a2l = b2l ^ (~b3l & b4l); a2h = b2h ^ (~b3h & b4h);
    a3l = b3l ^ (~b4l & b0l); a3h = b3h ^ (~b4h & b0h);
    a4l = b4l ^ (~b0l & b1l); a4h = b4h ^ (~b0h & b1h);
    a5l = b5l ^ (~b6l & b7l); a5h = b5h ^ (~b6h & b7h);
    a6l = b6l ^ (~b7l & b8l); a6h = b6h ^ (~b7h & b8h);
    a7l = b7l ^ (~b8l & b9l); a7h = b7h ^ (~b8h & b9h);
    a8l = b8l ^ (~b9l & b5l); a8h = b8h ^ (~b9h & b5h);
    a9l = b9l ^ (~b5l & b6l); a9h = b9h ^ (~b5h & b6h);
    a10l = b10l ^ (~b11l & b12l); a10h = b10h ^ (~b11h & b12h);
    a11l = b11l ^ (~b12l & b13l); a11h = b11h ^ (~b12h & b13h);
    a12l = b12l ^ (~b13l & b14l); a12h = b12h ^ (~b13h & b14h);
    a13l = b13l ^ (~b14l & b10l); a13h = b13h ^ (~b14h & b10h);
    a14l = b14l ^ (~b10l & b11l); a14h = b14h ^ (~b10h & b11h);
    a15l = b15l ^ (~b16l & b17l); a15h = b15h ^ (~b16h & b17h);
    a16l = b16l ^ (~b17l & b18l); a16h = b16h ^ (~b17h & b18h);
    a17l = b17l ^ (~b18l & b19l); a17h = b17h ^ (~b18h & b19h);
    a18l = b18l ^ (~b19l & b15l); a18h = b18h ^ (~b19h & b15h);
    a19l = b19l ^ (~b15l & b16l); a19h = b19h ^ (~b15h & b16h);
    a20l = b20l ^ (~b21l & b22l); a20h = b20h ^ (~b21h & b22h);
    a21l = b21l ^ (~b22l & b23l); a21h = b21h ^ (~b22h & b23h);
    a22l = b22l ^ (~b23l & b24l); a22h = b22h ^ (~b23h & b24h);
    a23l = b23l ^ (~b24l & b20l); a23h = b23h ^ (~b24h & b20h);
    a24l = b24l ^ (~b20l & b21l); a24h = b24h ^ (~b20h & b21h);
    a0l ^= RC64[r]; a0h ^= RC64[r + 1];
  }
  s[0] = a0l; s[1] = a0h;
  s[2] = a1l; s[3] = a1h;
  s[4] = a2l; s[5] = a2h;
  s[6] = a3l; s[7] = a3h;
  s[8] = a4l; s[9] = a4h;
  s[10] = a5l; s[11] = a5h;
  s[12] = a6l; s[13] = a6h;
  s[14] = a7l; s[15] = a7h;
  s[16] = a8l; s[17] = a8h;
  s[18] = a9l; s[19] = a9h;
  s[20] = a10l; s[21] = a10h;
  s[22] = a11l; s[23] = a11h;
  s[24] = a12l; s[25] = a12h;
  s[26] = a13l; s[27] = a13h;
  s[28] = a14l; s[29] = a14h;
  s[30] = a15l; s[31] = a15h;
  s[32] = a16l; s[33] = a16h;
  s[34] = a17l; s[35] = a17h;
  s[36] = a18l; s[37] = a18h;
  s[38] = a19l; s[39] = a19h;
  s[40] = a20l; s[41] = a20h;
  s[42] = a21l; s[43] = a21h;
  s[44] = a22l; s[45] = a22h;
  s[46] = a23l; s[47] = a23h;
  s[48] = a24l; s[49] = a24h;
}

const B32 = new Uint32Array(25);
const C32 = new Uint32Array(5);

function rotl32(x, n) {
  return n === 0 ? x : ((x << n) | (x >>> (32 - n))) >>> 0;
}

// state: Uint32Array(25), permuted in place.
function keccakf800(s) {
  for (let round = 0; round < 22; round++) {
    for (let x = 0; x < 5; x++) C32[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = C32[(x + 4) % 5] ^ rotl32(C32[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    for (let i = 0; i < 25; i++) B32[PI[i]] = rotl32(s[i], RHO[i] % 32);
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) s[x + y] = B32[x + y] ^ (~B32[((x + 1) % 5) + y] & B32[((x + 2) % 5) + y]);
    }
    s[0] ^= RC32[round];
  }
}

// The original Keccak sponge over 64-bit LE words. `rateWords` is the block
// size in 64-bit words: 9 for keccak512, 17 for keccak256.
const S64 = new Uint32Array(50);
function sponge(bytes, rateWords, outWords) {
  S64.fill(0);
  const rateBytes = rateWords * 8;
  const padded = Buffer.alloc((Math.floor(bytes.length / rateBytes) + 1) * rateBytes);
  bytes.copy ? bytes.copy(padded) : padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  for (let off = 0; off < padded.length; off += rateBytes) {
    for (let w = 0; w < rateWords; w++) {
      S64[2 * w] ^= padded.readUInt32LE(off + 8 * w);
      S64[2 * w + 1] ^= padded.readUInt32LE(off + 8 * w + 4);
    }
    keccakf1600(S64);
  }
  const out = Buffer.alloc(outWords * 4);
  for (let i = 0; i < outWords; i++) out.writeUInt32LE(S64[i], 4 * i);
  return out;
}

function keccak512(bytes) { return sponge(bytes, 9, 16); }
function keccak256(bytes) { return sponge(bytes, 17, 8); }

// keccak512 of exactly 64 bytes given as 16 LE words, written to out[outOff..].
// The light cache calls this millions of times per epoch, so it skips the
// Buffer round trip: 64 bytes fill one 72-byte block, with the padding byte at
// offset 64 and the closing bit in the last byte of the block (word 8 both).
function keccak512Words(inp, inOff, out, outOff) {
  S64.fill(0);
  for (let i = 0; i < 16; i++) S64[i] = inp[inOff + i];
  S64[16] = 0x00000001;
  S64[17] = 0x80000000;
  keccakf1600(S64);
  for (let i = 0; i < 16; i++) out[outOff + i] = S64[i];
}

module.exports = { keccakf800, keccakf1600, keccak512, keccak256, keccak512Words };
