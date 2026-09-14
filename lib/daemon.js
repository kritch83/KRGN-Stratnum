'use strict';
// Daemon interface: template polling with clean/refresh classification,
// block submission, and found-block confirmation lookups.
//
// Events:
//   'template' (tpl, clean)   — validated template ready for a new job
//   'templateError' (reason)  — daemon reachable but template unusable
//   'down' (text)             — daemon became unreachable / not ready

const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const jobLib = require('./job');
const algos = require('./algos');

const WARMUP_CODES = new Set([-28, -10, -9]);

// Floor between notification-driven polls. Blocks arrive every ~2 minutes, so
// this only ever bites if something floods the notification socket — in which
// case it stops that becoming a getblocktemplate flood against the node.
const NOTIFY_MIN_INTERVAL_MS = 100;

// Missing/garbage fields become null, never 0 — for peers those mean opposite
// things (unknown vs. "the node cannot mine").
function num(v) {
  return Number.isFinite(v) ? v : null;
}

// Addresses the node reports for itself that are NOT its public address.
// `discover=1` finds interface addresses too, so without this filter the tile
// would happily present 10.0.0.20 as the WAN address.
function isPrivateAddr(a) {
  const s = String(a || '').toLowerCase();
  if (!s) return true;
  if (s === '::1' || s.startsWith('127.')) return true;
  if (s.startsWith('10.') || s.startsWith('192.168.') || s.startsWith('169.254.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  if (s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd')) return true;
  if (s.endsWith('.onion') || s.endsWith('.i2p')) return true;   // not reachable as an IP
  return false;
}

// The LAN address of the machine the pool runs on — the one to point rigs at.
// Read once: it does not change under a running pool, and an interface list is
// not worth walking on a timer.
function localIpv4() {
  try {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a && a.family === 'IPv4' && !a.internal) return a.address;
      }
    }
  } catch { /* not worth failing a pool over */ }
  return null;
}

// `externalip=` from kerrigan.conf. Only ever consulted as a fallback for when
// the node is DOWN: while it is up it reports a manually set externalip in
// localaddresses itself, so this file is redundant in the normal case.
function externalIpFromConf(confPath, log) {
  if (!confPath) return null;
  let text;
  try {
    text = fs.readFileSync(confPath, 'utf8');
  } catch (err) {
    log.warn(`could not read node.confPath (${confPath}): ${err.code} — ` +
      'the public IP will come from the node only');
    return null;
  }
  let found = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^externalip\s*=\s*(.+)$/i.exec(line);
    if (m) found = m[1].trim().replace(/^\[|\]$/g, '').split('#')[0].trim();
  }
  return found || null;
}

// getnetworkinfo.localaddresses -> the best public address, or null.
// Score is the node's own confidence ranking and a manual `externalip` carries
// the highest one, so "highest score wins" IS the precedence rule: manual
// first, discovered second.
function pickPublicIp(list) {
  if (!Array.isArray(list)) return null;
  const routable = list
    .filter(e => e && typeof e.address === 'string' && !isPrivateAddr(e.address))
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  return routable.length ? routable[0].address : null;
}

class Daemon extends EventEmitter {
  // opts: { algo?, address, pollMs, jobRefreshSec, backoffMs?, connectionsPollMs?, externalIp? }
  // One Daemon polls templates for ONE algo (default equihash192). A pool
  // serving two runs two over the same rpc client: only the first polls node
  // health, and it lists the other in `siblings` so the Jobs check covers both.
  constructor(rpc, opts, log) {
    super();
    this.rpc = rpc;
    this.opts = opts;
    this.log = log;
    this.algo = (opts && opts.algo) || algos.get();
    this.siblings = [];
    this.state = {
      up: false,
      statusText: 'starting',
      height: null,
      connections: null,
      lastTemplateAt: 0,
      consecutiveFailures: 0,
      lastNotifyAt: 0,
      zmqStatus: 'off',   // set by the block-notification subscriber, if any
      // Filled by _pollHealth. null everywhere means "not asked yet / the call
      // failed" — never "zero", which for peers is a mining-stopping state.
      connectionsIn: null,
      connectionsOut: null,
      chainBlocks: null,
      chainHeaders: null,
      ibd: null,
      tipTime: null,
      mnSynced: null,     // null when the node has no mnsync RPC at all
      // Sticky: keep the last known public address across a poll failure, so a
      // momentary RPC blip does not blank the tile.
      publicIp: (opts && opts.externalIp) || null,
      localIp: localIpv4(),
    };
    this._timer = null;
    this._connTimer = null;
    this._busy = false;
    this._stopped = true;
    this._forceQueued = false;
    this._lastNotifyAt = 0;
    this._lastPrev = null;
    this._lastTxCount = -1;
    this._lastJobAt = 0;
  }

