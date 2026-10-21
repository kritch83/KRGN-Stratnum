'use strict';
// KawPoW — Ravencoin's ProgPoW 0.9.4 variant, which Kerrigan uses unchanged —
// for verifying shares in pure JavaScript.
//
//   buildContext(epoch)   the ethash light cache for an epoch (~18 MB at
//                         Kerrigan's current height) plus its 16 KB L1 slice.
//                         A few seconds of work, once every 7500 blocks.
//   hash(ctx, height, headerHash, nonce)   -> { finalHash, mixHash }
//                         the full computation: what a miner's GPU does, done
//                         once to check one share (~tens of ms).
//   finalHash(height, headerHash, mixHash, nonce)
//                         the cheap last step alone (no DAG) — what the node
//                         itself compares to the target, trusting the mix.
//
// Byte order: headerHash, mixHash and finalHash are ethash `hash256` bytes —
// big-endian, the order miners send and the order the node's hex shows. A
// 256-bit value compares as these bytes read big-endian.
//
// Ported from ethash (C/C++) by Pawel Bylica, Apache License 2.0 — see
// lib/LICENSE-ethash. Checked against the test vectors Kerrigan ships in
// src/crypto/ethash/progpow_test_vectors.hpp, and against real Kerrigan
// KawPoW blocks (test/kawpow.test.js).

const { keccakf800, keccak256, keccak512Words } = require('./keccak');

const EPOCH_LENGTH = 7500;
const PERIOD_LENGTH = 3;
const NUM_REGS = 32;
const NUM_LANES = 16;
const NUM_CACHE_ACCESSES = 11;
const NUM_MATH_OPERATIONS = 18;
const L1_CACHE_WORDS = 4096;                // 16 KB
const DATASET_PARENTS = 512;
const LIGHT_CACHE_INIT = 1 << 24;
const LIGHT_CACHE_GROWTH = 1 << 17;
const LIGHT_CACHE_ROUNDS = 3;
const FULL_DATASET_INIT = 2 ** 30;
const FULL_DATASET_GROWTH = 1 << 23;

const FNV_PRIME = 0x01000193;
const FNV_OFFSET = 0x811c9dc5;

// "rAVENCOINKAWPOW", one character per word: KawPoW's Keccak padding.
const RAVENCOIN_KAWPOW = [0x72, 0x41, 0x56, 0x45, 0x4e, 0x43, 0x4f, 0x49, 0x4e, 0x4b, 0x41, 0x57, 0x50, 0x4f, 0x57];

const fnv1 = (u, v) => (Math.imul(u, FNV_PRIME) ^ v) >>> 0;
const fnv1a = (u, v) => Math.imul(u ^ v, FNV_PRIME) >>> 0;
const rotl32 = (x, n) => { n &= 31; return n ? ((x << n) | (x >>> (32 - n))) >>> 0 : x >>> 0; };
const rotr32 = (x, n) => { n &= 31; return n ? ((x >>> n) | (x << (32 - n))) >>> 0 : x >>> 0; };

