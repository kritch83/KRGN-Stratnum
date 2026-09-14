'use strict';
// Stratum TCP server: NDJSON framing, session state machine, job registry,
// notify/set_target broadcasting. Share validation itself lives in shares.js
// (wired in via `onSubmit`).
//
// Events: 'connect' (session), 'disconnect' (session), 'job' (job, clean),
//         'jobError' (reason)

const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');
const util = require('./util');
const jobLib = require('./job');
const algos = require('./algos');

// Longest line we will wait on. A 200/9 submit is ~2.9 KB (a 1344-byte
// solution, hex-encoded); a 192/7 one is under 1 KB.
const MAX_LINE_BUFFER = 10240;
const MAX_BAD_LINES = 10;
const PRE_AUTH_TIMEOUT_MS = 60000;
const IDLE_TIMEOUT_MS = 600000;

class ExtraNonceCounter {
  constructor(algoKey) {
    this.algoKey = algoKey;
    this.instanceByte = crypto.randomBytes(1)[0];
    this.counter = crypto.randomBytes(3).readUIntBE(0, 3);
  }

  next() {
    // Test hook: pin extraNonce1 so known-good shares can be replayed. One
    // value pins every port; "equihash192=aabbccdd,equihash200=…" pins each
    // algo on its own, to replay one real block per algo in one process.
    const forced = process.env.STRATNUM_FORCE_EN1;
    if (forced) {
      if (!forced.includes('=')) return forced.toLowerCase();
      for (const pair of forced.split(',')) {
        const [k, v] = pair.split('=');
        if (k === this.algoKey && v) return v.toLowerCase();
      }
    }
    const value = ((this.instanceByte << 24) >>> 0) + (this.counter & 0xffffff);
    this.counter = (this.counter + 1) & 0xffffff;
    const b = Buffer.alloc(4);
    b.writeUInt32BE(value >>> 0, 0);
    return b.toString('hex');
  }
}

// On a dual-stack socket (bind "::") IPv4 peers arrive as ::ffff:192.0.2.1.
// Show the plain IPv4 form; leave real IPv6 addresses untouched.
function displayAddress(addr) {
  if (typeof addr !== 'string' || !addr) return '?';
  return addr.startsWith('::ffff:') && addr.includes('.') ? addr.slice(7) : addr;
}

function sanitizeWorkerName(name) {
  if (typeof name !== 'string') return 'worker';
  const clean = name.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 64);
  return clean || 'worker';
}

