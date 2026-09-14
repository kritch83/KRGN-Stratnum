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

// Boots a pool with the real-block template, connects a fake miner through
// the real TCP path, and returns everything needed to submit shares.
// algoKey picks the algo and its real block (default 192/7).
async function poolWithRealJob(tplOverrides, poolOpts, vdOpts, algoKey) {
  process.env.STRATNUM_FORCE_EN1 = realSubmit(algoKey).en1;
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
  const target = await m.nextNotification('mining.set_target');
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
    stratum, shares, daemon, m, jobId: notify.params[0], targetHex: target.params[0],
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
];

module.exports = { tests };
