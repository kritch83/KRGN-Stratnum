'use strict';
// Canned kerrigan daemon for tests: serves a GBT derived from the real block,
// records submits and request params, and can simulate warmup, delays and
// custom block lookups.

const http = require('http');
const fixtures = require('./fixtures');

async function createMockDaemon(overrides) {
  const state = Object.assign({
    template: fixtures.gbtFromRealBlock(),
    // { algoKey: template } — answered by the algo named in the GBT request,
    // as the real node does; anything not listed gets `template`.
    templates: null,
    gbtRequests: [],
    submits: [],
    submitResult: null,       // null => accepted
    warmupError: null,        // { code, message } => getblocktemplate fails
    delayMs: 0,
    concurrentGbt: 0,
    maxConcurrentGbt: 0,
    blockcount: 116369,
    blockhashes: {},          // height -> hash
    blocks: {},               // hash -> verbose getblock result
    addressValid: true,
    // validateaddress's scriptPubKey; by default whatever the template pays,
    // as on the real node, where the template pays the address it was given.
    addressScript: undefined,
    // What the node pays when a template request names no pooladdress (its
    // -mineraddress): undefined = the same as the template, i.e. it matches;
    // '51' = none set (OP_TRUE); any other script = another address.
    mineraddressScript: undefined,
    // decodescript answers: { scriptHex: address }.
    scriptAddresses: {},
    // Health-poll answers. State-driven so a test can drive the zero-peer and
    // behind-the-tip cases; set any of these to null to make that one RPC fail
    // while the others keep answering.
    networkInfo: { connections: 57, connections_in: 12, connections_out: 45, networkactive: true, timeoffset: 0, warnings: '' },
    chainInfo: { blocks: 116369, headers: 116369, initialblockdownload: false, verificationprogress: 1, time: 1700000000 },
    mnSyncStatus: { AssetID: 999, AssetName: 'MASTERNODE_SYNC_FINISHED', IsBlockchainSynced: true, IsSynced: true },
  }, overrides || {});

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(500);
        return res.end('bad json');
      }
      const params = msg.params || [];
      const reply = (result, error) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: result === undefined ? null : result, error: error || null, id: msg.id }));
      };

      const isGbt = msg.method === 'getblocktemplate';
      if (isGbt) {
        state.concurrentGbt++;
        state.maxConcurrentGbt = Math.max(state.maxConcurrentGbt, state.concurrentGbt);
        state.gbtRequests.push({ params, auth: req.headers.authorization || null });
      }
      if (state.delayMs) await new Promise(r => setTimeout(r, state.delayMs));

      try {
        switch (msg.method) {
          case 'getblocktemplate': {
            if (state.warmupError) return reply(null, state.warmupError);
            const want = params[0] && params[0].algo;
            const tpl = state.templates && want && state.templates[want] ? state.templates[want] : state.template;
            if (state.mineraddressScript !== undefined && !(params[0] && params[0].pooladdress) && tpl.coinbasetxn) {
              return reply(Object.assign({}, tpl, { coinbasetxn: {
                data: fixtures.withFirstOutputScript(tpl.coinbasetxn.data, state.mineraddressScript) } }));
            }
            return reply(tpl);
          }
          case 'submitblock':
            state.submits.push(params[0]);
            return reply(state.submitResult);
          case 'getblockcount':
            return reply(state.blockcount);
          case 'getblockhash':
            if (state.blockhashes[params[0]] === undefined) return reply(null, { code: -8, message: 'Block height out of range' });
            return reply(state.blockhashes[params[0]]);
          case 'getblock':
            if (!state.blocks[params[0]]) return reply(null, { code: -5, message: 'Block not found' });
            return reply(state.blocks[params[0]]);
          case 'validateaddress':
            return reply({ isvalid: state.addressValid, address: params[0],
              scriptPubKey: state.addressScript !== undefined ? state.addressScript
                : require('../lib/coinbase').firstOutputScript(state.template.coinbasetxn.data).toString('hex') });
          case 'decodescript':
            return reply(Object.assign({ asm: '', type: 'pubkeyhash' },
              state.scriptAddresses[params[0]] ? { address: state.scriptAddresses[params[0]] } : {}));
          case 'getnetworkinfo':
            if (!state.networkInfo) return reply(null, { code: -1, message: 'getnetworkinfo unavailable' });
            return reply(state.networkInfo);
          case 'getblockchaininfo':
            if (!state.chainInfo) return reply(null, { code: -1, message: 'getblockchaininfo unavailable' });
            return reply(state.chainInfo);
          case 'mnsync':
            // Absent on non-Dash-family forks — same shape as the default arm.
            if (!state.mnSyncStatus) return reply(null, { code: -32601, message: 'Method not found' });
            return reply(state.mnSyncStatus);
          default:
            return reply(null, { code: -32601, message: 'Method not found' });
        }
      } finally {
        if (isGbt) state.concurrentGbt--;
      }
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    server,
    port: server.address().port,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

module.exports = { createMockDaemon };