class StratumServer extends EventEmitter {
  // opts: { algo?, port, bind, startDiff, maxConnections, retainJobs, idleCheckMs? }
  // algo is a lib/algos.js profile (default equihash192): one port, one algo.
  constructor(opts, vardiff, log) {
    super();
    this.opts = opts;
    this.algo = opts.algo || algos.get();
    this.vardiff = vardiff;
    this.log = log;
    this.sessions = new Set();
    this.jobs = new Map();
    this.currentJob = null;
    this.jobCounter = 0;
    this.sessionSeq = 0;
    this.enCounter = new ExtraNonceCounter(this.algo.key);
    this.onSubmit = async () => ({ error: [20, 'share processor not wired', null] });
    this.server = net.createServer(sock => this._onConnection(sock));
    this.server.on('error', err => this.log.error('stratum server error:', err));
    this._idleTimer = null;
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, this.opts.bind || '0.0.0.0', () => {
        this.server.removeListener('error', reject);
        const idleMs = this.opts.idleCheckMs === undefined ? 30000 : this.opts.idleCheckMs;
        if (idleMs > 0) {
          this._idleTimer = setInterval(() => this._idleSweep(), idleMs);
          if (this._idleTimer.unref) this._idleTimer.unref();
        }
        resolve(this.server.address().port);
      });
    });
  }

  close() {
    if (this._idleTimer) clearInterval(this._idleTimer);
    for (const s of this.sessions) s.socket.destroy();
    return new Promise(resolve => this.server.close(resolve));
  }

  _idleSweep() {
    for (const session of this.sessions) {
      if (!session.authorized) continue;
      const newDiff = this.vardiff.onIdleCheck(session.diffState);
      if (newDiff !== null) {
        this.log.info(`idle retarget ${session.workerName} -> diff ${newDiff}`);
        this.applyRetarget(session, newDiff);
      }
    }
  }

  _onConnection(sock) {
    if (this.sessions.size >= this.opts.maxConnections) {
      this.log.warn(`connection limit (${this.opts.maxConnections}) reached — rejecting ${sock.remoteAddress}`);
      sock.destroy();
      return;
    }
    const session = {
      // Unique per connection: worker names are not, since several rigs may
      // log in under the same one.
      id: ++this.sessionSeq,
      socket: sock,
      remote: displayAddress(sock.remoteAddress),
      buffer: '',
      badLines: 0,
      firstChunk: true,
      subscribed: false,
      authorized: false,
      workerName: null,
      userAgent: null,
      en1: null,
      diffState: this.vardiff.createSession(this.opts.startDiff),
      shareTarget: this.algo.diffToTarget(this.opts.startDiff),
      prevShareTarget: null,
      accepted: 0,
      rejected: 0,
      invalidSolns: 0,
      // Consecutive invalid solutions; any solution that verifies clears it.
      invalidStreak: 0,
      dropReason: null,
      bestShareDiff: 0,
      lastShareAt: null,
      connectedAt: Date.now(),
    };
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 60000);
    sock.setTimeout(IDLE_TIMEOUT_MS, () => {
      this.log.info(`idle timeout for ${session.workerName || session.remote}`);
      sock.destroy();
    });
    session.preAuthTimer = setTimeout(() => {
      if (!session.authorized) {
        this.log.debug(`pre-auth timeout for ${session.remote}`);
        sock.destroy();
      }
    }, PRE_AUTH_TIMEOUT_MS);
    if (session.preAuthTimer.unref) session.preAuthTimer.unref();

    sock.on('data', chunk => this._onData(session, chunk));
    sock.on('error', err => this.log.debug(`socket error ${session.remote}: ${err.message}`));
    sock.on('close', () => {
      clearTimeout(session.preAuthTimer);
      this.sessions.delete(session);
      if (session.authorized) this.log.info(`worker disconnected: ${session.workerName} (${session.remote})`);
      this.emit('disconnect', session);
    });
    this.sessions.add(session);
  }

  _onData(session, chunk) {
    if (session.firstChunk) {
      session.firstChunk = false;
      if (chunk[0] === 0x16) {
        this.log.warn(`miner at ${session.remote} attempted a TLS handshake — ` +
          'configure the miner for plain stratum (no ssl:// / --nossl)');
        session.socket.destroy();
        return;
      }
    }
    session.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = session.buffer.indexOf('\n')) !== -1) {
      const line = session.buffer.slice(0, idx).replace(/\r$/, '').trim();
      session.buffer = session.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        session.badLines++;
        if (session.badLines >= MAX_BAD_LINES) {
          this.log.warn(`too many malformed lines from ${session.remote} — dropping connection`);
          session.socket.destroy();
          return;
        }
        continue;
      }
      // A malformed submit must never take the server down.
      this._handleMessage(session, msg).catch(err => {
        this.log.error('error handling stratum message:', err);
        this._replyError(session, msg && msg.id !== undefined ? msg.id : null, [20, 'internal error', null]);
      });
    }
    // Only the unfinished tail counts against the cap. Every complete line has
    // been handled above, and several 200/9 submits (~2.9 KB each) landing in
    // one TCP read is ordinary traffic; what the cap stops is a single line
    // that never ends.
    if (session.buffer.length > MAX_LINE_BUFFER) {
      this.log.warn(`oversized message from ${session.remote} — dropping connection`);
      session.socket.destroy();
    }
  }

  async _handleMessage(session, msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
      session.badLines++;
      return;
    }
    const id = msg.id === undefined ? null : msg.id;
    const params = Array.isArray(msg.params) ? msg.params : [];

    switch (msg.method) {
      case 'mining.subscribe': {
        if (!session.subscribed) {
          session.en1 = this.enCounter.next();
          session.subscribed = true;
          session.userAgent = typeof params[0] === 'string' ? params[0].slice(0, 64) : null;
        }
        return this._reply(session, id, [null, session.en1]);
      }
      case 'mining.authorize': {
        session.workerName = sanitizeWorkerName(params[0]);
        session.authorized = true;
        this._reply(session, id, true);
        this.log.info(`worker authorized: ${session.workerName} from ${session.remote} ` +
          `(start diff ${session.diffState.difficulty})`);
        this.emit('connect', session);
        if (this.currentJob) this._sendTargetAndJob(session, this.currentJob, true);
        return;
      }
      case 'mining.submit': {
        const outcome = await this.onSubmit(session, params);
        if (outcome.error) {
          session.rejected++;
          this._replyError(session, id, outcome.error);
        } else {
          session.accepted++;
          this._reply(session, id, true);
        }
        // The share pipeline can ask for this connection to go (see
        // dropAfterReply). It happens here, once the answer above is on the
        // wire, so the miner is always told why before the socket closes.
        if (session.dropReason) {
          this.log.warn(`dropping ${session.workerName} (${session.remote}): ${session.dropReason} — ` +
            'check that miner\'s algorithm and personalization; it is free to reconnect');
          session.socket.destroy();
        }
        return;
      }
      case 'mining.extranonce.subscribe':
        return this._replyError(session, id, [20, 'Not supported.', null]);
      case 'mining.get_transactions':
        return this._reply(session, id, []);
      case 'mining.suggest_target':
      case 'mining.suggest_difficulty':
        return this._reply(session, id, true);
      default:
        this.log.debug(`unknown stratum method "${msg.method}" from ${session.remote}`);
        return this._replyError(session, id, [20, 'Unknown method', null]);
    }
  }

  // Build a job from a validated template and broadcast it.
  setTemplate(tpl, clean) {
    let job;
    try {
      job = jobLib.buildJob(tpl, (++this.jobCounter).toString(16), {
        algo: this.algo,
        coinbaseTag: this.opts.coinbaseTag,
      });
      if (job.tagSkipped && !this._tagWarned) {
        this._tagWarned = true;
        this.log.warn('coinbaseTag not applied: ' + job.tagSkipped);
      }
    } catch (err) {
      this.log.error('failed to build job from template:', err.message);
      this.emit('jobError', err.message);
      return null;
    }
    // Deliberately NOT cleared on a clean job. `clean` is a message to the
    // MINERS — drop what you are working on — and they still get it. What the
    // server keeps is a separate question: a share that arrives a few hundred
    // ms after a new block lands must still be recognisable, because if that
    // share happens to be a block, an unknown job id means it is thrown away
    // as "job not found" before anything ever checks it against the block
    // target. Ageing out through the ring below bounds the memory instead.
    this.jobs.set(job.id, job);
    while (this.jobs.size > Math.max(1, this.opts.retainJobs)) {
      this.jobs.delete(this.jobs.keys().next().value);
    }
    this.currentJob = job;
    let notified = 0;
    for (const session of this.sessions) {
      if (session.subscribed && session.authorized) {
        this._sendTargetAndJob(session, job, clean);
        notified++;
      }
    }
    const line = `job ${job.id}: height ${job.height}, ${job.txCount} tx, ` +
      `${clean ? 'clean' : 'refresh'} -> ${notified} miner(s)`;
    if (clean) this.log.info(line); else this.log.debug(line);
    this.emit('job', job, clean);
    return job;
  }

  // Invariant: a session always receives set_target before any notify.
  _sendTargetAndJob(session, job, clean) {
    const target = this.algo.diffToTarget(session.diffState.difficulty);
    if (session.shareTarget !== target) {
      session.prevShareTarget = session.shareTarget;
      session.shareTarget = target;
    }
    if (clean) session.prevShareTarget = null;
    this._notify(session, 'mining.set_target', [util.bigIntToHex64(session.shareTarget)]);
    this._notify(session, 'mining.notify', jobLib.notifyParams(job, clean));
  }

  // Asks for a session to be disconnected once its pending reply has been
  // sent. The share pipeline decides when a connection has earned this; the
  // socket belongs to this file, so the closing does too.
  dropAfterReply(session, reason) {
    session.dropReason = reason;
  }

  // Apply a vardiff retarget (diffState was already mutated by vardiff).
  applyRetarget(session, newDiff) {
    const target = this.algo.diffToTarget(newDiff);
    session.prevShareTarget = session.shareTarget;
    session.shareTarget = target;
    this._notify(session, 'mining.set_target', [util.bigIntToHex64(target)]);
    if (this.currentJob) {
      this._notify(session, 'mining.notify', jobLib.notifyParams(this.currentJob, false));
    }
    this.log.debug(`retarget ${session.workerName} -> diff ${newDiff}`);
  }

  _reply(session, id, result) {
    this._send(session, { id, result, error: null });
  }

  _replyError(session, id, error) {
    this._send(session, { id, result: null, error });
  }

  _notify(session, method, params) {
    this._send(session, { id: null, method, params });
  }

  _send(session, obj) {
    if (!session.socket.destroyed) session.socket.write(JSON.stringify(obj) + '\n');
  }
}

module.exports = { StratumServer, sanitizeWorkerName, displayAddress };
