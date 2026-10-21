'use strict';
// The main-thread side of lib/kawpow-worker.js: one worker per process, shared
// by every KawPoW port, started on first use. Unref'd, so it never keeps a
// finished process alive.

const path = require('path');
const { Worker } = require('worker_threads');
const kawpow = require('./kawpow');

class KawpowVerifier {
  // opts: { cacheDir?, prune? (default true), log? }
  constructor(opts) {
    this.opts = opts || {};
    this.log = this.opts.log || null;
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();   // id -> { resolve, reject }
    this.prepared = new Set();  // epochs asked for
  }

  _start() {
    if (this.worker) return this.worker;
    const w = new Worker(path.join(__dirname, 'kawpow-worker.js'), {
      workerData: { cacheDir: this.opts.cacheDir || null, prune: this.opts.prune !== false },
    });
    w.unref();
    w.on('message', msg => this._onMessage(msg));
    w.on('error', err => this._fail(err));
    w.on('exit', code => { if (code !== 0) this._fail(new Error(`kawpow worker exited with code ${code}`)); });
    this.worker = w;
    return w;
  }

  // A dead worker fails what it was holding and is replaced on next use.
  _fail(err) {
    if (this.log) this.log.error('kawpow verifier:', err.message);
    this.worker = null;
    this.prepared.clear();
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  _onMessage(msg) {
    if (msg.type === 'ready') {
      if (this.log) {
        if (msg.error) this.log.error(`kawpow epoch ${msg.epoch} could not be prepared: ${msg.error}`);
        else this.log.info(`kawpow epoch ${msg.epoch} ready (${msg.source === 'disk' ? 'loaded from disk' : 'built'} in ${msg.ms} ms)`);
      }
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve({ mixHash: Buffer.from(msg.mixHash, 'hex'), finalHash: Buffer.from(msg.finalHash, 'hex') });
  }

  // Have the epoch for this height ready before shares need it — and, near the
  // end of an epoch, the next one too, so the boundary costs no waiting.
  prepare(height) {
    const epoch = kawpow.epochOf(height);
    const want = [epoch];
    if (height % kawpow.EPOCH_LENGTH >= kawpow.EPOCH_LENGTH - 100) want.push(epoch + 1);
    for (const e of want) {
      if (this.prepared.has(e)) continue;
      this.prepared.add(e);
      this._start().postMessage({ type: 'prepare', epoch: e });
    }
  }

  // The mix and final hash this header and nonce really produce.
  hash(height, headerHash, nonce) {
    const w = this._start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ type: 'verify', id, height, headerHash: headerHash.toString('hex'), nonce: nonce.toString(16).padStart(16, '0') });
    });
  }

  close() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }
}

module.exports = { KawpowVerifier };
