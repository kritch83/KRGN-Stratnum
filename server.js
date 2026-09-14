#!/usr/bin/env node
'use strict';
// stratnum — solo stratum mining server + dashboard for Kerrigan (KRGN)
// equihash 192/7 and 200/9: either one, or both at once, each on its own
// stratum port. Entry point: config, wiring, lifecycle.
//
// Usage: node server.js [path/to/config.json]

const fs = require('fs');
const path = require('path');
const logLib = require('./lib/log');
const rpcLib = require('./lib/rpc');
const algos = require('./lib/algos');
const { Daemon, externalIpFromConf } = require('./lib/daemon');
const { createNotifier } = require('./lib/notify');
const { createAlerts } = require('./lib/alerts');
const { StratumServer } = require('./lib/stratum');
const { ShareProcessor } = require('./lib/shares');
const { VarDiff } = require('./lib/vardiff');
const { Stats } = require('./lib/stats');
const zmqLib = require('./lib/zmq');
const util = require('./lib/util');
const { createDashboard, THEMES } = require('./lib/dashboard');

const DEFAULTS = {
  node: { host: '127.0.0.1', port: 7121, user: '', pass: '', pollMs: 1000, zmqBlock: '', confPath: '' },
  pool: {
    // port / startDiff / minDiff / maxDiff are the equihash192 port's (see
    // resolvePorts); vardiff is shared by every algo unless one overrides it.
    address: '', port: 3192, bind: '0.0.0.0', coinbaseTag: '',
    startDiff: 8, minDiff: 0.5, maxDiff: 100000,
    vardiff: { targetTime: 15, retargetTime: 90, variancePercent: 30 },
    nTimeToleranceSec: 7200, maxConnections: 100, jobRefreshSec: 30, retainJobs: 5,
  },
  dashboard: { enabled: true, host: '127.0.0.1', port: 8080, historySamples: 180, theme: 'default' },
  data: { dir: './data' },
  log: { level: 'info' },
  // Off unless configured, so an existing config.json keeps working untouched.
  notify: {
    enabled: false, userKey: '', apiToken: '', device: '', sound: '',
    priority: 0, workerOfflineSec: 30, nodeDownSec: 30,
    events: {
      blockFound: true, blockRejected: true, workerOffline: true,
      workerOnline: true, nodeDown: true, statePersistFailed: true,
    },
  },
};

