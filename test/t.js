'use strict';
// Assertion helpers for the zero-dep test suite.

function fmt(v) {
  if (Buffer.isBuffer(v)) return `Buffer<${v.toString('hex')}>`;
  if (typeof v === 'bigint') return v.toString(16) + 'n(hex)';
  try { return JSON.stringify(v); } catch { return String(v); }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  let equal;
  if (Buffer.isBuffer(actual) && Buffer.isBuffer(expected)) equal = actual.equals(expected);
  else if (typeof actual === 'bigint' || typeof expected === 'bigint') equal = actual === expected;
  else if (typeof actual === 'object' && actual !== null) equal = JSON.stringify(actual) === JSON.stringify(expected);
  else equal = actual === expected;
  if (!equal) {
    throw new Error(`${msg || 'assertEq failed'}\n  actual:   ${fmt(actual)}\n  expected: ${fmt(expected)}`);
  }
}

function assertClose(actual, expected, rel, msg) {
  const tol = Math.abs(expected) * (rel === undefined ? 1e-6 : rel);
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${msg || 'assertClose failed'}: ${actual} vs ${expected} (tol ${tol})`);
  }
}

function assertThrows(fn, msg) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error(msg || 'expected function to throw');
}

module.exports = { assert, assertEq, assertClose, assertThrows };