  gbtParams() {
    return [{
      capabilities: ['coinbasetxn', 'workid', 'coinbase/append'],
      pooladdress: this.opts.address,
      algo: this.algo.key,
    }];
  }

  start() {
    this._stopped = false;
    this._schedule(0);
    const connMs = this.opts.connectionsPollMs === undefined ? 15000 : this.opts.connectionsPollMs;
    if (connMs > 0) {
      this._connTimer = setInterval(() => this._pollHealth(), connMs);
      if (this._connTimer.unref) this._connTimer.unref();
      this._pollHealth();
    }
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    if (this._connTimer) clearInterval(this._connTimer);
  }

  // A block notification (ZMQ) is a *hint* to re-poll right now, never a
  // source of truth: the hash is only logged, and the template still comes
  // from getblocktemplate. Returns false when rate-limited.
  notifyNewBlock(hashHex) {
    const now = Date.now();
    if (now - this._lastNotifyAt < NOTIFY_MIN_INTERVAL_MS) return false;
    this._lastNotifyAt = now;
    this.state.lastNotifyAt = now;
    this.log.debug(`block notification ${String(hashHex || '').slice(0, 16)}… — refreshing template now`);
    this.forcePoll();
    return true;
  }

  // Request an immediate re-poll (e.g. right after a block submit).
  forcePoll() {
    if (this._busy) {
      this._forceQueued = true;
    } else {
      this._schedule(0);
    }
  }

