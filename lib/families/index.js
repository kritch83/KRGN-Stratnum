'use strict';
// Proof-of-work families. An algo profile (lib/algos.js) names its family, and
// the family owns everything that differs between them on the wire and in a
// share: how a job is built from a template, what the miner is told, how a
// submission is parsed, verified and turned into a block. Everything else —
// sessions, vardiff, duplicate detection, booking, block-first submission —
// is shared and lives in stratum.js / shares.js.
//
// Required lazily so algos.js (which every family reads) never forms a cycle.

const LOADERS = {
  equihash: () => require('./equihash'),
  kawpow: () => require('./kawpow'),
  bitcoin: () => require('./bitcoin'),
};

const cache = new Map();

function get(name) {
  if (!cache.has(name)) {
    const load = Object.prototype.hasOwnProperty.call(LOADERS, name) ? LOADERS[name] : null;
    if (!load) throw new Error(`unknown pow family ${JSON.stringify(name)}`);
    cache.set(name, load());
  }
  return cache.get(name);
}

// The family for an algo profile.
function of(algo) {
  return get(algo.family);
}

module.exports = { get, of };
