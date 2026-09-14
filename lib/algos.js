'use strict';
// The equihash variants Kerrigan mines, and everything that differs between
// them. The rest of the pool asks a profile rather than hard-coding 192/7,
// which is what lets one process serve both — each on its own stratum port.
//
// Deliberately NOT in here, because both algos share them: the 140-byte
// header, sha256d(header || solution) read little-endian as the share hash,
// X11 block identity, the coinbase the daemon builds, and ~480 s per algo
// between blocks.

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