  _schedule(ms) {
    if (this._stopped) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._tick(), ms);
    if (this._timer.unref) this._timer.unref();
  }

  async _tick() {
    if (this._busy) return;
    this._busy = true;
    let nextMs = this.opts.pollMs;
    try {
      const tpl = await this.rpc.call('getblocktemplate', this.gbtParams());
      this.state.consecutiveFailures = 0;
      this.state.lastTemplateAt = Date.now();
      const wasUp = this.state.up;
      this.state.up = true;

      const gate = jobLib.validateTemplate(tpl, this.algo);
      if (!gate.ok) {
        if (this.state.statusText !== 'bad template: ' + gate.reason) {
          this.log.error('unusable template:', gate.reason);
        }
        this.state.statusText = 'bad template: ' + gate.reason;
        this.emit('templateError', gate.reason);
      } else {
        this.state.statusText = 'ok';
        this.state.height = tpl.height;
        if (!wasUp) this.log.info(`daemon ok — serving ${this.algo.key} templates at height ${tpl.height}`);

        const prevChanged = tpl.previousblockhash !== this._lastPrev;
        const txCount = (tpl.transactions || []).length;
        const refreshDue = (Date.now() - this._lastJobAt) >= this.opts.jobRefreshSec * 1000;
        if (prevChanged || txCount !== this._lastTxCount || refreshDue) {
          this._lastPrev = tpl.previousblockhash;
          this._lastTxCount = txCount;
          this._lastJobAt = Date.now();
          this.emit('template', tpl, prevChanged);
        }

        const skew = Math.abs(tpl.curtime - Math.floor(Date.now() / 1000));
        if (skew > 300 && !this._skewWarned) {
          this._skewWarned = true;
          this.log.warn(`daemon curtime differs from local clock by ${skew}s — check NTP on both machines`);
        }
      }
    } catch (err) {
      this.state.consecutiveFailures++;
      const wasUp = this.state.up;
      this.state.up = false;
      let text;
      if (err.kind === 'rpc' && WARMUP_CODES.has(err.code)) text = 'daemon not ready: ' + err.message;
      else if (err.kind === 'rpc') text = `RPC error ${err.code}: ${err.message}`;
      else text = err.message;
      if (this.state.statusText !== text) {
        this.log.warn('daemon unavailable:', text);
        this.emit('down', text);
      }
      this.state.statusText = text;
      if (wasUp) {
        // Force a clean job as soon as the daemon returns.
        this._lastPrev = null;
      }
      if (this.state.consecutiveFailures >= 3) nextMs = this.opts.backoffMs || 5000;
    } finally {
      this._busy = false;
      this._schedule(this._forceQueued ? 0 : nextMs);
      this._forceQueued = false;
    }
  }

  // Three cheap calls, each guarded on its own so one failure cannot blank the
  // other two. Deliberately NOT getpeerinfo (tens of KB per reply) or
  // getmininginfo (five 120-block walks per call).
  async _pollHealth() {
    const s = this.state;
    try {
      // getnetworkinfo carries the same count as getconnectioncount plus the
      // in/out split, for the same round trip.
      const n = await this.rpc.call('getnetworkinfo', []);
      s.connections = num(n && n.connections);
      s.connectionsIn = num(n && n.connections_in);
      s.connectionsOut = num(n && n.connections_out);
      // The node has already applied BOTH `discover=1` and a manual
      // `externalip=` by the time it answers here — a manually set address is
      // added with the highest score — so this one field settles which public
      // address to show without reading kerrigan.conf at all.
      s.publicIp = pickPublicIp(n && n.localaddresses) || s.publicIp;
    } catch {
      s.connections = null;
      s.connectionsIn = null;
      s.connectionsOut = null;
    }

    try {
      const c = await this.rpc.call('getblockchaininfo', []);
      s.chainBlocks = num(c && c.blocks);
      s.chainHeaders = num(c && c.headers);
      s.ibd = c && c.initialblockdownload !== undefined ? !!c.initialblockdownload : null;
      s.tipTime = num(c && c.time);
    } catch {
      s.chainBlocks = null;
      s.chainHeaders = null;
      s.ibd = null;
    }

    try {
      const m = await this.rpc.call('mnsync', ['status']);
      // Dash-family capitalisation. Anything unrecognised stays null rather
      // than being read as "not synced".
      s.mnSynced = m && m.IsBlockchainSynced !== undefined ? !!m.IsBlockchainSynced : null;
    } catch (err) {
      // A fork without the RPC is not a fault — leave it unknown so health()
      // ignores it entirely instead of flagging every poll.
      if (!(err.kind === 'rpc' && err.code === -32601)) this.log.debug('mnsync failed:', err.message);
      s.mnSynced = null;
    }
  }

  // Pure: the individual things that have to be true for this node to mine,
  // each answered separately so "Degraded" can say WHICH one degraded. Fixed
  // order — the dashboard renders them as a row and they must not jump around.
  //
  // 'fail' is reserved for states that actually stop template production, so a
  // red pip always means work has halted. Sync lag is 'warn' because blocks
  // still flow while it catches up. 'unknown' is not a fault: it means the RPC
  // that answers this question did not reply, which must never be read as zero.
  healthChecks() {
    const s = this.state;
    const down = !s.up;
    const behind = s.chainHeaders !== null && s.chainBlocks !== null
      ? s.chainHeaders - s.chainBlocks : null;
    // A stratum port with no work to hand out — from this poller or, when one
    // node feeds several algos, a sibling's. A sibling that cannot fetch at
    // all while this one can is the same fault: the node answers, so it is
    // that algo's request that is failing. One still 'starting' has simply
    // not asked yet.
    const badTemplate = d => typeof d.state.statusText === 'string' && d.state.statusText.startsWith('bad template');
    const sibling = (this.siblings || []).find(d =>
      badTemplate(d) || (!d.state.up && d.state.statusText !== 'starting'));
    const tagged = (d, text) => (this.siblings && this.siblings.length ? `${d.algo.short}: ${text}` : text);
    const jobsFault = badTemplate(this) ? tagged(this, s.statusText)
      : sibling ? tagged(sibling, sibling.state.statusText) : null;

    return [
      {
        key: 'rpc',
        label: 'RPC',
        status: down ? 'fail' : 'pass',
        // The Node tile already prints the transport error verbatim; no point
        // filling two boxes with one sentence.
        detail: down ? 'node unreachable — mining stopped' : 'daemon answering',
      },
      {
        key: 'peers',
        label: 'Peers',
        // getblocktemplate returns RPC_CLIENT_NOT_CONNECTED at zero peers, so
        // this is a hard stop, not a cosmetic warning.
        status: s.connections === null ? 'unknown' : s.connections === 0 ? 'fail' : 'pass',
        detail: s.connections === null ? 'peer count unavailable'
          : s.connections === 0 ? 'no peers — node cannot build templates'
            : `${s.connections} connected`,
      },
      {
        key: 'sync',
        label: 'Sync',
        status: s.ibd === true ? 'fail'
          : behind === null ? 'unknown'
            : behind > 1 ? 'warn' : 'pass',
        detail: s.ibd === true ? 'initial block download'
          : behind === null ? 'chain height unavailable'
            : behind > 1 ? `${behind.toLocaleString('en-US')} blocks behind`
              : 'at the chain tip',
      },
      {
        key: 'jobs',
        label: 'Jobs',
        // Templates arriving but unusable is still "no jobs go out".
        status: down ? 'unknown' : jobsFault ? 'fail' : 'pass',
        detail: down ? 'no templates while the node is down' : jobsFault || 'templates usable',
      },
      {
        key: 'mnsync',
        label: 'MN',
        // Absent on forks without the RPC — unknown, never a fault.
        status: s.mnSynced === null ? 'unknown' : s.mnSynced === false ? 'warn' : 'pass',
        detail: s.mnSynced === null ? 'masternode sync not reported'
          : s.mnSynced === false ? 'masternode sync incomplete' : 'masternode synced',
      },
    ];
  }

  // One verdict, derived from healthChecks() so there is a single source of
  // truth: worst status wins, and the reason comes from the first check that
  // is not passing.
  health() {
    const checks = this.healthChecks();
    const bad = checks.find(c => c.status === 'fail');
    if (bad) return { level: 'critical', reason: bad.detail };
    const warn = checks.find(c => c.status === 'warn');
    if (warn) return { level: 'warn', reason: warn.detail };
    return { level: 'good', reason: 'all clear' };
  }

  // Returns { ok, result } — result is null on acceptance, otherwise the
  // daemon's reject string (or a transport error description).
  async submitBlock(hex) {
    try {
      const res = await this.rpc.call('submitblock', [hex]);
      const result = res === undefined ? null : res;
      return { ok: result === null, result };
    } catch (err) {
      return { ok: false, result: 'rpc error: ' + err.message };
    }
  }

  // Classify a previously-found block by checking whether the chain at that
  // height still carries our coinbase txid.
  async classifyBlock(height, cbTxidDisplay) {
    const tip = await this.rpc.call('getblockcount', []);
    if (tip < height) return { status: 'pending', confirmations: 0, hash: null };
    let hash;
    try {
      hash = await this.rpc.call('getblockhash', [height]);
    } catch {
      return { status: 'pending', confirmations: 0, hash: null };
    }
    const block = await this.rpc.call('getblock', [hash]);
    if (block && Array.isArray(block.tx) && block.tx[0] === cbTxidDisplay) {
      const confirmations = Number.isInteger(block.confirmations) ? block.confirmations : tip - height + 1;
      return { status: 'confirmed', confirmations, hash };
    }
    return tip - height >= 6
      ? { status: 'orphaned', confirmations: 0, hash }
      : { status: 'pending', confirmations: 0, hash: null };
  }

  async validateAddress(addr) {
    const res = await this.rpc.call('validateaddress', [addr]);
    return !!(res && res.isvalid);
  }
}

module.exports = { Daemon, pickPublicIp, isPrivateAddr, localIpv4, externalIpFromConf };