// IPv6 literals need brackets to be readable as host:port.
function hostPort(host, port) {
  return String(host).includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

// A URL a human can actually click: wildcard binds become loopback.
function browsableUrl(host, port) {
  let h = String(host);
  if (h === '0.0.0.0') h = '127.0.0.1';
  else if (h === '::' || h === '::0') h = '[::1]';
  else if (h.includes(':')) h = `[${h}]`;
  return `http://${h}:${port}/`;
}

// One stratum port per algo. The flat pool.port / startDiff / minDiff / maxDiff
// keys ARE the equihash192 port — that is what every config written before
// 200/9 means — so an existing config.json keeps doing exactly what it did. A
// pool.equihash200 block adds a second port, and "enabled": false in either
// block switches that algo off. Whatever a block leaves out comes from that
// algo's own defaults (port, difficulties) and the shared pool.vardiff.
function resolvePorts(pool, rawPool, errors) {
  const ports = [];
  for (const algo of algos.list()) {
    const block = rawPool[algo.key];
    if (block !== undefined && (block === null || typeof block !== 'object' || Array.isArray(block))) {
      errors.push(`pool.${algo.key} must be an object, e.g. { "port": ${algo.port} }`);
      continue;
    }
    const legacy = algo.key === algos.DEFAULT_ALGO;
    if (block ? block.enabled === false : !legacy) continue;
    const base = legacy
      ? { port: pool.port, startDiff: pool.startDiff, minDiff: pool.minDiff, maxDiff: pool.maxDiff }
      : Object.assign({ port: algo.port }, algo.diffDefaults);
    const b = block || {};
    const val = k => (b[k] !== undefined ? b[k] : base[k]);
    ports.push({
      algo,
      where: block ? `pool.${algo.key}` : 'pool',   // names the block in error messages
      port: val('port'),
      startDiff: val('startDiff'),
      minDiff: val('minDiff'),
      maxDiff: val('maxDiff'),
      vardiff: Object.assign({}, pool.vardiff, b.vardiff || {}),
    });
  }
  return ports;
}

// Pure: parsed config.json -> { cfg, errors }. Kept apart from the file
// handling and process.exit in loadConfig so the rules can be tested directly.
function resolveConfig(raw, configPath) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawPool = r.pool && typeof r.pool === 'object' && !Array.isArray(r.pool) ? r.pool : {};
  const merge = (base, over) => Object.assign({}, base, over || {});
  const cfg = {
    node: merge(DEFAULTS.node, r.node),
    pool: Object.assign(merge(DEFAULTS.pool, rawPool), {
      vardiff: merge(DEFAULTS.pool.vardiff, rawPool.vardiff),
    }),
    dashboard: merge(DEFAULTS.dashboard, r.dashboard),
    data: merge(DEFAULTS.data, r.data),
    log: merge(DEFAULTS.log, r.log),
    // Every config.json written before notifications existed has no `notify`
    // block at all, so this section — and its nested `events` — must survive
    // being entirely absent.
    notify: Object.assign(merge(DEFAULTS.notify, r.notify), {
      events: merge(DEFAULTS.notify.events, r.notify && r.notify.events),
    }),
  };
  cfg.data.dir = path.resolve(path.dirname(configPath), cfg.data.dir);

  const errors = [];
  const isPort = p => Number.isInteger(p) && p >= 1 && p <= 65535;
  if (typeof cfg.node.host !== 'string' || !cfg.node.host) errors.push('node.host must be a hostname/IP');
  if (!isPort(cfg.node.port)) errors.push('node.port must be 1..65535 (kerrigan default RPC port is 7121)');
  if (!cfg.node.user || !cfg.node.pass) errors.push('node.user / node.pass must match rpcuser / rpcpassword in kerrigan.conf');
  if (!(cfg.node.pollMs >= 100 && cfg.node.pollMs <= 60000)) errors.push('node.pollMs must be 100..60000');
  if (cfg.node.zmqBlock) {
    try {
      zmqLib.parseUrl(cfg.node.zmqBlock);
    } catch (err) {
      errors.push('node.zmqBlock must be tcp://host:port matching zmqpubhashblock in kerrigan.conf ' +
        `(${err.message})`);
    }
  }
  if (typeof cfg.pool.address !== 'string' || cfg.pool.address.length < 20 || cfg.pool.address.includes('PUT-YOUR')) {
    errors.push('pool.address must be YOUR KRGN payout address (block rewards are paid there directly)');
  }
  if (cfg.pool.coinbaseTag) {
    const { sanitizeTag } = require('./lib/coinbase');
    if (typeof cfg.pool.coinbaseTag !== 'string' || !sanitizeTag(cfg.pool.coinbaseTag)) {
      errors.push('pool.coinbaseTag must be printable ASCII (max 40 chars), e.g. "/my-pool/"');
    }
  }

  cfg.ports = resolvePorts(cfg.pool, rawPool, errors);
  const portOwner = new Map();   // stratum port -> algo key
  for (const p of cfg.ports) {
    if (!isPort(p.port)) {
      errors.push(`${p.where}.port must be 1..65535`);
    } else if (portOwner.has(p.port)) {
      errors.push(`${p.where}.port ${p.port} is already the ${portOwner.get(p.port)} port — every algo needs its own`);
    } else {
      portOwner.set(p.port, p.algo.key);
    }
    if (!(p.minDiff > 0 && p.minDiff <= p.startDiff && p.startDiff <= p.maxDiff && p.maxDiff <= 1e6)) {
      errors.push(`${p.where}: difficulty bounds must satisfy 0 < minDiff <= startDiff <= maxDiff <= 1000000`);
    }
    const vd = p.vardiff;
    if (!(vd.targetTime > 0 && vd.retargetTime >= vd.targetTime && vd.variancePercent >= 0 && vd.variancePercent < 100)) {
      errors.push(`${p.where}.vardiff: need targetTime > 0, retargetTime >= targetTime, 0 <= variancePercent < 100`);
    }
  }
  if (!cfg.ports.length) errors.push('no algo is enabled — enable pool.equihash192 or pool.equihash200');
  if (!(cfg.pool.retainJobs >= 1 && cfg.pool.retainJobs <= 50)) errors.push('pool.retainJobs must be 1..50');
  if (cfg.dashboard.enabled) {
    if (!isPort(cfg.dashboard.port)) {
      errors.push('dashboard.port must be 1..65535');
    } else if (portOwner.has(cfg.dashboard.port)) {
      errors.push(`dashboard.port must differ from the stratum ports (${cfg.dashboard.port} is the ` +
        `${portOwner.get(cfg.dashboard.port)} port)`);
    }
  }
  // Not gated on dashboard.enabled: chart samples are recorded and persisted
  // either way, so this bounds a file on disk, not just a display.
  if (!(Number.isInteger(cfg.dashboard.historySamples) &&
        cfg.dashboard.historySamples >= 10 && cfg.dashboard.historySamples <= 5000)) {
    errors.push('dashboard.historySamples must be an integer 10..5000 ' +
      '(each sample is persisted to data/history.json; 360 ≈ 2 h at the 20 s cadence)');
  }
  if (!THEMES.includes(cfg.dashboard.theme)) {
    errors.push(`dashboard.theme must be one of ${THEMES.map(t => `"${t}"`).join(', ')}`);
  }
  if (!(cfg.log.level in logLib.LEVELS)) errors.push('log.level must be one of error|warn|info|debug');

  if (cfg.notify.enabled) {
    if (!cfg.notify.userKey) errors.push('notify.userKey must be your Pushover user key (find it at pushover.net)');
    if (!cfg.notify.apiToken) errors.push('notify.apiToken must be an application token (create one at pushover.net/apps/build)');
    // Priority 2 is "emergency": it re-alerts until acknowledged and requires
    // retry/expire parameters. Wrong shape for a mining alert, so refuse it
    // rather than silently sending something that nags forever.
    if (!(Number.isInteger(cfg.notify.priority) && cfg.notify.priority >= -2 && cfg.notify.priority <= 1)) {
      errors.push('notify.priority must be an integer -2..1 (2 = emergency is not supported)');
    }
    if (!(cfg.notify.workerOfflineSec >= 10 && cfg.notify.workerOfflineSec <= 3600)) {
      errors.push('notify.workerOfflineSec must be 10..3600 — how long a rig may be silent before alerting');
    }
    if (!(cfg.notify.nodeDownSec >= 10 && cfg.notify.nodeDownSec <= 3600)) {
      errors.push('notify.nodeDownSec must be 10..3600 — how long the daemon may be unreachable before alerting');
    }
  }
  return { cfg, errors };
}

