'use strict';
// Minimal ZeroMQ SUB client over raw TCP — enough of ZMTP 3.0 to subscribe to
// a Bitcoin/Dash-family daemon's PUB socket, with no dependencies.
//
// Why hand-rolled: the npm `zeromq` package is a native module, and there is
// no maintained pure-JS ZMTP implementation. A SUB-only client is one socket,
// a 64-byte greeting, a READY command, a subscribe frame, and a frame parser.
//
// The peer is treated as untrusted: frame sizes are capped, unknown commands
// are skipped, and nothing is decoded out of the payload. A notification is a
// hint to go ask the RPC — never a source of truth.
//
// Wire format references: ZMTP 3.0 https://rfc.zeromq.org/spec/23/
//                         ZMTP 3.1 https://rfc.zeromq.org/spec/37/

const net = require('net');
const EventEmitter = require('events');

// --- greeting -------------------------------------------------------------
// 0xFF | 8 pad | 0x7F | major | minor | mechanism(20) | as-server | filler(31)
const GREETING_LEN = 64;
// Advertise minor 0 (ZMTP 3.0) deliberately: that selects libzmq's v3.0
// handshake, where a subscription is an ordinary message whose body is
// 0x01 + prefix. xpub.cpp accepts that form on every libzmq >= 4.0 with no
// version gate, which makes it strictly safer than the 3.1 SUBSCRIBE command.
const ZMTP_MAJOR = 3;
const ZMTP_MINOR = 0;

function buildGreeting() {
  const g = Buffer.alloc(GREETING_LEN);
  g[0] = 0xff;
  g[9] = 0x7f;
  g[10] = ZMTP_MAJOR;
  g[11] = ZMTP_MINOR;
  g.write('NULL', 12, 'ascii');   // mechanism, NUL-padded to 20 bytes
  g[32] = 0x00;                   // as-server: we are the connecting peer
  return g;
}

// --- frames ---------------------------------------------------------------
const FLAG_MORE = 0x01;
const FLAG_LONG = 0x02;
const FLAG_COMMAND = 0x04;

// A daemon's hashblock body is 32 bytes; 1 MB is already absurdly generous.
// The cap matters because a LONG frame declares its size in 8 bytes and a
// hostile peer could claim 2^64.
const MAX_FRAME = 1024 * 1024;
const MAX_MESSAGE_FRAMES = 16;

function buildFrame(body, flags) {
  if (body.length < 256) {
    return Buffer.concat([Buffer.from([flags & ~FLAG_LONG, body.length]), body]);
  }
  const head = Buffer.alloc(9);
  head[0] = flags | FLAG_LONG;
  head.writeBigUInt64BE(BigInt(body.length), 1);
  return Buffer.concat([head, body]);
}

// READY command. Socket-Type is mandatory — libzmq's PUB drops any peer that
// does not declare SUB or XSUB. Property values are length-prefixed BE32.
function buildReady() {
  const name = 'Socket-Type';
  const value = 'SUB';
  const body = Buffer.concat([
    Buffer.from([5]), Buffer.from('READY', 'ascii'),
    Buffer.from([name.length]), Buffer.from(name, 'ascii'),
    (() => { const n = Buffer.alloc(4); n.writeUInt32BE(value.length, 0); return n; })(),
    Buffer.from(value, 'ascii'),
  ]);
  return buildFrame(body, FLAG_COMMAND);
}

// ZMTP 3.0 subscription: a plain message frame, body = 0x01 + prefix.
// An empty prefix subscribes to everything, which avoids depending on the
// daemon's topic spelling.
function buildSubscribe(prefix) {
  const p = Buffer.from(prefix || '', 'utf8');
  return buildFrame(Buffer.concat([Buffer.from([0x01]), p]), 0);
}

function parseUrl(url) {
  const m = /^tcp:\/\/(\[[^\]]+\]|[^:/]+):(\d+)$/.exec(String(url || '').trim());
  if (!m) throw new Error(`zmq: expected tcp://host:port, got ${JSON.stringify(url)}`);
  const host = m[1].startsWith('[') ? m[1].slice(1, -1) : m[1];
  const port = Number(m[2]);
  if (!(port >= 1 && port <= 65535)) throw new Error(`zmq: bad port in ${url}`);
  return { host, port };
}

class Subscriber extends EventEmitter {
  // opts: { url, prefix?, minBackoffMs?, maxBackoffMs? }
  constructor(opts, log) {
    super();
    this.opts = opts;
    this.log = log;
    this.target = parseUrl(opts.url);
    this.prefix = opts.prefix || '';
    this.minBackoff = opts.minBackoffMs || 1000;
    this.maxBackoff = opts.maxBackoffMs || 30000;
    this.status = 'off';
    this.connected = false;
    this._stopped = true;
    this._sock = null;
    this._timer = null;
    this._backoff = this.minBackoff;
    this._reset();
  }

