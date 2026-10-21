'use strict';
// KawPoW epoch contexts, kept on disk so a restart does not leave KawPoW
// shares unverifiable for the few seconds a light cache takes to build.
//
// One file per epoch, ~19 MB at Kerrigan's current height:
//   'KPWC' | version u32 | epoch u32 | items u32 | sha256(payload) | payload
// The payload is the light cache, 16 little-endian words per item. A file that
// fails any check is rebuilt rather than trusted; one that cannot be written
// just means the next start builds again.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const kawpow = require('./kawpow');

const MAGIC = 'KPWC';
const VERSION = 1;
const HEADER = 48;

const fileFor = (dir, epoch) => path.join(dir, `kawpow-epoch-${epoch}.bin`);

function load(dir, epoch) {
  let buf;
  try { buf = fs.readFileSync(fileFor(dir, epoch)); } catch { return null; }
  const items = kawpow.lightCacheItems(epoch);
  if (buf.length !== HEADER + items * 64 || buf.toString('latin1', 0, 4) !== MAGIC ||
      buf.readUInt32LE(4) !== VERSION || buf.readUInt32LE(8) !== epoch || buf.readUInt32LE(12) !== items) {
    return null;
  }
  const payload = buf.subarray(HEADER);
  if (!crypto.createHash('sha256').update(payload).digest().equals(buf.subarray(16, 48))) return null;
  // Copy into an aligned buffer: a Uint32Array needs a 4-byte-aligned offset.
  const cache = new Uint32Array(items * 16);
  Buffer.from(cache.buffer).set(payload);
  return cache;
}

// prune: delete files more than one epoch away. A pool only ever needs this
// epoch and the next; a test run that walks many epochs keeps them all.
function save(dir, epoch, cache, prune = true) {
  const payload = Buffer.from(cache.buffer, cache.byteOffset, cache.byteLength);
  const head = Buffer.alloc(HEADER);
  head.write(MAGIC, 0, 'latin1');
  head.writeUInt32LE(VERSION, 4);
  head.writeUInt32LE(epoch, 8);
  head.writeUInt32LE(cache.length / 16, 12);
  crypto.createHash('sha256').update(payload).digest().copy(head, 16);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fileFor(dir, epoch) + '.tmp';
  fs.writeFileSync(tmp, Buffer.concat([head, payload]));
  fs.renameSync(tmp, fileFor(dir, epoch));
  if (!prune) return;
  // Keep this epoch and its neighbours; anything older is dead weight.
  for (const f of fs.readdirSync(dir)) {
    const m = /^kawpow-epoch-(\d+)\.bin$/.exec(f);
    if (m && Math.abs(Number(m[1]) - epoch) > 1) fs.rmSync(path.join(dir, f), { force: true });
  }
}

// The context for an epoch: from disk when a good copy is there, otherwise
// built (and saved, when there is a directory to save it in).
// Returns { ctx, source: 'disk' | 'built' }.
function loadOrBuild(epoch, dir, opts) {
  const prune = !(opts && opts.prune === false);
  // The file holds native-order words; only little-endian machines (every
  // platform Node ships for in practice) read them back as written.
  const usable = dir && os.endianness() === 'LE';
  if (usable) {
    const cache = load(dir, epoch);
    if (cache) return { ctx: kawpow.contextFromCache(epoch, cache), source: 'disk' };
  }
  const cache = kawpow.buildLightCache(epoch);
  if (usable) {
    try { save(dir, epoch, cache, prune); } catch { /* a cache we cannot keep is still a cache */ }
  }
  return { ctx: kawpow.contextFromCache(epoch, cache), source: 'built' };
}

module.exports = { loadOrBuild, load, save, fileFor };
