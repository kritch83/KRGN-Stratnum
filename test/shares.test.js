'use strict';
// Share-pipeline tests replaying the REAL mainnet block through the full
// TCP stratum path. extraNonce1 is pinned (STRATNUM_FORCE_EN1) to the real
// nonce's first 4 bytes so the known-good solution validates end to end.

const { assert, assertEq, assertClose } = require('./t');
const logLib = require('../lib/log');
const util = require('../lib/util');
const algos = require('../lib/algos');
const { StratumServer } = require('../lib/stratum');
const { ShareProcessor } = require('../lib/shares');
const { VarDiff } = require('../lib/vardiff');
const { FakeMiner } = require('./fake-miner');
const fixtures = require('./fixtures');
const families = require('../lib/families');

// KawPoW verifies against an epoch cache; share the one kawpow.test.js keeps,
// and never prune it.
families.get('kawpow').configure({
  cacheDir: require('path').join(require('os').tmpdir(), 'stratnum-kawpow-cache'), prune: false,
});

logLib.setLevel('error');
const log = logLib.make('test-shares');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// algo: which real block to replay (default the 192/7 one).
function realSubmit(algo) {
  return fixtures.realShare(algo);
}

// Break a solution at one hex position. Mutating a different position each
// time yields distinct invalid shares rather than repeats of one.
function mutate(solnHex, at) {
  return solnHex.slice(0, at) + (solnHex[at] === '0' ? '1' : '0') + solnHex.slice(at + 1);
}

function stubDaemon() {
  return {
    submits: [],
    forcePolled: 0,
    result: { ok: true, result: null },
    async submitBlock(hex) { this.submits.push(hex); return this.result; },
    forcePoll() { this.forcePolled++; },
  };
}

// X11 has no real share to replay (see x11.test.js), so its extraNonce1 is
// simply pinned to a known value.
const X11_EN1 = 'aabbccdd';

// Boots a pool with the real-block template, connects a fake miner through
// the real TCP path, and returns everything needed to submit shares.
// algoKey picks the algo and its real block (default 192/7).
async function poolWithRealJob(tplOverrides, poolOpts, vdOpts, algoKey) {
  const classic = algoKey === 'x11';
  process.env.STRATNUM_FORCE_EN1 = classic ? X11_EN1 : realSubmit(algoKey).en1;
  const vardiff = new VarDiff(Object.assign({
    targetTime: 15, retargetTime: 90, variancePercent: 30, minDiff: 0.0001, maxDiff: 1e7,
  }, vdOpts || {}));
  const stratum = new StratumServer(Object.assign({
    algo: algos.get(algoKey),
    port: 0, bind: '127.0.0.1', startDiff: 0.0001, maxConnections: 16, retainJobs: 5, idleCheckMs: 0,
  }, poolOpts || {}), vardiff, log);
  const daemon = stubDaemon();
  const shares = new ShareProcessor(stratum, daemon, { nTimeToleranceSec: 7200 }, log);
  const port = await stratum.listen();
  stratum.setTemplate(fixtures.gbtFromRealBlock(tplOverrides, algoKey), true);
  const m = new FakeMiner(port);
  await m.connect();
  await m.request('mining.subscribe', ['fake-miner/1']);
  await m.request('mining.authorize', ['KAddr.rig', 'x']);
  const target = await m.nextNotification(classic ? 'mining.set_difficulty' : 'mining.set_target');
  const notify = await m.nextNotification('mining.notify');
  const accepted = [];
  const rejected = [];
  const blocks = [];
  shares.on('accepted', e => accepted.push(e));
  shares.on('rejected', e => rejected.push(e));
  shares.on('block', e => blocks.push(e));
  const cleanup = async () => {
    delete process.env.STRATNUM_FORCE_EN1;
    m.close();
    await stratum.close();
  };
  return {
    stratum, shares, daemon, m, jobId: notify.params[0], targetHex: target.params[0], notify: notify.params,
    accepted, rejected, blocks, cleanup,
  };
}