  _reset() {
    this._buf = Buffer.alloc(0);
    this._phase = 'greeting';
    this._frames = [];
    this._msgBytes = 0;
  }

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this.status = 'off';
    this.connected = false;
    if (this._sock) {
      const s = this._sock;
      this._sock = null;
      s.removeAllListeners();
      s.destroy();
    }
  }

  _connect() {
    if (this._stopped) return;
    this._reset();
    const sock = net.connect({ host: this.target.host, port: this.target.port });
    this._sock = sock;
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 30000);

    sock.on('connect', () => {
      sock.write(buildGreeting());  // READY waits until the peer's greeting lands
    });
    sock.on('data', chunk => {
      try {
        this._onData(chunk);
      } catch (err) {
        this._fail('protocol error: ' + err.message);
      }
    });
    sock.on('error', err => this._fail(err.code || err.message));
    sock.on('close', () => {
      if (this._sock === sock) this._fail('connection closed');
    });
  }

  _fail(reason) {
    if (this._stopped) return;
    const wasConnected = this.connected;
    this.connected = false;
    this.status = reason;
    if (this._sock) {
      const s = this._sock;
      this._sock = null;
      s.removeAllListeners();
      s.destroy();
    }
    if (wasConnected) this.emit('down', reason);
    this._timer = setTimeout(() => this._connect(), this._backoff);
    if (this._timer.unref) this._timer.unref();
    this._backoff = Math.min(this._backoff * 2, this.maxBackoff);
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;

    // libzmq writes its greeting in two pieces, so never assume one chunk.
    if (this._phase === 'greeting') {
      if (this._buf.length < GREETING_LEN) return;
      const g = this._buf.subarray(0, GREETING_LEN);
      if (g[0] !== 0xff || g[9] !== 0x7f) throw new Error('bad greeting signature');
      if (g[10] < 3) throw new Error('peer speaks ZMTP ' + g[10] + '.x, need 3.x');
      const mech = g.subarray(12, 32).toString('ascii').replace(/\0+$/, '');
      if (mech !== 'NULL') throw new Error(`unsupported security mechanism ${JSON.stringify(mech)}`);
      this._buf = this._buf.subarray(GREETING_LEN);
      this._phase = 'ready';
      this._sock.write(buildReady());
    }

    // Frames: the peer's READY, then messages.
    for (;;) {
      if (this._buf.length < 2) return;
      const flags = this._buf[0];
      if (flags & 0xf8) throw new Error('reserved frame flag bits set');
      const isLong = (flags & FLAG_LONG) !== 0;
      let size;
      let headLen;
      if (isLong) {
        if (this._buf.length < 9) return;
        const big = this._buf.readBigUInt64BE(1);
        if (big > BigInt(MAX_FRAME)) throw new Error(`frame of ${big} bytes exceeds cap`);
        size = Number(big);
        headLen = 9;
      } else {
        size = this._buf[1];
        headLen = 2;
      }
      if (this._buf.length < headLen + size) return;
      const body = this._buf.subarray(headLen, headLen + size);
      this._buf = this._buf.subarray(headLen + size);

      if (flags & FLAG_COMMAND) {
        // The peer's READY completes the handshake; subscribe at once, because
        // PUB silently discards messages for a peer with no subscription.
        // Anything else (PING, etc.) is ignored by design.
        if (this._phase === 'ready') {
          this._phase = 'streaming';
          this._sock.write(buildSubscribe(this.prefix));
          this.connected = true;
          this.status = 'connected';
          this._backoff = this.minBackoff;
          this.emit('up');
        }
        continue;
      }

      this._frames.push(Buffer.from(body));
      this._msgBytes += body.length;
      if (this._frames.length > MAX_MESSAGE_FRAMES || this._msgBytes > MAX_FRAME) {
        throw new Error('multipart message exceeds cap');
      }
      if (!(flags & FLAG_MORE)) {
        const frames = this._frames;
        this._frames = [];
        this._msgBytes = 0;
        this.emit('message', frames);
      }
    }
  }
}

function createSubscriber(opts, log) {
  return new Subscriber(opts, log);
}

module.exports = {
  createSubscriber, parseUrl,
  buildGreeting, buildReady, buildSubscribe, buildFrame,
  GREETING_LEN, MAX_FRAME, FLAG_MORE, FLAG_LONG, FLAG_COMMAND,
};
