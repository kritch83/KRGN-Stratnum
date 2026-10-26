'use strict';
// Does the node's own payout fallback (-mineraddress in kerrigan.conf) agree
// with the address stratnum mines to (pool.address)?
//
// stratnum names pool.address in every template request, and the node puts
// that first, so blocks stratnum finds pay pool.address whatever this says.
// What it catches is the fallback: anything else that asks the node for a
// template without an address — another pool program, a manual
// getblocktemplate — is paid to -mineraddress, or with none set to a coinbase
// anyone can spend.
//
// No RPC reports -mineraddress, so the node is asked the only way it can be:
// for a template without an address, reading whom its coinbase pays. When the
// two agree the node answers from its template cache; when they differ it
// builds a template, so this runs every few minutes rather than every poll.

const CHECK_MS = 10 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const OP_TRUE = '51';

// opts: { daemon, address, log, intervalMs?, retryMs? }
function createPayoutCheck(opts) {
  const { daemon, address, log } = opts;
  // status: 'unknown' until the first answer, then 'match', 'differs' or
  // 'unset'. A failed check keeps the last answer and records why.
  const state = { address, status: 'unknown', nodeAddress: null, checkedAt: null, error: null };
  let poolScript = null;
  let timer = null;
  let stopped = true;

  function report() {
    if (state.status === 'match') {
      log.info(`node mineraddress matches pool.address (${address})`);
    } else if (state.status === 'differs') {
      log.warn(`node mineraddress is ${state.nodeAddress || 'a different script'}, not pool.address ${address} — ` +
        'blocks stratnum finds still pay pool.address; only template requests that name no address pay the ' +
        `node's. Set mineraddress=${address} in kerrigan.conf (and restart the node) to make them agree`);
    } else if (state.status === 'unset') {
      log.warn('node has no mineraddress set — fine for stratnum, which names pool.address in every request, ' +
        'but a template asked for without one would pay a coinbase anyone can spend. ' +
        `Add mineraddress=${address} to kerrigan.conf`);
    }
  }

  async function check() {
    try {
      if (!poolScript) {
        const info = await daemon.addressInfo(address);
        if (!info.valid || !info.scriptHex) throw new Error('the node returned no script for pool.address');
        poolScript = info.scriptHex;
      }
      const nodeScript = await daemon.fallbackPayoutScript();
      let status = 'differs';
      let nodeAddress = null;
      if (nodeScript === poolScript) {
        status = 'match';
        nodeAddress = address;
      } else if (nodeScript === OP_TRUE) {
        status = 'unset';
      } else {
        try { nodeAddress = await daemon.scriptAddress(nodeScript); } catch { nodeAddress = null; }
      }
      const changed = status !== state.status || nodeAddress !== state.nodeAddress;
      Object.assign(state, { status, nodeAddress, checkedAt: Date.now(), error: null });
      if (changed) report();
      return true;
    } catch (err) {
      state.error = err.message;
      return false;
    }
  }

  function schedule(ms) {
    if (stopped) return;
    timer = setTimeout(async () => {
      const ok = await check();
      schedule(ok ? (opts.intervalMs || CHECK_MS) : (opts.retryMs || RETRY_MS));
    }, ms);
    if (timer.unref) timer.unref();
  }

  return {
    state,
    check,
    start() { stopped = false; schedule(0); },
    stop() { stopped = true; if (timer) clearTimeout(timer); },
  };
}

module.exports = { createPayoutCheck };