function popcount32(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

// High 32 bits of a 32x32 multiply, from 16-bit halves (exact, no BigInt).
function mulHi32(a, b) {
  const a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16;
  const lo = a0 * b0;
  const m1 = a1 * b0;
  const m2 = a0 * b1;
  const carry = ((lo >>> 16) + (m1 & 0xffff) + (m2 & 0xffff)) >>> 16;
  return (a1 * b1 + (m1 >>> 16) + (m2 >>> 16) + carry) >>> 0;
}

// ---- epoch parameters ----

function epochOf(height) {
  return Math.floor(height / EPOCH_LENGTH);
}

function largestPrimeAtMost(n) {
  if (n < 2) return 0;
  if (n === 2) return 2;
  if (n % 2 === 0) n--;
  for (;; n -= 2) {
    let prime = true;
    for (let d = 3; d * d <= n; d += 2) if (n % d === 0) { prime = false; break; }
    if (prime) return n;
  }
}

function lightCacheItems(epoch) {
  return largestPrimeAtMost(LIGHT_CACHE_INIT / 64 + epoch * (LIGHT_CACHE_GROWTH / 64));
}

function fullDatasetItems(epoch) {
  return largestPrimeAtMost(FULL_DATASET_INIT / 128 + epoch * (FULL_DATASET_GROWTH / 128));
}

// keccak256 applied `epoch` times to 32 zero bytes. This is also the seed hash
// KawPoW miners are sent, in this byte order.
function epochSeed(epoch) {
  let s = Buffer.alloc(32);
  for (let i = 0; i < epoch; i++) s = keccak256(s);
  return s;
}

// ---- light cache and dataset items ----

// 512-bit dataset item `index`, computed from the light cache (512 parents),
// written as 16 words to out[outOff..].
const itemMix = new Uint32Array(16);
function datasetItem512(cache, numItems, index, out, outOff) {
  const seed = index >>> 0;
  const base = (index % numItems) * 16;
  for (let i = 0; i < 16; i++) itemMix[i] = cache[base + i];
  itemMix[0] ^= seed;
  keccak512Words(itemMix, 0, itemMix, 0);
  for (let j = 0; j < DATASET_PARENTS; j++) {
    const parent = (fnv1(seed ^ j, itemMix[j & 15]) % numItems) * 16;
    for (let i = 0; i < 16; i++) itemMix[i] = fnv1(itemMix[i], cache[parent + i]);
  }
  keccak512Words(itemMix, 0, out, outOff);
}

// A 2048-bit item (four 512-bit ones): what each ProgPoW round loads.
function datasetItem2048(ctx, index, out) {
  for (let k = 0; k < 4; k++) datasetItem512(ctx.cache, ctx.cacheItems, index * 4 + k, out, k * 16);
}

// The light cache alone: the expensive part (a few seconds), and the only part
// worth saving to disk. `onProgress`, if given, gets a 0..1 fraction.
function buildLightCache(epoch, onProgress) {
  const n = lightCacheItems(epoch);
  const cache = new Uint32Array(n * 16);
  const seed = epochSeed(epoch);
  const tmp = new Uint32Array(16);
  // A 32-byte seed is a different keccak512 input size than a cache item, so
  // the first item goes through the general path.
  const first = require('./keccak').keccak512(seed);
  for (let i = 0; i < 16; i++) cache[i] = first.readUInt32LE(4 * i);
  for (let i = 1; i < n; i++) keccak512Words(cache, (i - 1) * 16, cache, i * 16);
  if (onProgress) onProgress(0.25);
  for (let round = 0; round < LIGHT_CACHE_ROUNDS; round++) {
    for (let i = 0; i < n; i++) {
      const v = (cache[i * 16] % n) * 16;
      const w = ((n + i - 1) % n) * 16;
      for (let j = 0; j < 16; j++) tmp[j] = cache[v + j] ^ cache[w + j];
      keccak512Words(tmp, 0, cache, i * 16);
    }
    if (onProgress) onProgress(0.25 + 0.25 * (round + 1));
  }
  return cache;
}

// An epoch context from a light cache — built just now or loaded from disk.
// Derives the L1 cache from it (~tens of ms).
function contextFromCache(epoch, cache) {
  const n = lightCacheItems(epoch);
  if (!(cache instanceof Uint32Array) || cache.length !== n * 16) {
    throw new Error(`kawpow: light cache for epoch ${epoch} must be ${n * 16} words`);
  }
  const ctx = { epoch, cacheItems: n, cache, fullItems: fullDatasetItems(epoch), l1: new Uint32Array(L1_CACHE_WORDS) };
  // The L1 cache is the first 16 KB of the full dataset: 64 2048-bit items.
  const item = new Uint32Array(64);
  for (let i = 0; i < L1_CACHE_WORDS / 64; i++) {
    datasetItem2048(ctx, i, item);
    ctx.l1.set(item, i * 64);
  }
  return ctx;
}

function buildContext(epoch, onProgress) {
  return contextFromCache(epoch, buildLightCache(epoch, onProgress));
}

// ---- KISS99 and the per-period program ----

function kiss99(z, w, jsr, jcong) {
  return {
    z, w, jsr, jcong,
    next() {
      this.z = (36969 * (this.z & 0xffff) + (this.z >>> 16)) >>> 0;
      this.w = (18000 * (this.w & 0xffff) + (this.w >>> 16)) >>> 0;
      this.jcong = (Math.imul(69069, this.jcong) + 1234567) >>> 0;
      let j = this.jsr;
      j = (j ^ (j << 17)) >>> 0;
      j = (j ^ (j >>> 13)) >>> 0;
      j = (j ^ (j << 5)) >>> 0;
      this.jsr = j;
      return ((((((this.z << 16) >>> 0) + this.w) >>> 0) ^ this.jcong) + this.jsr) >>> 0;
    },
  };
}

// ProgPoW hands every one of the 64 rounds a fresh copy of the same random
// state, so all 64 run the same "program"; only the data differs. Generating
// it once per 3-block period and replaying it is exactly equivalent.
const programCache = new Map();
function programFor(height) {
  const number = Math.floor(height / PERIOD_LENGTH);
  if (programCache.has(number)) return programCache.get(number);
  const lo = number >>> 0;
  const hi = Math.floor(number / 2 ** 32) >>> 0;
  const z = fnv1a(FNV_OFFSET, lo);
  const w = fnv1a(z, hi);
  const jsr = fnv1a(w, lo);
  const jcong = fnv1a(jsr, hi);
  const rng = kiss99(z, w, jsr, jcong);
  const dstSeq = [];
  const srcSeq = [];
  for (let i = 0; i < NUM_REGS; i++) { dstSeq.push(i); srcSeq.push(i); }
  for (let i = NUM_REGS; i > 1; i--) {
    let j = rng.next() % i;
    [dstSeq[i - 1], dstSeq[j]] = [dstSeq[j], dstSeq[i - 1]];
    j = rng.next() % i;
    [srcSeq[i - 1], srcSeq[j]] = [srcSeq[j], srcSeq[i - 1]];
  }
  let dstCounter = 0;
  let srcCounter = 0;
  const nextDst = () => dstSeq[(dstCounter++) % NUM_REGS];
  const nextSrc = () => srcSeq[(srcCounter++) % NUM_REGS];
  // Interleaved exactly as the reference loop draws its random numbers.
  const ops = [];
  for (let i = 0; i < Math.max(NUM_CACHE_ACCESSES, NUM_MATH_OPERATIONS); i++) {
    if (i < NUM_CACHE_ACCESSES) {
      const src = nextSrc();
      const dst = nextDst();
      const sel = rng.next();
      ops.push({ cache: true, src, dst, sel });
    }
    if (i < NUM_MATH_OPERATIONS) {
      const srcRnd = rng.next() % (NUM_REGS * (NUM_REGS - 1));
      const src1 = srcRnd % NUM_REGS;
      let src2 = Math.floor(srcRnd / NUM_REGS);
      if (src2 >= src1) src2++;
      const sel1 = rng.next();
      const dst = nextDst();
      const sel2 = rng.next();
      ops.push({ cache: false, src1, src2, sel1, dst, sel2 });
    }
  }
  const dsts = [];
  const sels = [];
  for (let i = 0; i < 4; i++) {
    dsts.push(i === 0 ? 0 : nextDst());
    sels.push(rng.next());
  }
  const program = { ops, dsts, sels };
  programCache.set(number, program);
  if (programCache.size > 8) programCache.delete(programCache.keys().next().value);
  return program;
}

function randomMath(a, b, sel) {
  switch (sel % 11) {
    case 0: return (a + b) >>> 0;
    case 1: return Math.imul(a, b) >>> 0;
    case 2: return mulHi32(a, b);
    case 3: return a < b ? a : b;
    case 4: return rotl32(a, b);
    case 5: return rotr32(a, b);
    case 6: return (a & b) >>> 0;
    case 7: return (a | b) >>> 0;
    case 8: return (a ^ b) >>> 0;
    case 9: return Math.clz32(a) + Math.clz32(b);
    default: return popcount32(a) + popcount32(b);
  }
}

function randomMerge(a, b, sel) {
  const x = ((sel >>> 16) % 31) + 1;
  switch (sel % 4) {
    case 0: return (Math.imul(a, 33) + b) >>> 0;
    case 1: return Math.imul(a ^ b, 33) >>> 0;
    case 2: return (rotl32(a, x) ^ b) >>> 0;
    default: return (rotr32(a, x) ^ b) >>> 0;
  }
}

// ---- the hash ----

function initMix(seed0, seed1) {
  const mix = new Uint32Array(NUM_LANES * NUM_REGS);
  const z = fnv1a(FNV_OFFSET, seed0);
  const w = fnv1a(z, seed1);
  for (let l = 0; l < NUM_LANES; l++) {
    const jsr = fnv1a(w, l);
    const jcong = fnv1a(jsr, l);
    const rng = kiss99(z, w, jsr, jcong);
    for (let r = 0; r < NUM_REGS; r++) mix[l * NUM_REGS + r] = rng.next();
  }
  return mix;
}

const roundItem = new Uint32Array(64);
function hashMix(ctx, height, seed0, seed1) {
  const mix = initMix(seed0, seed1);
  const { ops, dsts, sels } = programFor(height);
  const numItems = Math.floor(ctx.fullItems / 2);
  const l1 = ctx.l1;
  for (let r = 0; r < 64; r++) {
    datasetItem2048(ctx, mix[(r % NUM_LANES) * NUM_REGS] % numItems, roundItem);
    for (const op of ops) {
      if (op.cache) {
        for (let l = 0; l < NUM_LANES; l++) {
          const base = l * NUM_REGS;
          mix[base + op.dst] = randomMerge(mix[base + op.dst], l1[mix[base + op.src] % L1_CACHE_WORDS], op.sel);
        }
      } else {
        for (let l = 0; l < NUM_LANES; l++) {
          const base = l * NUM_REGS;
          const data = randomMath(mix[base + op.src1], mix[base + op.src2], op.sel1);
          mix[base + op.dst] = randomMerge(mix[base + op.dst], data, op.sel2);
        }
      }
    }
    for (let l = 0; l < NUM_LANES; l++) {
      const base = l * NUM_REGS;
      const offset = ((l ^ r) % NUM_LANES) * 4;
      for (let i = 0; i < 4; i++) mix[base + dsts[i]] = randomMerge(mix[base + dsts[i]], roundItem[offset + i], sels[i]);
    }
  }
  const words = new Uint32Array(8).fill(FNV_OFFSET);
  for (let l = 0; l < NUM_LANES; l++) {
    let laneHash = FNV_OFFSET;
    for (let i = 0; i < NUM_REGS; i++) laneHash = fnv1a(laneHash, mix[l * NUM_REGS + i]);
    words[l % 8] = fnv1a(words[l % 8], laneHash);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) out.writeUInt32LE(words[i], 4 * i);
  return out;
}

// Keccak-f800 over header hash + nonce, with the KawPoW padding: the seed of
// everything after it.
function seedState(headerHash, nonce) {
  const st = new Uint32Array(25);
  for (let i = 0; i < 8; i++) st[i] = headerHash.readUInt32LE(4 * i);
  st[8] = Number(nonce & 0xffffffffn);
  st[9] = Number(nonce >> 32n);
  for (let i = 10; i < 25; i++) st[i] = RAVENCOIN_KAWPOW[i - 10];
  keccakf800(st);
  return st.subarray(0, 8).slice();
}

function finalFrom(state2, mixHash) {
  const st = new Uint32Array(25);
  for (let i = 0; i < 8; i++) st[i] = state2[i];
  for (let i = 0; i < 8; i++) st[8 + i] = mixHash.readUInt32LE(4 * i);
  for (let i = 16; i < 25; i++) st[i] = RAVENCOIN_KAWPOW[i - 16];
  keccakf800(st);
  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) out.writeUInt32LE(st[i], 4 * i);
  return out;
}

