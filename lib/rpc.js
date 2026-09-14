'use strict';
// Minimal JSON-RPC-over-HTTP client for the kerrigan daemon.
// Calls are serialized (one in flight) and fail with typed errors:
// kind = 'net' | 'http' | 'rpc' | 'timeout'.

const http = require('http');

class RpcError extends Error {
  constructor(kind, code, message) {
    super(message);
    this.name = 'RpcError';
    this.kind = kind;
    this.code = code;
  }
}

function createClient(cfg) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
  const auth = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64');
  const timeoutMs = cfg.timeoutMs || 10000;
  let idCounter = 1;
  let chain = Promise.resolve();

  function doCall(method, params) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '1.0', id: idCounter++, method, params: params || [] });
      const req = http.request({
        host: cfg.host,
        port: cfg.port,
        method: 'POST',
        path: '/',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: auth,
        },
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode === 401 || res.statusCode === 403) {
            return reject(new RpcError('http', res.statusCode, 'RPC authentication failed — check node.user / node.pass'));
          }
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            return reject(new RpcError('http', res.statusCode, `bad RPC response (HTTP ${res.statusCode}): ${text.slice(0, 160)}`));
          }
          if (parsed.error) return reject(new RpcError('rpc', parsed.error.code, parsed.error.message));
          resolve(parsed.result);
        });
      });
      req.on('error', err => {
        reject(new RpcError('net', err.code || null, `${err.code || err.message} connecting to ${cfg.host}:${cfg.port}`));
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new RpcError('timeout', null, `RPC timeout after ${timeoutMs}ms for ${method}`));
      });
      req.write(body);
      req.end();
    });
  }

  function call(method, params) {
    const p = chain.then(() => doCall(method, params));
    chain = p.catch(() => {});
    return p;
  }

  return { call, destroy: () => agent.destroy() };
}

module.exports = { createClient, RpcError };
