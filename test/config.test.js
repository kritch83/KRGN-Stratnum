'use strict';
// The config rules. An existing single-algo config.json must mean exactly what
// it always did; a pool.equihash200 block adds a second stratum port.

const path = require('path');
const { assert, assertEq } = require('./t');
const { resolveConfig } = require('../server');

const CONFIG_PATH = path.join(__dirname, 'config.json');   // only its directory is used
const base = () => ({
  node: { user: 'u', pass: 'p' },
  pool: { address: 'KTestPayoutAddress1234567890' },
});
const resolve = raw => resolveConfig(raw, CONFIG_PATH);
const ports = r => r.cfg.ports.map(p => [p.algo.key, p.port]);

const tests = [
  {
    name: 'a config written before 200/9 is one equihash192 port, exactly as before',
    fn() {
      const raw = base();
      Object.assign(raw.pool, {
        port: 3192, startDiff: 128, minDiff: 0.1, maxDiff: 1e6,
        vardiff: { targetTime: 20, retargetTime: 120, variancePercent: 20 },
      });
      const r = resolve(raw);
      assertEq(r.errors, []);
      assertEq(ports(r), [['equihash192', 3192]]);
      const p = r.cfg.ports[0];
      assertEq([p.startDiff, p.minDiff, p.maxDiff], [128, 0.1, 1e6]);
      assertEq(p.vardiff, { targetTime: 20, retargetTime: 120, variancePercent: 20 });
    },
  },
  {
    name: 'a pool.equihash200 block adds a second port with 200/9 defaults',
    fn() {
      const raw = base();
      raw.pool.equihash200 = {};
      const r = resolve(raw);
      assertEq(r.errors, []);
      assertEq(ports(r), [['equihash192', 3192], ['equihash200', 3200]]);
      const p = r.cfg.ports[1];
      assertEq([p.startDiff, p.minDiff, p.maxDiff], [1, 0.05, 100000], '200/9 has its own difficulty scale');
      assertEq(p.vardiff, r.cfg.ports[0].vardiff, 'vardiff timing shared unless overridden');
    },
  },
  {
    name: 'per-algo overrides, and "enabled": false on either side',
    fn() {
      const raw = base();
      raw.pool.equihash200 = { port: 2009, startDiff: 4, vardiff: { targetTime: 10, retargetTime: 60 } };
      const r = resolve(raw);
      assertEq(r.errors, []);
      assertEq(r.cfg.ports[1].port, 2009);
      assertEq(r.cfg.ports[1].startDiff, 4);
      assertEq(r.cfg.ports[1].vardiff, { targetTime: 10, retargetTime: 60, variancePercent: 30 });

      raw.pool.equihash200.enabled = false;
      assertEq(ports(resolve(raw)), [['equihash192', 3192]], 'switched off');

      const only200 = base();
      only200.pool.equihash192 = { enabled: false };
      only200.pool.equihash200 = { port: 3200 };
      assertEq(ports(resolve(only200)), [['equihash200', 3200]], '200/9 alone');

      const none = base();
      none.pool.equihash192 = { enabled: false };
      assert(resolve(none).errors.some(e => /no algo is enabled/.test(e)), 'nothing to serve is an error');
    },
  },
  {
    name: 'port clashes are refused: stratum vs stratum, and the dashboard vs either',
    fn() {
      const raw = base();
      raw.pool.equihash200 = { port: 3192 };
      assert(resolve(raw).errors.some(e => /pool\.equihash200\.port 3192 is already the equihash192 port/.test(e)),
        JSON.stringify(resolve(raw).errors));
      const dash = base();
      dash.pool.equihash200 = { port: 3200 };
      dash.dashboard = { port: 3200 };
      assert(resolve(dash).errors.some(e => /dashboard\.port must differ/.test(e)), JSON.stringify(resolve(dash).errors));
    },
  },
  {
    name: 'each port\'s difficulty bounds are checked on their own',
    fn() {
      const raw = base();
      raw.pool.equihash200 = { startDiff: 0.01, minDiff: 0.05 };   // starts below its own floor
      const r = resolve(raw);
      assertEq(r.errors.length, 1, JSON.stringify(r.errors));
      assert(/^pool\.equihash200: difficulty bounds/.test(r.errors[0]), r.errors[0]);
      const bad = base();
      bad.pool.equihash200 = 'yes';
      assert(resolve(bad).errors.some(e => /pool\.equihash200 must be an object/.test(e)));
    },
  },
  {
    name: 'dashboard.theme: default unless set, and only a known theme is accepted',
    fn() {
      assertEq(resolve(base()).cfg.dashboard.theme, 'default');
      const ok = base();
      ok.dashboard = { theme: '80s-miami' };
      assertEq(resolve(ok).errors, []);
      const bad = base();
      bad.dashboard = { theme: 'vaporwave' };
      const errs = resolve(bad).errors;
      assert(errs.some(e => /dashboard\.theme must be one of "default", "80s-neon", "80s-sunset", "80s-miami"/.test(e)),
        JSON.stringify(errs));
    },
  },
];

module.exports = { tests };
