'use strict';
// The algos Kerrigan mines, and everything that differs between them. The rest
// of the pool asks a profile rather than hard-coding one, which is what lets a
// single process serve several — each on its own stratum port.
//
// `family` names the proof-of-work family (lib/families/) that owns the wire
// format and the per-share check; `unit` is what the hashrate is counted in.
// Deliberately NOT in here, because every algo shares them: X11 block
// identity, the coinbase the daemon builds, and ~480 s per algo between blocks.

const util = require('./util');
const equihash = require('./equihash');

function profile(def) {
  const solsPerDiff1 = util.solsPerDiff1(def.diff1);
  return Object.freeze(Object.assign({}, def, {
    solsPerDiff1,
    diffToTarget: d => util.diffToTarget(d, def.diff1),
    targetToDiff: t => util.targetToDiff(t, def.diff1),
    netSolsFromDiff: nd => util.netSolsFromDiff(nd, solsPerDiff1),
  }));
}

const PROFILES = Object.freeze({
  equihash192: profile({
    key: 'equihash192',            // the daemon's name: getblocktemplate {"algo": key}
    label: 'equihash 192/7',
    short: '192/7',
    family: 'equihash',
    unit: 'Sol/s',
    eq: equihash.EQ192,            // N/K, solution size, CompactSize prefix
    versionNibble: 6,              // (block version >> 8) & 0xf, stamped by the daemon
    personalization: 'kerrigan',   // blake2b personal string when the template omits it
    notifyAlgo: '192_7',           // mining.notify param 8, the kerrigan stratum extension
    diff1: util.DIFF1_192,
    port: 3192,
    diffDefaults: { startDiff: 8, minDiff: 0.5, maxDiff: 100000 },
  }),
  equihash200: profile({
    key: 'equihash200',
    label: 'equihash 200/9',
    short: '200/9',
    family: 'equihash',
    unit: 'Sol/s',
    eq: equihash.EQ200,
    versionNibble: 4,
    personalization: 'ZcashPoW',
    notifyAlgo: '200_9',
    diff1: util.DIFF1_200,
    port: 3200,
    // A diff-1 share is ~8192 solutions here against ~24.7 on 192/7, so the
    // same share rate needs a far smaller number; vardiff finds the exact one.
    diffDefaults: { startDiff: 1, minDiff: 0.05, maxDiff: 100000 },
  }),
  kawpow: profile({
    key: 'kawpow',
    label: 'KawPoW',
    short: 'KawPoW',
    family: 'kawpow',
    unit: 'H/s',
    versionNibble: 2,
    diff1: util.DIFF1_KAWPOW,
    port: 3195,
    // One diff-1 share is ~4.3 billion hashes; a 30 MH/s GPU at the 15 s
    // target settles near 0.1. Vardiff finds the exact level.
    diffDefaults: { startDiff: 0.25, minDiff: 0.005, maxDiff: 1000 },
  }),
  x11: profile({
    key: 'x11',
    label: 'X11',
    short: 'X11',
    family: 'bitcoin',
    unit: 'H/s',
    versionNibble: 0,
    diff1: util.DIFF1_X11,
    port: 3197,
    // ASICs: ~6,000 is a 1.7 TH/s D9 at the 15 s target. The cap stays under
    // the network difficulty (~196,000 at block 122283), so a share target can
    // never be harder than a block and make the miner throw blocks away.
    diffDefaults: { startDiff: 1024, minDiff: 1, maxDiff: 100000 },
  }),
});

const DEFAULT_ALGO = 'equihash192';

// Throws on a name it does not know: a typo must never quietly become 192/7.
function get(key) {
  const k = key === undefined || key === null ? DEFAULT_ALGO : key;
  if (!Object.prototype.hasOwnProperty.call(PROFILES, k)) {
    throw new Error(`unknown algo ${JSON.stringify(key)} — expected one of ${Object.keys(PROFILES).join(', ')}`);
  }
  return PROFILES[k];
}

function list() {
  return Object.values(PROFILES);
}

module.exports = { get, list, PROFILES, DEFAULT_ALGO };