function loadConfig() {
  // Flags must not be mistaken for a config path, or `--test-notify` on its own
  // would send us looking for a file called "--test-notify".
  const positional = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const configPath = path.resolve(positional[0] || path.join(__dirname, 'config.json'));
  if (!fs.existsSync(configPath)) {
    console.error(`config not found: ${configPath}`);
    console.error('Copy config.example.json to config.json and edit it (see README.md).');
    process.exit(1);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error(`${configPath} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  const { cfg, errors } = resolveConfig(raw, configPath);
  if (errors.length) {
    console.error('config errors:');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  return cfg;
}

// `node server.js --test-notify` — send one push and exit. A mock can prove the
// wire format but not that YOUR token, user key and TLS path actually work, and
// finding that out when a block lands is too late.
async function testNotify(cfg) {
  if (!cfg.notify.enabled) {
    console.error('notify.enabled is false in config.json — nothing to test.');
    process.exit(1);
  }
  logLib.setLevel('info');
  const notifier = createNotifier(cfg.notify, logLib.make('notify'));
  const ok = await notifier.send({
    title: 'stratnum test',
    message: 'Notifications are wired up correctly. This is the only message ' +
      'stratnum will ever send that is not about a block, a worker or the node.',
  });
  console.log(ok
    ? 'OK — Pushover accepted the message; check your device.'
    : 'FAILED — see the error above. Nothing was delivered.');
  process.exit(ok ? 0 : 1);
}

async function main() {
  const cfg = loadConfig();
  if (process.argv.includes('--test-notify')) return testNotify(cfg);
  logLib.setLevel(cfg.log.level);
  logLib.addSecret(cfg.node.pass);
  const log = logLib.make('main');
  const startedAt = Date.now();

  log.info(`stratnum starting (pid ${process.pid}, node ${process.version})`);

  const rpc = rpcLib.createClient(cfg.node);
  // Log tags only gain an algo when there are two to tell apart, so a
  // single-algo pool logs exactly as it always has.
  const multi = cfg.ports.length > 1;
  const tag = (name, algo) => (multi ? `${name}[${algo.short}]` : name);
  // Only reachable while the node is DOWN — a running node reports a manual
  // externalip in getnetworkinfo.localaddresses on its own.
  const externalIp = externalIpFromConf(cfg.node.confPath, logLib.make('daemon'));

  // One pipeline per algo: its own template poller, vardiff, stratum port,
  // share processor and stats files. Everything about the NODE is shared.
  const pipelines = cfg.ports.map((p, i) => {
    const { algo } = p;
    const daemon = new Daemon(rpc, {
      algo,
      address: cfg.pool.address,
      pollMs: cfg.node.pollMs,
      jobRefreshSec: cfg.pool.jobRefreshSec,
      externalIp,
      // Peers, sync and masternode status belong to the node, not to an algo,
      // so only the first poller asks.
      connectionsPollMs: i === 0 ? undefined : 0,
    }, logLib.make(tag('daemon', algo)));

    const vardiff = new VarDiff(Object.assign({}, p.vardiff, { minDiff: p.minDiff, maxDiff: p.maxDiff }));

    const stratum = new StratumServer({
      algo,
      port: p.port,
      bind: cfg.pool.bind,
      startDiff: p.startDiff,
      maxConnections: cfg.pool.maxConnections,
      retainJobs: cfg.pool.retainJobs,
      coinbaseTag: cfg.pool.coinbaseTag,
    }, vardiff, logLib.make(tag('stratum', algo)));

    const shares = new ShareProcessor(stratum, daemon, {
      nTimeToleranceSec: cfg.pool.nTimeToleranceSec,
    }, logLib.make(tag('shares', algo)));

    const stats = new Stats({
      dataDir: cfg.data.dir,
      historySamples: cfg.dashboard.historySamples,
      solsPerDiff1: algo.solsPerDiff1,
      // equihash192 keeps the original state.json / history.json, so an
      // existing data dir carries straight on; other algos sit beside it.
      fileTag: algo.key === algos.DEFAULT_ALGO ? '' : algo.key,
    }, logLib.make(tag('stats', algo)));
    stats.attach(shares);

    // Templates only arrive when the daemon accepted our pooladdress in the GBT
    // request, so a served job implies a daemon-validated payout address.
    daemon.on('template', (tpl, clean) => stratum.setTemplate(tpl, clean));

    return {
      algo, port: p.port, startDiff: p.startDiff, minDiff: p.minDiff, maxDiff: p.maxDiff,
      daemon, stratum, shares, stats,
    };
  });

  // The node-level view — health, the payout-address check, ZMQ status — comes
  // from the first poller. The rest are its siblings, so an algo whose
  // templates are unusable still turns the Jobs health check red.
  const daemon = pipelines[0].daemon;
  daemon.siblings = pipelines.slice(1).map(p => p.daemon);

  if (cfg.pool.coinbaseTag) {
    log.info(`coinbase tag "${cfg.pool.coinbaseTag}" will be embedded in found blocks`);
  }

  // Push notifications. The token is a credential, so it joins the RPC password
  // in the log redactor.
  if (cfg.notify.apiToken) logLib.addSecret(cfg.notify.apiToken);
  if (cfg.notify.userKey) logLib.addSecret(cfg.notify.userKey);
  const notifier = createNotifier(cfg.notify, logLib.make('notify'));
  const alerts = createAlerts(notifier, {
    events: cfg.notify.events,
    workerOfflineSec: cfg.notify.workerOfflineSec,
    nodeDownSec: cfg.notify.nodeDownSec,
  }, logLib.make('notify'));
  alerts.attach({ daemon, pipelines });

  // Friendly early check of the payout address (retried until the daemon is up).
  let addressChecked = false;
  const addrTimer = setInterval(async () => {
    if (addressChecked) return clearInterval(addrTimer);
    try {
      const ok = await daemon.validateAddress(cfg.pool.address);
      addressChecked = true;
      clearInterval(addrTimer);
      if (ok) {
        log.info(`payout address ${cfg.pool.address} validated by the daemon`);
      } else {
        log.error(`FATAL: the daemon says pool.address "${cfg.pool.address}" is INVALID — fix config.json`);
        await shutdown(1);
      }
    } catch { /* daemon not reachable yet — retry */ }
  }, 5000);
  if (addrTimer.unref) addrTimer.unref();

  for (const p of pipelines) {
    try {
      await p.stratum.listen();
      log.info(`stratum listening on ${hostPort(cfg.pool.bind, p.port)} for ${p.algo.label} ` +
        `(start diff ${p.startDiff}, vardiff ${p.minDiff}..${p.maxDiff})`);
    } catch (err) {
      log.error(`cannot bind stratum port ${hostPort(cfg.pool.bind, p.port)} for ${p.algo.label}: ${err.message}`);
      process.exit(1);
    }
  }

  let dash = null;
  if (cfg.dashboard.enabled) {
    try {
      dash = createDashboard({ pipelines, daemon, config: cfg, startedAt }, logLib.make('dashboard'));
      await dash.listen();
      log.info(`dashboard at ${browsableUrl(cfg.dashboard.host, cfg.dashboard.port)}`);
    } catch (err) {
      log.error(`cannot bind dashboard ${hostPort(cfg.dashboard.host, cfg.dashboard.port)}: ${err.message}`);
      process.exit(1);
    }
  }

  // Optional: subscribe to the node's block notifications so a new template is
  // fetched the instant the tip changes, instead of up to pollMs later. Purely
  // an accelerator — polling continues regardless, so if this socket dies the
  // pool degrades to exactly its behaviour without it.
  let blockSub = null;
  if (cfg.node.zmqBlock) {
    const zlog = logLib.make('zmq');
    blockSub = zmqLib.createSubscriber({ url: cfg.node.zmqBlock, prefix: 'hashblock' }, zlog);
    blockSub.on('message', frames => {
      if (!frames.length || frames[0].toString('ascii') !== 'hashblock') return;
      daemon.state.zmqStatus = 'connected';
      // A new tip is new work for every algo at once.
      const hash = frames[1] ? frames[1].toString('hex') : '';
      for (const p of pipelines) p.daemon.notifyNewBlock(hash);
    });
    blockSub.on('up', () => {
      daemon.state.zmqStatus = 'connected';
      zlog.info(`subscribed to block notifications at ${cfg.node.zmqBlock}`);
    });
    blockSub.on('down', reason => {
      daemon.state.zmqStatus = reason;
      zlog.warn(`block notifications lost (${reason}) — falling back to ${cfg.node.pollMs}ms polling`);
    });
    blockSub.start();
    daemon.state.zmqStatus = 'connecting';
  } else {
    log.info(`block notifications disabled — set node.zmqBlock (and zmqpubhashblock in kerrigan.conf) ` +
      `to cut new-block detection from ~${Math.round(cfg.node.pollMs / 2)}ms to near zero`);
  }

  for (const p of pipelines) {
    p.daemon.start();
    p.stats.start(p.daemon, () => util.jobNetDiff(p.stratum.currentJob));
  }
  log.info(`waiting for ${pipelines.map(p => p.algo.key).join(' + ')} templates from ` +
    `${hostPort(cfg.node.host, cfg.node.port)} — point miners at ` +
    pipelines.map(p => `stratum+tcp://<this-host>:${p.port}` + (multi ? ` (${p.algo.short})` : '')).join(', '));

  const saveAll = () => {
    for (const p of pipelines) {
      try { p.stats.save(); } catch { /* best effort */ }
    }
  };

  let shuttingDown = false;
  async function shutdown(code) {
    if (shuttingDown) process.exit(code); // second signal: hard exit
    shuttingDown = true;
    log.info('shutting down…');
    clearInterval(addrTimer);
    if (blockSub) blockSub.stop();
    alerts.stop();
    for (const p of pipelines) {
      p.daemon.stop();
      p.stats.stop(); // saves state
    }
    try { if (dash) await dash.close(); } catch { /* closing anyway */ }
    for (const p of pipelines) {
      try { await p.stratum.close(); } catch { /* closing anyway */ }
    }
    rpc.destroy();
    process.exit(code);
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('uncaughtException', err => {
    log.error('uncaught exception:', err);
    saveAll();
    process.exit(1);
  });
  process.on('unhandledRejection', err => {
    log.error('unhandled rejection:', err);
    saveAll();
    process.exit(1);
  });
}

module.exports = { resolveConfig, DEFAULTS };

// Run only when started as a program, so tests can require the config rules.
if (require.main === module) main();
