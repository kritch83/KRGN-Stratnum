'use strict';
// X11: the chained hash Kerrigan uses as the proof of work for its X11 algo,
// and as every block's identity hash. The eleven hash functions are Dash's
// pure-JS implementation, vendored unmodified in lib/x11/ (MIT — see
// lib/x11/PROVENANCE.md).
//
// That package's output-format codes do the opposite of what its own doc
// comment says (1 returns 32-bit words, 2 returns bytes). Everything in
// stratnum goes through this one function instead.

const dash = require('./x11/index.js');

// buf: the bytes to hash (an 80-byte header, for shares). Returns the 32-byte
// hash in internal order: read little-endian it is the PoW value; reversed it
// is the hash the node and explorers display.
function x11(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('x11: input must be a Buffer');
  return Buffer.from(dash.digest(buf, 1, 2));
}

module.exports = { x11 };
