'use strict';
// Runs on a worker thread: KawPoW verification takes tens of milliseconds and
// an epoch's light cache a few seconds, and neither may stall the event loop
// that serves every miner on every algo. Messages are handled one at a time,
// so a share arriving while a cache is built simply waits its turn.
//
//   in : { type: 'prepare', epoch }
//        { type: 'verify', id, height, headerHash, nonce, mixHash }   (hex strings)
//   out: { type: 'ready', epoch, source, ms }
//        { type: 'result', id, mixHash, finalHash }   (hex)  |  { type: 'result', id, error }

const { parentPort, workerData } = require('worker_threads');
const kawpow = require('./kawpow');
const store = require('./kawpow-cache');

const cacheDir = workerData && workerData.cacheDir;
const prune = !(workerData && workerData.prune === false);
const contexts = new Map();   // epoch -> ctx, at most two (this epoch and the next)

function contextFor(epoch) {
  if (contexts.has(epoch)) return contexts.get(epoch);
  const t0 = Date.now();
  const { ctx, source } = store.loadOrBuild(epoch, cacheDir, { prune });
  contexts.set(epoch, ctx);
  while (contexts.size > 2) {
    // Drop whichever is furthest from the one just added.
    let far = null;
    for (const e of contexts.keys()) if (far === null || Math.abs(e - epoch) > Math.abs(far - epoch)) far = e;
    contexts.delete(far);
  }
  parentPort.postMessage({ type: 'ready', epoch, source, ms: Date.now() - t0 });
  return ctx;
}

parentPort.on('message', msg => {
  if (msg.type === 'prepare') {
    try { contextFor(msg.epoch); } catch (err) { parentPort.postMessage({ type: 'ready', epoch: msg.epoch, error: err.message }); }
    return;
  }
  if (msg.type === 'verify') {
    try {
      const ctx = contextFor(kawpow.epochOf(msg.height));
      const r = kawpow.hash(ctx, msg.height, Buffer.from(msg.headerHash, 'hex'), BigInt('0x' + msg.nonce));
      parentPort.postMessage({ type: 'result', id: msg.id, mixHash: r.mixHash.toString('hex'), finalHash: r.finalHash.toString('hex') });
    } catch (err) {
      parentPort.postMessage({ type: 'result', id: msg.id, error: err.message });
    }
  }
});