function checkInputs(headerHash, nonce) {
  if (!Buffer.isBuffer(headerHash) || headerHash.length !== 32) throw new Error('kawpow: header hash must be 32 bytes');
  if (typeof nonce !== 'bigint' || nonce < 0n || nonce > 0xffffffffffffffffn) throw new Error('kawpow: nonce must be a u64 BigInt');
}

// The full computation: the mix a miner should have produced, and its final hash.
function hash(ctx, height, headerHash, nonce) {
  checkInputs(headerHash, nonce);
  if (epochOf(height) !== ctx.epoch) throw new Error(`kawpow: height ${height} is epoch ${epochOf(height)}, context is ${ctx.epoch}`);
  const state2 = seedState(headerHash, nonce);
  const mixHash = hashMix(ctx, height, state2[0], state2[1]);
  return { finalHash: finalFrom(state2, mixHash), mixHash };
}

// The cheap last step alone: final hash from a claimed mix, no DAG. This is
// what the node compares to the target; it is only meaningful once the mix
// itself has been checked.
function finalHash(height, headerHash, mixHash, nonce) {
  checkInputs(headerHash, nonce);
  if (!Buffer.isBuffer(mixHash) || mixHash.length !== 32) throw new Error('kawpow: mix hash must be 32 bytes');
  return finalFrom(seedState(headerHash, nonce), mixHash);
}

module.exports = {
  EPOCH_LENGTH, epochOf, epochSeed, lightCacheItems, fullDatasetItems,
  buildContext, buildLightCache, contextFromCache, hash, finalHash,
  // exported for the tests
  _mulHi32: mulHi32, _popcount32: popcount32,
};
