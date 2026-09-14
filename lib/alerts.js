'use strict';
// What to notify about, and when. lib/notify.js is the transport (Pushover);
// this file is the policy — which events matter, how long to wait before
// crying wolf, and what the message actually says.
//
// Everything runs off ONE periodic sweep rather than a timer per worker. That
// falls out of how rigs actually fail: when the pool's uplink hiccups all three
// drop at once, and three separate pushes for one event is noise. A sweep
// coalesces them for free, and it also gets multi-session worker names right —
// a name is only "offline" once its last session is gone.
//
// Serving two algos means two stratum ports but still ONE set of alerts: a rig
// is a name whichever port it is on, and one node outage is one push.

const DEFAULT_SWEEP_MS = 5000;

function fmtDur(sec) {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 90) return Math.round(sec) + 's';
  if (sec < 5400) return Math.round(sec / 60) + 'm';
  return (sec / 3600).toFixed(1) + 'h';
}

const num = n => (Number.isFinite(n) ? n.toLocaleString('en-US') : '—');

// opts: { events, workerOfflineSec, nodeDownSec?, sweepMs?, now? }
function createAlerts(notifier, opts, log) {
  const cfg = opts || {};
  const events = cfg.events || {};
  const now = cfg.now || (() => Date.now());
  // Separate graces on purpose: a rig that flaps for 40 s is an annoyance, but
  // the node being unreachable for 40 s means nothing is being mined at all,
  // so they deserve different patience.
  const workerOfflineMs = Math.max(1, cfg.workerOfflineSec || 30) * 1000;
  const nodeDownMs = Math.max(1, cfg.nodeDownSec || cfg.workerOfflineSec || 30) * 1000;
  const sweepMs = cfg.sweepMs === undefined ? DEFAULT_SWEEP_MS : cfg.sweepMs;

  // workerName -> { lastSeenAt, remote, notified }
  const workers = new Map();
  let nodeDownSince = null;
  let nodeDownNotified = false;
  // Stats instances already reported as unwritable — once each, per process.
  const statePersistNotified = new Set();
  let timer = null;
  let deps = null;
  // One entry per algo served: { algo, shares, stratum, stats }.
  let pipes = [];

  const on = name => events[name] !== false;
  const push = (name, msg) => (on(name) ? notifier.send(msg) : Promise.resolve(false));
  // Which algo — but only when there is more than one to tell apart, so a
  // single-algo pool's messages read exactly as they always have.
  const tagOf = p => (pipes.length > 1 && p.algo ? ` (${p.algo.short})` : '');

  // ---- events driven by the share pipeline ----

  function onBlock(e, p) {
    // Effort is read back from the record stats just wrote rather than from the
    // live counter, because registerBlock resets that counter — and this must
    // not depend on which listener attached first.
    let effort = null;
    if (p.stats) {
      const rec = p.stats.blocks.find(b => b.height === e.height && b.cbTxid === e.cbTxid);
      const v = rec && Number.isFinite(rec.effort) ? rec.effort : p.stats.counters.roundEffort;
      if (Number.isFinite(v) && v > 0) effort = v;
    }
    if (!e.accepted) {
      return push('blockRejected', {
        title: `BLOCK REJECTED at height ${e.height}${tagOf(p)}`,
        message: `The daemon refused the block: ${e.submitResult}\n` +
          `Found by ${e.worker}. This should not happen — please report it.`,
        priority: 1,
      });
    }
    const bits = [e.worker];
    if (Number.isFinite(e.rewardSat)) bits.push((e.rewardSat / 1e8) + ' KRGN');
    if (effort !== null) bits.push('effort ' + Math.round(effort * 100) + '%');
    if (Number.isFinite(e.netDiff)) bits.push('net diff ' + num(Math.round(e.netDiff)));
    // Every algo pays the same address, so the running total is all of them.
    let total = 0;
    for (const q of pipes) if (q.stats) total += q.stats.counters.blocksFound || 0;
    return push('blockFound', {
      title: `Block found — height ${num(e.height)}${tagOf(p)}`,
      message: bits.join(' · ') + (total ? `\n${num(total)} blocks found in total` : ''),
    });
  }

  // ---- the sweep ----

  function sweep() {
    const t = now();
    if (!deps) return;

    // 1. Refresh everything currently authorized, on every port, and notice
    //    recoveries. A rig that moves from one algo's port to the other has
    //    not gone anywhere.
    const back = [];
    for (const p of pipes) {
      if (!p.stratum) continue;
      for (const s of p.stratum.sessions) {
        if (!s.authorized || !s.workerName) continue;
        const w = workers.get(s.workerName);
        // It is here, so by definition it is not offline any more.
        if (w && w.notified) back.push({ name: s.workerName, downFor: (t - w.lastSeenAt) / 1000 });
        workers.set(s.workerName, { lastSeenAt: t, remote: s.remote, notified: false });
      }
    }
    for (const b of back) {
      push('workerOnline', {
        title: `${b.name} is back online`,
        message: `Offline for ${fmtDur(b.downFor)}. ` +
          `${countMiners()} miner(s) connected.`,
      });
    }

    // 2. Anything absent past the grace period, batched into one message.
    const gone = [];
    for (const [name, w] of workers) {
      if (w.notified) continue;
      const downFor = t - w.lastSeenAt;
      if (downFor >= workerOfflineMs) {
        w.notified = true;
        gone.push({ name, remote: w.remote, downFor: downFor / 1000 });
      }
    }
    if (gone.length) {
      const list = gone.map(g => `${g.name}${g.remote ? ' (' + g.remote + ')' : ''}`).join('\n');
      push('workerOffline', {
        title: gone.length === 1 ? `${gone[0].name} is offline` : `${gone.length} workers are offline`,
        message: `No shares for ${fmtDur(gone[0].downFor)}:\n${list}\n` +
          `${countMiners()} miner(s) still connected.`,
      });
    }

    // 3. Node reachability, on its own grace period — a one-poll RPC blip is
    //    not worth a push, but a node that is actually gone stops all mining.
    if (deps.daemon) {
      const up = !!deps.daemon.state.up;
      if (!up) {
        if (nodeDownSince === null) nodeDownSince = t;
        if (!nodeDownNotified && t - nodeDownSince >= nodeDownMs) {
          nodeDownNotified = true;
          push('nodeDown', {
            title: 'Node unreachable — mining stopped',
            message: String(deps.daemon.state.statusText || 'no response from the daemon') +
              `\nDown for ${fmtDur((t - nodeDownSince) / 1000)}.`,
            priority: 1,
          });
        }
      } else {
        if (nodeDownNotified) {
          push('nodeDown', {
            title: 'Node is back online',
            message: `Down for ${fmtDur((t - nodeDownSince) / 1000)}. ` +
              `Now at height ${num(deps.daemon.state.height)}.`,
          });
        }
        nodeDownSince = null;
        nodeDownNotified = false;
      }
    }

    // 4. Blocks silently not being recorded. Fires once per state file.
    for (const p of pipes) {
      if (!p.stats || !p.stats.readOnly || statePersistNotified.has(p.stats)) continue;
      statePersistNotified.add(p.stats);
      push('statePersistFailed', {
        title: `Found blocks are not being recorded${tagOf(p)}`,
        message: 'The state file could not be read at startup, so the pool is ' +
          'refusing to overwrite it. Mining and payouts are unaffected, but ' +
          'nothing new is being saved. Check ownership and permissions on the ' +
          'data directory, then restart.',
        priority: 1,
      });
    }
  }

  function countMiners() {
    let n = 0;
    for (const p of pipes) {
      if (!p.stratum) continue;
      for (const s of p.stratum.sessions) if (s.authorized) n++;
    }
    return n;
  }

  return {
    // d: { daemon, pipelines: [{ algo, shares, stratum, stats }] }, or the
    // single-algo shape { daemon, shares, stratum, stats }.
    // Attach order does not matter — nothing here reads state that another
    // listener is expected to have written first.
    attach(d) {
      deps = d;
      pipes = Array.isArray(d.pipelines) && d.pipelines.length ? d.pipelines
        : [{ algo: null, shares: d.shares, stratum: d.stratum, stats: d.stats }];
      for (const p of pipes) if (p.shares) p.shares.on('block', e => onBlock(e, p));
      // Seed the roster so a rig that never connects after start is not
      // reported as having "gone offline" at second 30.
      sweep();
      if (sweepMs > 0) {
        timer = setInterval(sweep, sweepMs);
        if (timer.unref) timer.unref();
      }
      if (notifier.enabled) {
        log.info('push notifications on — alerting after ' +
          `${Math.round(workerOfflineMs / 1000)}s for a rig, ${Math.round(nodeDownMs / 1000)}s for the node`);
      }
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    _sweep: sweep,
    _workers: workers,
  };
}

module.exports = { createAlerts, fmtDur };
