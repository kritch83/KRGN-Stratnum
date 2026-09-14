'use strict';
// Read-only dashboard: serves the self-contained page plus two JSON endpoints.
//
// With more than one algo, a snapshot describes ONE of them (?algo=, default
// the first) plus a few numbers about each for the page's switcher. The
// payload stays the size it was, and one algo renders exactly as it always has.

const fs = require('fs');
const http = require('http');
const path = require('path');
const util = require('./util');
const algos = require('./algos');
const { blockEffort } = require('./stats');

const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

function round(v, places) {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

// undefined -> null, so an absent field serialises as an explicit "unknown"
// instead of vanishing from the JSON.
function pick(v) {
  return v === undefined ? null : v;
}

// deps.pipelines: [{ algo, port, stats, stratum, daemon? }], one per algo in
// config order. The single-algo shape used before 200/9 — { stats, stratum,
// config } — reads as one pipeline on the stratum server's own algo.
function pipelinesOf(deps) {
  if (Array.isArray(deps.pipelines) && deps.pipelines.length) return deps.pipelines;
  return [{
    algo: (deps.stratum && deps.stratum.algo) || algos.get(),
    port: deps.config && deps.config.pool ? deps.config.pool.port : null,
    stats: deps.stats,
    stratum: deps.stratum,
  }];
}

// Unknown or absent -> the first algo, so a page still holding a choice the
// server no longer offers gets a working answer instead of an error.
function pickPipeline(pipes, key) {
  return pipes.find(p => p.algo.key === key) || pipes[0];
}

function minersOn(stratum) {
  let n = 0;
  for (const s of stratum.sessions) if (s.authorized) n++;
  return n;
}

// opts.knownHistorySeq: the seq the caller already holds. When it matches, the
// `history` array is left out entirely — it is 60 KB of the 67 KB response and
// only changes once every 20 s, while this is polled every 2 s.
// opts.algo: which algo to describe (see pickPipeline).
function buildSnapshot(deps, opts) {
  const knownHistorySeq = opts && opts.knownHistorySeq;
  const pipes = pipelinesOf(deps);
  const pipe = pickPipeline(pipes, opts && opts.algo);
  const { stats, stratum, algo } = pipe;
  const { daemon, startedAt } = deps;
  const nowMs = Date.now();
  const job = stratum.currentJob;
  const netDiff = util.jobNetDiff(job);
  const netSols = algo.netSolsFromDiff(netDiff);
  const sols5m = stats.solsRate(300);
  const sols1h = stats.solsRate(3600);
  // This algo's own template poller where there is one per algo, so "last
  // template" is about the algo on screen rather than whichever polls first.
  const tplState = (pipe.daemon || daemon).state;

  const workers = [];
  for (const s of stratum.sessions) {
    if (!s.authorized) continue;
    // Per connection, not per name — see Stats.sessionRates.
    const sessionRate = stats.sessionRates(300, s.id, s.connectedAt);
    workers.push({
      name: s.workerName,
      remote: s.remote,
      diff: round(s.diffState.difficulty, 4),
      accepted: s.accepted,
      rejected: s.rejected,
      sols: round(sessionRate.sols, 2),
      sharesPerMin: round(sessionRate.sharesPerMin, 2),
      bestShareDiff: round(s.bestShareDiff, 3),
      lastShareAgoSec: s.lastShareAt ? Math.round((nowMs - s.lastShareAt) / 1000) : null,
      connectedForSec: Math.round((nowMs - s.connectedAt) / 1000),
    });
  }

  const solsPerBlock = netDiff !== null ? netDiff * algo.solsPerDiff1 : null;
  // Walked once: three call sites used to re-scan the whole block list.
  const effort = stats.avgEffort();
  return {
    now: nowMs,
    version: PKG.version,
    uptimeSec: Math.round((nowMs - startedAt) / 1000),
    warmingUp: stats.isWarmingUp(300),
    // What this snapshot describes, and every algo the pool serves: the page
    // draws its switcher from the list and hides it when there is only one.
    algo: { key: algo.key, label: algo.label, short: algo.short },
    algos: pipes.map(p => ({
      key: p.algo.key,
      label: p.algo.label,
      short: p.algo.short,
      port: p.port,
      miners: minersOn(p.stratum),
      sols5m: round(p.stats.solsRate(300), 2),
      blocksFound: p.stats.counters.blocksFound,
    })),
    node: {
      up: daemon.state.up,
      statusText: daemon.state.statusText,
      height: daemon.state.height,
      connections: daemon.state.connections,
      // Health fields are read through `pick` because tests (and any future
      // caller) build daemon.state by hand — a missing key must publish null,
      // not undefined, and must never throw.
      connectionsIn: pick(daemon.state.connectionsIn),
      connectionsOut: pick(daemon.state.connectionsOut),
      localIp: pick(daemon.state.localIp),
      publicIp: pick(daemon.state.publicIp),
      health: typeof daemon.health === 'function'
        ? daemon.health() : { level: daemon.state.up ? 'good' : 'critical', reason: daemon.state.statusText },
      healthChecks: typeof daemon.healthChecks === 'function' ? daemon.healthChecks() : [],
      lastTemplateAgoSec: tplState.lastTemplateAt
        ? Math.round((nowMs - tplState.lastTemplateAt) / 1000) : null,
      // 'off' when not configured; otherwise 'connected' or the failure
      // reason — a silently dead subscriber would just look like slowness.
      zmqStatus: daemon.state.zmqStatus || 'off',
      lastNotifyAgoSec: daemon.state.lastNotifyAt
        ? Math.round((nowMs - daemon.state.lastNotifyAt) / 1000) : null,
    },
    network: {
      difficulty: netDiff !== null ? round(netDiff, 3) : null,
      solsEstimate: netSols !== null ? round(netSols, 1) : null,
    },
    pool: {
      stratumPort: pipe.port,
      minersConnected: workers.length,
      sols5m: round(sols5m, 2),
      sols1h: round(sols1h, 2),
      nextHeight: job ? job.height : null,
      minerRewardKRGN: job ? round(job.minerRewardSat / 1e8, 8) : null,
      timeToBlockSec: solsPerBlock !== null && sols5m > 0 ? Math.round(solsPerBlock / sols5m) : null,
      // When the current round began — the last block we actually found, so
      // the dashboard can say how long we have been grinding on this one.
      roundStartedAt: (() => {
        const b = stats.blocks.find(x => x.status !== 'rejected' && Number.isFinite(x.foundAt));
        return b ? b.foundAt : null;
      })(),
      // Effort as a percentage: 100 = exactly the expected work, and LOWER is
      // better. null until the first block found after effort tracking was
      // added, since it cannot be reconstructed from older records.
      effortPct: effort ? round(effort.effort * 100, 1) : null,
      effortBlocks: effort ? effort.blocks : 0,
      roundEffortPct: (() => { const e = stats.roundEffort(); return Number.isFinite(e) ? round(e * 100, 1) : null; })(),
    },
    totals: {
      acceptedShares: stats.counters.acceptedShares,
      rejectedShares: stats.counters.rejectedShares,
      blocksFound: stats.counters.blocksFound,
      firstStartAt: stats.counters.firstStartAt,
      // False when the state file could not be read at startup and is being
      // left alone rather than overwritten. Blocks found now are NOT being
      // recorded, which must not be discoverable only by reading the log.
      statePersisting: !stats.readOnly,
    },
    rejects: Object.fromEntries(stats.rejects),
    workers,
    blocks: stats.blocks.slice(0, 25).map(b => ({
      height: b.height,
      foundAt: b.foundAt,
      worker: b.worker,
      rewardKRGN: b.rewardSat ? round(b.rewardSat / 1e8, 8) : null,
      status: b.status,
      confirmations: b.confirmations,
      submitResult: b.submitResult,
      hash: b.hash,
      // What this block actually cost, against what one "should". Lower is better.
      effortPct: (() => { const e = blockEffort(b); return e === null ? null : round(e * 100, 1); })(),
    })),
    // Always sent, so the page knows whether what it is holding is current.
    historySeq: stats.historySeq,
    // Omitted (not null) when the caller is already up to date — an absent key
    // means "keep what you have", which is different from "there is none".
    // Mapped, not passed by reference: history is restored from a file on
    // disk, so publish a known shape rather than whatever that file held.
    ...(knownHistorySeq === stats.historySeq ? {} : {
      history: stats.history.map(p => ({
        t: p.t,
        sols: p.sols,
        netSols: p.netSols === undefined ? null : p.netSols,
        netDiff: p.netDiff === undefined ? null : p.netDiff,
      })),
    }),
    historySampleMs: stats.sampleMs(),
  };
}

// Chosen with dashboard.theme in config.json. 'default' is the stock look and
// follows the system light/dark setting; the others are the 80s set.
const THEMES = ['default', '80s-neon', '80s-sunset', '80s-miami'];

// The theme goes on <html> before the page ever reaches the browser, so it
// paints in its own colours from the first frame instead of flashing the
// default ones until the first poll lands.
function themedPage(html, theme) {
  if (!theme || theme === 'default' || !THEMES.includes(theme)) return html;
  return html.replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`);
}

function createDashboard(deps, log) {
  const html = themedPage(
    fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8'),
    deps.config.dashboard && deps.config.dashboard.theme
  );

  const server = http.createServer((req, res) => {
    const [url, query] = (req.url || '/').split('?');
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
      return res.end('{"error":"method not allowed"}');
    }
    try {
      if (url === '/') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        });
        return res.end(html);
      }
      const q = new URLSearchParams(query || '');
      if (url === '/api/stats') {
        return sendJson(res, 200, buildSnapshot(deps, { knownHistorySeq: q.get('h'), algo: q.get('algo') }));
      }
      if (url === '/api/blocks') {
        return sendJson(res, 200, pickPipeline(pipelinesOf(deps), q.get('algo')).stats.blocks);
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      log.error('dashboard error:', err);
      return sendJson(res, 500, { error: 'internal error' });
    }
  });

  function sendJson(res, code, obj) {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(obj));
  }

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(deps.config.dashboard.port, deps.config.dashboard.host, () => {
          server.removeListener('error', reject);
          resolve(server.address().port);
        });
      });
    },
    close() {
      if (server.closeAllConnections) server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = { createDashboard, buildSnapshot, THEMES };
