'use strict';
// Byte-level and BigInt helpers. All consensus-critical conversions live here
// so the test suite can pin them down against the real mainnet block.

const crypto = require('crypto');

// Pool difficulty-1 targets, one per equihash parameter set. They set only the
// SCALE of difficulty numbers — vardiff settings, the difficulty tile, a
// share's reported difficulty. Block finding compares hashes with the daemon's
// own target, and effort and hashrate are ratios in which diff1 cancels out.
//
// Source: kerrigan-network/node-stratum-pool, lib/algoProperties.js getDiff():
// 0x0A5F…FEB4 for N=192,K=7, and 0x0007FF…FF (the zcash-family value) for
// everything else. Kerrigan's pool-integration guide quotes 0x0007… for both,
// but the fork's code is what its pools run — and moving 192/7 now would
// rescale every difficulty already configured by ~332x.
const DIFF1_192_HEX = '0a5f' + 'f'.repeat(57) + 'eb4';
const DIFF1_200_HEX = '0007' + 'f'.repeat(60);
if (DIFF1_192_HEX.length !== 64 || DIFF1_200_HEX.length !== 64) throw new Error('DIFF1 hex corrupted');
const DIFF1_192 = BigInt('0x' + DIFF1_192_HEX);
const DIFF1_200 = BigInt('0x' + DIFF1_200_HEX);

// The names from before 200/9, meaning 192/7. They are also the defaults
// below, so every caller written for one algo keeps its exact behaviour.
const DIFF1_HEX = DIFF1_192_HEX;
const DIFF1 = DIFF1_192;

// Consensus powLimit for equihash192 (chainparams.cpp). Harder than DIFF1.
const POW_LIMIT_192 = BigInt('0x0010' + '0'.repeat(60));

const MAX256 = (1n << 256n) - 1n;

// Expected solutions represented by one accepted share at difficulty 1:
// ~24.67 on 192/7, ~8192 on 200/9.
function solsPerDiff1(diff1) {
  return Number(((1n << 256n) * 1000000n) / diff1) / 1e6;
}
const SOLS_PER_DIFF1 = solsPerDiff1(DIFF1);

function isHex(s) {
  return typeof s === 'string' && s.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(s);
}

function hexToBuf(hex, name) {
  if (!isHex(hex)) {
    throw new Error(`invalid hex${name ? ` for ${name}` : ''}: ${String(hex).slice(0, 48)}`);
  }
  return Buffer.from(hex, 'hex');
}

function bufToHex(buf) {
  return buf.toString('hex');
}

// Whole-buffer byte reversal (display <-> internal order). Never a word swap.
function reverseBuf(buf) {
  return Buffer.from(buf).reverse();
}

function reverseHex(hex, name) {
  return reverseBuf(hexToBuf(hex, name)).toString('hex');
}

function u32LE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function u32LEHex(n) {
  return u32LE(n).toString('hex');
}

// Bitcoin CompactSize encoding.
function varint(n) {
  if (!Number.isInteger(n) || n < 0) throw new Error('varint: bad value ' + n);
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  }
  if (n <= 0xffffffff) {
    const b = Buffer.alloc(5);
    b[0] = 0xfe;
    b.writeUInt32LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 0xff;
  b.writeBigUInt64LE(BigInt(n), 1);
  return b;
}

function readVarint(buf, off) {
  const first = buf[off];
  if (first === undefined) throw new Error('readVarint: out of range');
  if (first < 0xfd) return { value: first, size: 1 };
  if (first === 0xfd) return { value: buf.readUInt16LE(off + 1), size: 3 };
  if (first === 0xfe) return { value: buf.readUInt32LE(off + 1), size: 5 };
  return { value: Number(buf.readBigUInt64LE(off + 1)), size: 9 };
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function sha256d(buf) {
  return sha256(sha256(buf));
}

// The share/PoW hash is interpreted as a little-endian 256-bit number.
function bufToBigIntLE(buf) {
  return BigInt('0x' + reverseBuf(buf).toString('hex'));
}

function bufToBigIntBE(buf) {
  return BigInt('0x' + buf.toString('hex'));
}

function bigIntToHex64(n) {
  return n.toString(16).padStart(64, '0');
}

// difficulty (float) -> 256-bit share target on the scale of `diff1` (default:
// 192/7's). 2^32 fixed-point scaling keeps the BigInt division exact while
// supporting fractional difficulties.
function diffToTarget(diff, diff1 = DIFF1) {
  if (!(diff > 0) || !Number.isFinite(diff)) throw new Error('diffToTarget: bad difficulty ' + diff);
  let q = BigInt(Math.round(diff * 4294967296));
  if (q < 1n) q = 1n;
  let t = (diff1 << 32n) / q;
  if (t < 1n) t = 1n;
  if (t > MAX256) t = MAX256;
  return t;
}

// Display only — never used for accept/reject decisions.
function targetToDiff(target, diff1 = DIFF1) {
  if (typeof target !== 'bigint' || target <= 0n) return 0;
  return Number((diff1 * 1000000n) / target) / 1e6;
}

// Kerrigan targets ~120 s blocks across 4 algos, so each algo sees ~25% of
// them. Used to turn a difficulty into an implied network hashrate.
const PER_ALGO_BLOCK_SEC = 480;

// Network difficulty implied by a job's block target, on the scale of the
// job's own algo. null when there is no job. targetToDiff answers 0 (not null)
// for a non-BigInt, so guard the type here rather than relying on it.
function jobNetDiff(job) {
  if (!job || typeof job.blockTarget !== 'bigint' || job.blockTarget <= 0n) return null;
  const d = targetToDiff(job.blockTarget, job.algo ? job.algo.diff1 : DIFF1);
  return d > 0 ? d : null;
}

// Network hashrate in Sol/s implied by a network difficulty, given the algo's
// solutions per diff-1 share. null (never 0) when unknown, so a gap in the
// chart stays a gap instead of a crash to zero.
function netSolsFromDiff(netDiff, perDiff1 = SOLS_PER_DIFF1) {
  if (!Number.isFinite(netDiff) || netDiff <= 0) return null;
  return (netDiff * perDiff1) / PER_ALGO_BLOCK_SEC;
}

// nBits compact form -> 256-bit target.
function compactToTarget(bits) {
  const n = typeof bits === 'string' ? parseInt(bits, 16) : bits;
  if (!Number.isFinite(n) || n < 0) throw new Error('compactToTarget: bad bits ' + bits);
  const exp = n >>> 24;
  const mant = BigInt(n & 0x007fffff);
  if (exp <= 3) return mant >> (8n * BigInt(3 - exp));
  return mant << (8n * BigInt(exp - 3));
}

// Merkle root over internal-order 32-byte leaves; odd levels duplicate the last.
function merkleRoot(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) throw new Error('merkleRoot: no leaves');
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256d(Buffer.concat([a, b])));
    }
    level = next;
  }
  return level[0];
}

module.exports = {
  DIFF1, DIFF1_HEX, DIFF1_192, DIFF1_200, POW_LIMIT_192, MAX256, SOLS_PER_DIFF1, PER_ALGO_BLOCK_SEC,
  isHex, hexToBuf, bufToHex, reverseBuf, reverseHex,
  u32LE, u32LEHex, varint, readVarint,
  sha256, sha256d,
  bufToBigIntLE, bufToBigIntBE, bigIntToHex64,
  diffToTarget, targetToDiff, compactToTarget, solsPerDiff1,
  jobNetDiff, netSolsFromDiff,
  merkleRoot,
};
