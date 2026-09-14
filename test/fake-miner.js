'use strict';
// Scripted stratum client for tests: request/response matching by id,
// FIFO notification queue with awaitable pops.

const net = require('net');

class FakeMiner {
  constructor(port, host) {
    this.port = port;
    this.host = host || '127.0.0.1';
    this.pending = new Map();
    this.nextId = 1;
    this.notifications = [];
    this.waiters = [];
    this.buffer = '';
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.port, this.host, resolve);
      this.sock.on('error', err => {
        if (!this.connected) reject(err);
      });
      this.sock.on('connect', () => { this.connected = true; });
      this.sock.on('data', c => this._onData(c));
      this.sock.on('close', () => {
        this.closed = true;
        this._flushWaiters();
      });
    });
  }

  _onData(c) {
    this.buffer += c.toString();
    let i;
    while ((i = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method) {
        this.notifications.push(msg);
        this._flushWaiters();
      } else if (this.pending.has(msg.id)) {
        const resolve = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    }
  }

  _flushWaiters() {
    for (let w = 0; w < this.waiters.length; w++) {
      const waiter = this.waiters[w];
      const idx = waiter.method
        ? this.notifications.findIndex(n => n.method === waiter.method)
        : (this.notifications.length ? 0 : -1);
      if (idx !== -1) {
        const [n] = this.notifications.splice(idx, 1);
        this.waiters.splice(w, 1);
        w--;
        waiter.done = true;
        waiter.resolve(n);
      } else if (this.closed) {
        this.waiters.splice(w, 1);
        w--;
        waiter.done = true;
        waiter.resolve(null);
      }
    }
  }

  sendRaw(data) {
    this.sock.write(data);
  }

  send(obj) {
    this.sock.write(JSON.stringify(obj) + '\n');
  }

  // Resolves with the full response message ({id, result, error}).
  request(method, params, id) {
    const useId = id === undefined ? this.nextId++ : id;
    return new Promise(resolve => {
      this.pending.set(useId, resolve);
      this.send({ id: useId, method, params: params || [] });
    });
  }

  // Pops the next queued notification (optionally by method). Resolves null
  // on timeout or connection close.
  nextNotification(method, timeoutMs) {
    return new Promise(resolve => {
      const waiter = { method, resolve, done: false };
      this.waiters.push(waiter);
      this._flushWaiters();
      const timer = setTimeout(() => {
        if (!waiter.done) {
          waiter.done = true;
          const i = this.waiters.indexOf(waiter);
          if (i !== -1) this.waiters.splice(i, 1);
          resolve(null);
        }
      }, timeoutMs === undefined ? 1000 : timeoutMs);
      if (timer.unref) timer.unref();
    });
  }

  waitClose(timeoutMs) {
    return new Promise(resolve => {
      if (this.closed) return resolve(true);
      this.sock.on('close', () => resolve(true));
      const timer = setTimeout(() => resolve(false), timeoutMs === undefined ? 1500 : timeoutMs);
      if (timer.unref) timer.unref();
    });
  }

  close() {
    this.closed = true;
    if (this.sock) this.sock.destroy();
  }
}

module.exports = { FakeMiner };