const tests = [
  {
    name: 'real share meets network target -> submitblock byte-identical to on-chain block',
    async fn() {
      const p = await poolWithRealJob();
      try {
        const r = realSubmit();
        const resp = await p.m.request('mining.submit', ['KAddr.rig', p.jobId, r.nTime, r.en2, r.soln]);
        assertEq(resp.error, null, 'share accepted');
        assertEq(resp.result, true);
        assertEq(p.daemon.submits.length, 1, 'block submitted');
        assertEq(p.daemon.submits[0], r.rawHex, 'byte-identical to the real mainnet block');
        assert(p.daemon.forcePolled >= 1, 'template re-poll forced');
        assertEq(p.blocks.length, 1);
        assertEq(p.blocks[0].accepted, true);
        assertEq(p.blocks[0].height, 116370);
        assertEq(p.blocks[0].cbTxid, fixtures.loadBlockJson().tx[0], 'coinbase txid matches explorer');
        assertEq(p.accepted.length, 1);
        assertEq(p.accepted[0].isBlock, true);
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'share below block target -> accepted, no submitblock',
    async fn() {
      const r = realSubmit();
      const p = await poolWithRealJob({ target: util.bigIntToHex64(r.hashBN - 1n) });
      try {
        const resp = await p.m.request('mining.submit', ['KAddr.rig', p.jobId, r.nTime, r.en2, r.soln]);
        assertEq(resp.result, true);
        assertEq(p.daemon.submits.length, 0, 'no block submission');
        assertEq(p.accepted.length, 1);
        assertEq(p.accepted[0].isBlock, false);
        assert(p.accepted[0].shareDiff > 0);
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'duplicate share -> 22, including uppercase-hex resubmission',
    async fn() {
      const r = realSubmit();
      const p = await poolWithRealJob({ target: util.bigIntToHex64(r.hashBN - 1n) });
      try {
        assertEq((await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, r.soln])).result, true);
        assertEq((await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, r.soln])).error[0], 22);
        const upper = await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2.toUpperCase(), r.soln.toUpperCase()]);
        assertEq(upper.error[0], 22, 'case-normalized dup detection');
        assertEq(p.rejected.filter(e => e.code === 22).length, 2);
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: '800-hex solution (no CompactSize prefix) accepted identically',
    async fn() {
      const p = await poolWithRealJob();
      try {
        const r = realSubmit();
        const resp = await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, r.soln.slice(6)]);
        assertEq(resp.result, true);
        assertEq(p.daemon.submits[0], r.rawHex, 'same block bytes');
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'mutated solution -> 20 invalid solution',
    async fn() {
      const r = realSubmit();
      const p = await poolWithRealJob({ target: util.bigIntToHex64(r.hashBN - 1n) });
      try {
        const mutated = r.soln.slice(0, 400) + (r.soln[400] === '0' ? '1' : '0') + r.soln.slice(401);
        const resp = await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, mutated]);
        assertEq(resp.error[0], 20);
        assertEq(resp.error[1], 'invalid solution');
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'malformed sizes -> 20 with specific reasons',
    async fn() {
      const r = realSubmit();
      const p = await poolWithRealJob();
      try {
        const cases = [
          [['w', p.jobId, r.nTime.slice(1), r.en2, r.soln], 'incorrect size of ntime'],
          [['w', p.jobId, r.nTime, r.en2.slice(1), r.soln], 'incorrect size of extranonce2'],
          [['w', p.jobId, r.nTime, r.en2, r.soln.slice(2)], 'incorrect size of solution'],
          [['w', p.jobId, r.nTime, r.en2, 'gg' + r.soln.slice(2)], 'incorrect size of solution'],
        ];
        for (const [params, reason] of cases) {
          const resp = await p.m.request('mining.submit', params);
          assertEq(resp.error[0], 20, reason);
          assertEq(resp.error[1], reason);
        }
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    // The regression that cost a real block: the chain moves on while a share
    // is in flight, and that share turns out to BE a block. It used to die at
    // the job lookup as "job not found" — before anything compared it to the
    // block target — so the daemon never saw it.
    name: 'a block found on a job the chain already superseded is still submitted',
    async fn() {
      const r = realSubmit();
      const dHigh = Number((util.DIFF1 * 2000n) / r.hashBN) / 1000;
      const p = await poolWithRealJob({}, { startDiff: dHigh });
      try {
        // New block lands: miners are told to switch, and the job the miner is
        // still working on is now superseded.
        p.stratum.setTemplate(fixtures.gbtFromRealBlock({
          previousblockhash: 'ab'.repeat(32),
          header_hex: undefined,
        }), true);
        assert(p.stratum.currentJob.id !== p.jobId, 'current job really did move on');

        const resp = await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, r.soln]);
        assertEq(resp.result, true, 'the late share is not thrown away');
        assertEq(p.daemon.submits.length, 1, 'the block reached the daemon');
        assertEq(p.daemon.submits[0], r.rawHex, 'and it serialized to the real block');
        assertEq(p.blocks[0].accepted, true);
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'an unknown job id is still rejected with 21',
    async fn() {
      const p = await poolWithRealJob();
      try {
        const r = realSubmit();
        const resp = await p.m.request('mining.submit', ['w', 'deadbeef', r.nTime, r.en2, r.soln]);
        assertEq(resp.error[0], 21);
        assertEq(resp.error[1], 'job not found');
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'a job aged out of the retain ring is gone for good',
    async fn() {
      const p = await poolWithRealJob({}, { retainJobs: 2 });
      try {
        const r = realSubmit();
        for (let i = 0; i < 3; i++) {
          p.stratum.setTemplate(fixtures.gbtFromRealBlock({ header_hex: undefined }), false);
        }
        const resp = await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, r.soln]);
        assertEq(resp.error[0], 21, 'retainJobs still bounds how far back we look');
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'ntime out of range -> 20 (below job curtime and far future)',
    async fn() {
      const r = realSubmit();
      const p = await poolWithRealJob();
      try {
        const below = await p.m.request('mining.submit', ['w', p.jobId, util.u32LEHex(r.curtime - 1), r.en2, r.soln]);
        assertEq(below.error[1], 'ntime out of range');
        const future = await p.m.request('mining.submit',
          ['w', p.jobId, util.u32LEHex(Math.floor(Date.now() / 1000) + 9000), r.en2, r.soln]);
        assertEq(future.error[1], 'ntime out of range');
        assertEq(p.daemon.submits.length, 0);
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'low difficulty share -> 23 when share target is too hard',
    async fn() {
      const r = realSubmit();
      // Share target ~ hash/2 (rejects), block target just below the hash.
      const dHigh = Number((util.DIFF1 * 2000n) / r.hashBN) / 1000;
      const p = await poolWithRealJob({ target: util.bigIntToHex64(r.hashBN - 1n) }, { startDiff: dHigh });
      try {
        const resp = await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, r.soln]);
        assertEq(resp.error[0], 23);
        assert(String(resp.error[1]).startsWith('low difficulty share'), resp.error[1]);
        assertEq(p.accepted.length, 0);
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'retarget grace: share matching the previous target is booked at previousDifficulty',
    async fn() {
      const r = realSubmit();
      const dHigh = Number((util.DIFF1 * 2000n) / r.hashBN) / 1000;
      const p = await poolWithRealJob({ target: util.bigIntToHex64(r.hashBN - 1n) }, { startDiff: dHigh });
      try {
        const session = [...p.stratum.sessions][0];
        session.prevShareTarget = util.MAX256;
        session.diffState.previousDifficulty = 0.125;
        const resp = await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, r.soln]);
        assertEq(resp.result, true, 'grace accepted');
        assertEq(p.accepted[0].bookedDiff, 0.125, 'booked at previous difficulty');
        assertEq(session.prevShareTarget, util.MAX256, 'grace persists until a current-target accept');
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'block-worthy share is submitted and accepted even above the share target',
    async fn() {
      const r = realSubmit();
      const dHigh = Number((util.DIFF1 * 2000n) / r.hashBN) / 1000;
      const p = await poolWithRealJob({}, { startDiff: dHigh }); // real (meetable) block target
      try {
        const resp = await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, r.soln]);
        assertEq(resp.result, true, 'accepted despite hard share target');
        assertEq(p.daemon.submits.length, 1, 'block submitted first');
        assertEq(p.daemon.submits[0], r.rawHex);
        assertEq(p.accepted[0].isBlock, true);
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'daemon-rejected block: share still accepted, block event marked rejected',
    async fn() {
      const p = await poolWithRealJob();
      try {
        p.daemon.result = { ok: false, result: 'bad-txnmrklroot' };
        const r = realSubmit();
        const resp = await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, r.soln]);
        assertEq(resp.result, true, 'miner is not punished for our submit failure');
        assertEq(p.blocks[0].accepted, false);
        assertEq(p.blocks[0].submitResult, 'bad-txnmrklroot');
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'vardiff retarget after share: set_target then non-clean notify',
    async fn() {
      const r = realSubmit();
      // The real block hash is a ~diff-43000 share, so it passes a diff-8
      // share target comfortably; a pre-aged session then forces a retarget.
      const p = await poolWithRealJob({ target: util.bigIntToHex64(r.hashBN - 1n) }, { startDiff: 8 });
      try {
        const session = [...p.stratum.sessions][0];
        session.diffState.lastRetargetAt = 0;                       // retarget long overdue
        session.diffState.lastShareAt = Date.now() / 1000 - 100;    // 100s gap -> ramp down
        const resp = await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, r.soln]);
        assertEq(resp.result, true);
        const n1 = await p.m.nextNotification();
        const n2 = await p.m.nextNotification();
        assertEq(n1.method, 'mining.set_target', 'retarget sends target first');
        assertEq(n2.method, 'mining.notify');
        assertEq(n2.params[7], false, 're-notify is not clean');
        assert(session.diffState.difficulty < 8, 'difficulty ramped down');
        assertEq(session.diffState.previousDifficulty, 8);
        assert(session.prevShareTarget !== null, 'grace window armed');
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'a run of invalid solutions drops the connection — after the miner is told why',
    async fn() {
      const r = realSubmit();
      const p = await poolWithRealJob({ target: util.bigIntToHex64(r.hashBN - 1n) });
      try {
        // Each one differs from the real solution at its own position, so they
        // are 20 distinct shares rather than 20 duplicates.
        let last = null;
        for (let i = 0; i < 20; i++) last = await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, mutate(r.soln, 400 + i)]);
        assertEq(last.error[1], 'invalid solution', 'the last one is still answered');
        assert(await p.m.waitClose(2000), 'and then the connection goes');
        assertEq(p.rejected.filter(e => e.code === 20).length, 20, 'every one was rejected, none verified twice');
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'a solution that verifies clears the invalid streak, so noise never adds up',
    async fn() {
      const r = realSubmit();
      const p = await poolWithRealJob({ target: util.bigIntToHex64(r.hashBN - 1n) });
      try {
        const session = [...p.stratum.sessions][0];
        for (let i = 0; i < 19; i++) await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, mutate(r.soln, 500 + i)]);
        assertEq(session.invalidStreak, 19, 'one short of the limit');
        assertEq((await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, r.soln])).result, true, 'the real share lands');
        assertEq(session.invalidStreak, 0, 'and clears the streak');
        for (let i = 0; i < 19; i++) await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, mutate(r.soln, 600 + i)]);
        assertEq(p.m.closed, false, '19 twice over, with a good share between, is not a run of 20');
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'the duplicate window holds only shares that verified, and is capped',
    async fn() {
      const r = realSubmit();
      const p = await poolWithRealJob({ target: util.bigIntToHex64(r.hashBN - 1n) });
      try {
        const job = p.stratum.currentJob;
        p.shares.maxSeenPerJob = 2;

        // Junk is never remembered — that flood is what would otherwise fill it.
        assertEq((await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, mutate(r.soln, 700)])).error[1],
          'invalid solution');
        assertEq(job.seen.size, 0, 'an invalid solution leaves no trace');

        // A real share is remembered, and pushes the window past its cap.
        job.seen.add('oldest').add('newer');
        assertEq((await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, r.soln])).result, true);
        assertEq(job.seen.size, 2, 'the window stays at the cap');
        assertEq(job.seen.has('oldest'), false, 'the oldest key goes first');
        assertEq(job.seen.has('newer'), true);

        // …and while it is remembered, a replay is still caught before verifying.
        assertEq((await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, r.soln])).error[0], 22);
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: '200/9: real share meets network target -> submitblock byte-identical to on-chain block',
    async fn() {
      const r = realSubmit('equihash200');
      const p = await poolWithRealJob({}, {}, {}, 'equihash200');
      try {
        const resp = await p.m.request('mining.submit', ['KAddr.rig', p.jobId, r.nTime, r.en2, r.soln]);
        assertEq(resp.error, null, 'share accepted: ' + JSON.stringify(resp.error));
        assertEq(p.daemon.submits.length, 1, 'block submitted');
        assertEq(p.daemon.submits[0], r.rawHex, 'byte-identical to the real 200/9 block');
        assertEq(p.blocks[0].accepted, true);
        assertEq(p.blocks[0].height, 122284);
        assertEq(p.blocks[0].cbTxid, r.cbTxid);
        // Both difficulties are on the 200/9 scale — DIFF1_200, not 192/7's.
        assertClose(p.accepted[0].shareDiff, Number((util.DIFF1_200 * 1000n) / r.hashBN) / 1000, 1e-9, 'share difficulty');
        assertClose(p.accepted[0].netDiff, 19172.409, 1e-6, 'network difficulty from bits 1d1b5891');
        assertClose(p.blocks[0].netDiff, 19172.409, 1e-6);
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: '200/9: bare 2688-hex solution accepted; 192/7-sized solutions are the wrong size here',
    async fn() {
      const r = realSubmit('equihash200');
      const r192 = realSubmit();
      const p = await poolWithRealJob({}, {}, {}, 'equihash200');
      try {
        const wrong = await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, r192.soln]);
        assertEq(wrong.error[1], 'incorrect size of solution', 'an 806-hex 192/7 solution');
        const wrongBare = await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, r192.soln.slice(6)]);
        assertEq(wrongBare.error[1], 'incorrect size of solution', 'an 800-hex one');
        const ok = await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, r.soln.slice(6)]);
        assertEq(ok.result, true, 'the prefix-less 200/9 solution normalizes');
        assertEq(p.daemon.submits[0], r.rawHex, 'same block bytes');
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: '200/9: mutated solution -> 20 invalid solution',
    async fn() {
      const r = realSubmit('equihash200');
      const p = await poolWithRealJob({ target: util.bigIntToHex64(r.hashBN - 1n) }, {}, {}, 'equihash200');
      try {
        const i = 1000;
        const mutated = r.soln.slice(0, i) + (r.soln[i] === '0' ? '1' : '0') + r.soln.slice(i + 1);
        const resp = await p.m.request('mining.submit', ['w', p.jobId, r.nTime, r.en2, mutated]);
        assertEq(resp.error[0], 20);
        assertEq(resp.error[1], 'invalid solution');
        assertEq(p.daemon.submits.length, 0);
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: '200/9: set_target is sent on the 200/9 difficulty scale',
    async fn() {
      const p = await poolWithRealJob({}, { startDiff: 2 }, {}, 'equihash200');
      try {
        assertEq(p.targetHex, util.bigIntToHex64(util.diffToTarget(2, util.DIFF1_200)));
        assert(p.targetHex !== util.bigIntToHex64(util.diffToTarget(2)), 'not the 192/7 scale');
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'KawPoW: the real share replays into a submitblock byte-identical to the on-chain block',
    async fn() {
      const r = realSubmit('kawpow');
      const p = await poolWithRealJob({}, {}, {}, 'kawpow');
      try {
        const resp = await p.m.request('mining.submit', ['w', p.jobId, '0x' + r.nonceHex, '0x' + r.headerHashHex, '0x' + r.mixHex]);
        assertEq(resp.error, null, 'accepted: ' + JSON.stringify(resp.error));
        assertEq(p.daemon.submits.length, 1);
        assertEq(p.daemon.submits[0], r.rawHex, 'byte-identical to block 122281');
        assertEq(p.blocks[0].cbTxid, r.cbTxid);
        assertEq(p.blocks[0].height, 122281);
        // Difficulty on the KawPoW scale (Ravencoin's diff1), not equihash's.
        const blk = fixtures.parseRealBlock('kawpow');
        const target = util.compactToTarget(util.reverseHex(blk.fields.bitsBuf.toString('hex')));
        assertClose(p.blocks[0].netDiff, util.targetToDiff(target, util.DIFF1_KAWPOW), 1e-6);
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'KawPoW: a forged mix that claims to count is fully checked — and rejected as an invalid solution',
    async fn() {
      const r = realSubmit('kawpow');
      const p = await poolWithRealJob({ target: util.bigIntToHex64(1n) }, {}, {}, 'kawpow');
      try {
        // A share target so loose that any final hash "counts": the claimed
        // mix must then be proven, and a forged one fails.
        [...p.stratum.sessions][0].shareTarget = util.MAX256;
        const forged = r.mixHex.slice(0, 63) + (r.mixHex[63] === '0' ? '1' : '0');
        const resp = await p.m.request('mining.submit', ['w', p.jobId, '0x' + r.nonceHex, '0x' + r.headerHashHex, '0x' + forged]);
        assertEq(resp.error[1], 'invalid solution');
        assertEq(p.daemon.submits.length, 0);
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'KawPoW: junk that could not count anyway is turned away as low difficulty, never fully computed',
    async fn() {
      const r = realSubmit('kawpow');
      const p = await poolWithRealJob({ target: util.bigIntToHex64(1n) }, { startDiff: 1 }, {}, 'kawpow');
      const verifier = families.get('kawpow')._getVerifier();
      const realHash = verifier.hash.bind(verifier);
      let calls = 0;
      verifier.hash = (...a) => { calls++; return realHash(...a); };
      try {
        const forged = 'ab'.repeat(32);
        const resp = await p.m.request('mining.submit', ['w', p.jobId, '0x' + r.nonceHex, '0x' + r.headerHashHex, '0x' + forged]);
        assertEq(resp.error[0], 23, 'low difficulty');
        assertEq(calls, 0, 'the worker was never asked');
      } finally {
        verifier.hash = realHash;
        await p.cleanup();
      }
    },
  },
  {
    name: 'KawPoW: wrong header hash, a nonce outside the extranonce range and bad sizes are refused',
    async fn() {
      const r = realSubmit('kawpow');
      const p = await poolWithRealJob({}, {}, {}, 'kawpow');
      try {
        const cases = [
          [['w', p.jobId, '0x' + r.nonceHex, '0x' + 'ab'.repeat(32), '0x' + r.mixHex], 'header hash does not match the job'],
          [['w', p.jobId, '0x' + 'ffff' + r.nonceHex.slice(4), '0x' + r.headerHashHex, '0x' + r.mixHex], 'nonce outside your extranonce range'],
          [['w', p.jobId, '0x' + r.nonceHex.slice(2), '0x' + r.headerHashHex, '0x' + r.mixHex], 'incorrect size of nonce'],
          [['w', p.jobId, '0x' + r.nonceHex, '0x' + r.headerHashHex, '0x' + r.mixHex.slice(2)], 'incorrect size of mix hash'],
        ];
        for (const [params, reason] of cases) {
          const resp = await p.m.request('mining.submit', params);
          assertEq(resp.error[1], reason);
        }
        assertEq(p.daemon.submits.length, 0);
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'KawPoW: the same nonce twice in ONE packet is booked once — the pending set closes the race',
    async fn() {
      const r = realSubmit('kawpow');
      const p = await poolWithRealJob({}, {}, {}, 'kawpow');
      try {
        // Verification is asynchronous here, so without `pending` both copies
        // would pass the duplicate check before either finished.
        const line = id => JSON.stringify({ id, method: 'mining.submit',
          params: ['w', p.jobId, '0x' + r.nonceHex, '0x' + r.headerHashHex, '0x' + r.mixHex] });
        const a = new Promise(res => p.m.pending.set(901, res));
        const b = new Promise(res => p.m.pending.set(902, res));
        p.m.sendRaw(line(901) + '\n' + line(902) + '\n');
        const [ra, rb] = await Promise.all([a, b]);
        assertEq(ra.result, true);
        assertEq(rb.error && rb.error[0], 22, 'second copy is a duplicate');
        assertEq(p.accepted.length, 1, 'booked once');
        assertEq(p.daemon.submits.length, 1, 'one block submission');
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'KawPoW: junk misses rather than fails, so twenty misses in a row drop the connection; a good share clears them',
    async fn() {
      const r = realSubmit('kawpow');
      const p = await poolWithRealJob({ target: util.bigIntToHex64(1n) }, { startDiff: 1 }, {}, 'kawpow');
      try {
        const session = [...p.stratum.sessions][0];
        // Distinct nonces inside the miner's range, each with a made-up mix.
        const junk = i => ['w', p.jobId, '0x' + r.nonceHex.slice(0, 4) + i.toString(16).padStart(12, '0'),
          '0x' + r.headerHashHex, '0x' + 'cd'.repeat(32)];
        for (let i = 0; i < 19; i++) assertEq((await p.m.request('mining.submit', junk(i))).error[0], 23);
        assertEq(session.invalidStreak, 19, 'misses count');
        session.shareTarget = util.MAX256;   // the real share now counts
        assertEq((await p.m.request('mining.submit', ['w', p.jobId, '0x' + r.nonceHex, '0x' + r.headerHashHex, '0x' + r.mixHex])).result, true);
        assertEq(session.invalidStreak, 0, 'an accepted share clears them');
        session.shareTarget = util.diffToTarget(1, util.DIFF1_KAWPOW);
        session.prevShareTarget = null;
        for (let i = 100; i < 119; i++) await p.m.request('mining.submit', junk(i));
        assertEq(p.m.closed, false, '19, a good share, 19 more: not a run of 20');
        const last = await p.m.request('mining.submit', junk(500));
        assertEq(last.error[0], 23, 'the twentieth is still answered');
        assert(await p.m.waitClose(2000), 'and then the connection goes');
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'X11: a share is rebuilt from the miner\'s own fields into the very block the miner assembled',
    async fn() {
      const p = await poolWithRealJob({ target: 'f'.repeat(64) }, {}, {}, 'x11');
      try {
        assertEq(p.notify.length, 9, 'classic notify');
        const tpl = fixtures.gbtFromRealBlock({}, 'x11');
        const ntime = tpl.curtime.toString(16).padStart(8, '0');
        const m = fixtures.x11MinerAssemble(p.notify, X11_EN1, '0000002a', ntime, '01020304');
        const resp = await p.m.request('mining.submit', ['KAddr.rig', p.jobId, '0000002a', ntime, '01020304']);
        assertEq(resp.error, null, 'accepted: ' + JSON.stringify(resp.error));
        assertEq(p.daemon.submits, [m.block.toString('hex')], 'submitblock byte-identical to the miner\'s block');
        assertEq(p.blocks[0].cbTxid, m.cbTxid, 'this share\'s own coinbase txid');
        assertEq(p.blocks[0].height, 122283);
        assertEq(p.accepted[0].shareDiff,
          Number((util.DIFF1_X11 * 1000n) / util.bufToBigIntLE(require('../lib/x11').x11(m.header))) / 1000,
          'booked on the X11 of that header, on the Bitcoin diff-1 scale');
        // Another extranonce2 is another coinbase, so another block.
        await p.m.request('mining.submit', ['KAddr.rig', p.jobId, '0000002b', ntime, '01020304']);
        assertEq(p.daemon.submits[1], fixtures.x11MinerAssemble(p.notify, X11_EN1, '0000002b', ntime, '01020304').block.toString('hex'));
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'X11: misses are low difficulty, and twenty in a row drop the connection',
    async fn() {
      const p = await poolWithRealJob({ target: util.bigIntToHex64(1n) }, { startDiff: 1e6 }, {}, 'x11');
      try {
        const ntime = p.notify[7];
        let last = null;
        for (let i = 0; i < 20; i++) last = await p.m.request('mining.submit', ['w', p.jobId, '00000000', ntime, i.toString(16).padStart(8, '0')]);
        assertEq(last.error[0], 23, 'the last one is still answered');
        assert(await p.m.waitClose(2000), 'and then the connection goes');
        assertEq(p.rejected.filter(e => e.code === 23).length, 20);
      } finally {
        await p.cleanup();
      }
    },
  },
  {
    name: 'X11: version rolling, bad sizes, an out-of-range ntime and a duplicate are refused',
    async fn() {
      const p = await poolWithRealJob({ target: 'f'.repeat(64) }, {}, {}, 'x11');
      try {
        const ntime = p.notify[7];
        const early = (parseInt(ntime, 16) - 1).toString(16).padStart(8, '0');
        const cases = [
          [['w', p.jobId, '00000000', ntime, '00000001', '1fffe000'], 'version rolling is not supported'],
          [['w', p.jobId, '000000', ntime, '00000001'], 'incorrect size of extranonce2'],
          [['w', p.jobId, '00000000', ntime.slice(1), '00000001'], 'incorrect size of ntime'],
          [['w', p.jobId, '00000000', ntime, '0000000001'], 'incorrect size of nonce'],
          [['w', p.jobId, '00000000', early, '00000001'], 'ntime out of range'],
        ];
        for (const [params, reason] of cases) assertEq((await p.m.request('mining.submit', params)).error[1], reason);
        assertEq((await p.m.request('mining.submit', ['w', p.jobId, '00000000', ntime, '00000001'])).result, true);
        const dup = await p.m.request('mining.submit', ['w', p.jobId, '00000000', ntime.toUpperCase(), '00000001']);
        assertEq(dup.error[0], 22, 'the same share again, even in uppercase');
        assertEq(p.daemon.submits.length, 1);
      } finally {
        await p.cleanup();
      }
    },
  },
];

module.exports = { tests };
