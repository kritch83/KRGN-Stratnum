'use strict';
const { assert, assertEq, assertThrows } = require('./t');
const util = require('../lib/util');
const jobLib = require('../lib/job');
const algos = require('../lib/algos');
const fixtures = require('./fixtures');

const tests = [
  {
    name: 'job from real-block template reserializes the block byte-identically',
    fn() {
      const blk = fixtures.parseRealBlock();
      const job = jobLib.buildJob(fixtures.gbtFromRealBlock(), 'j1');
      assert(job.headerHexChecked, 'header_hex self-check ran');

      const f = blk.fields;
      const header = jobLib.serializeHeader(job, util.u32LE(f.nTime), Buffer.from(f.nonce));
      assertEq(header, Buffer.from(blk.header), 'header bytes');

      const block = jobLib.serializeBlock(job, header, Buffer.from(blk.solutionWithPrefix));
      assertEq(block, blk.raw, 'full block byte-identical to on-chain block');
    },
  },
  {
    name: 'notify params 1..6 are the literal header bytes [0,108)',
    fn() {
      const blk = fixtures.parseRealBlock();
      const job = jobLib.buildJob(fixtures.gbtFromRealBlock(), 'j1');
      const p = jobLib.notifyParams(job, true);
      const reassembled = Buffer.concat([1, 2, 3, 4, 5, 6].map(i => util.hexToBuf(p[i])));
      assertEq(reassembled, blk.header.subarray(0, 108), 'params are header bytes');
      assertEq(p[1], '00060020', 'version LE hex verbatim');
      assertEq(p[7], true, 'cleanJobs at index 7');
      assertEq(p[8], '192_7', 'algo extension');
      assertEq(p[9], 'kerrigan', 'personalization extension');
      assertEq(p.length, 10);
    },
  },
  {
    name: 'header_hex self-check trips on any prefix disagreement',
    fn() {
      // Nonzero asymmetric sapling root, header_hex built to match the
      // correctly-reversed serialization...
      const sapDisplay = 'aa'.repeat(16) + 'bb'.repeat(16);
      const base = fixtures.gbtFromRealBlock();
      const saplingBuf = util.reverseBuf(util.hexToBuf(sapDisplay));
      const goodHeaderHex =
        util.hexToBuf(base.header_hex).subarray(0, 68).toString('hex') +
        saplingBuf.toString('hex') +
        util.hexToBuf(base.header_hex).subarray(100, 140).toString('hex');
      const tpl = fixtures.gbtFromRealBlock({ finalsaplingroothash: sapDisplay, header_hex: goodHeaderHex });
      const job = jobLib.buildJob(tpl, 'j1'); // must not throw
      assert(job.headerHexChecked);

      // ...and the same template with an un-reversed daemon header must trip.
      const badHeaderHex =
        util.hexToBuf(base.header_hex).subarray(0, 68).toString('hex') +
        sapDisplay +
        util.hexToBuf(base.header_hex).subarray(100, 140).toString('hex');
      const err = assertThrows(() =>
        jobLib.buildJob(fixtures.gbtFromRealBlock({ finalsaplingroothash: sapDisplay, header_hex: badHeaderHex }), 'j2')
      );
      assert(String(err.message).includes('header_hex self-check failed'), err.message);
    },
  },
  {
    name: 'daemon header_hex with unset (zeroed) merkle root is accepted, other fields still gated',
    fn() {
      // The live daemon serves header_hex with the merkle-root field zeroed
      // (observed on mainnet) — the gate must skip that segment...
      const base = fixtures.gbtFromRealBlock();
      const hh = util.hexToBuf(base.header_hex);
      const zeroMerkle = Buffer.concat([hh.subarray(0, 36), Buffer.alloc(32), hh.subarray(68)]);
      const job = jobLib.buildJob(fixtures.gbtFromRealBlock({ header_hex: zeroMerkle.toString('hex') }), 'j1');
      assert(job.headerHexChecked, 'accepted with unset merkle');

      // ...while still tripping on any real disagreement elsewhere (nTime here).
      const badTime = Buffer.from(zeroMerkle);
      badTime[100] ^= 0xff;
      const err = assertThrows(() =>
        jobLib.buildJob(fixtures.gbtFromRealBlock({ header_hex: badTime.toString('hex') }), 'j2'));
      assert(String(err.message).includes('header_hex self-check failed'), err.message);
    },
  },
  {
    name: 'template gate rejects wrong algo / params / missing coinbasetxn',
    fn() {
      const x11Version = (fixtures.gbtFromRealBlock().version & ~0xf00) | 0x000; // algo nibble 0
      assert(!jobLib.validateTemplate(fixtures.gbtFromRealBlock({ version: x11Version })).ok, 'x11 template rejected');
      assert(!jobLib.validateTemplate(fixtures.gbtFromRealBlock({ equihash_n: 200, equihash_k: 9 })).ok, '200/9 rejected');
      assert(!jobLib.validateTemplate(fixtures.gbtFromRealBlock({ personalization: 'ZcashPoW!' })).ok, '9-char pers rejected');
      assert(!jobLib.validateTemplate(fixtures.gbtFromRealBlock({ coinbasetxn: undefined })).ok, 'missing coinbasetxn rejected');
      assert(!jobLib.validateTemplate(fixtures.gbtFromRealBlock({ target: 'xyz' })).ok, 'bad target rejected');
      assert(jobLib.validateTemplate(fixtures.gbtFromRealBlock()).ok, 'real template accepted');
    },
  },
  {
    name: 'merkle edge cases: 0 extra txs and odd tx counts',
    fn() {
      const noTx = jobLib.buildJob(fixtures.gbtFromRealBlock({
        transactions: [],
        // header_hex would disagree (different merkle root) — drop it for this synthetic case.
        header_hex: undefined,
      }), 'j1');
      assertEq(noTx.txCount, 1);
      const cbHash = util.sha256d(noTx.coinbaseData);
      assertEq(noTx.prefix100.subarray(36, 68), cbHash, 'root == coinbase hash with no txs');

      // Odd count: coinbase + 2 identical-format txs -> 3 leaves.
      const base = fixtures.gbtFromRealBlock();
      const tx = base.transactions[0];
      const odd = jobLib.buildJob(fixtures.gbtFromRealBlock({
        transactions: [tx, tx],
        header_hex: undefined,
      }), 'j2');
      const leafCb = util.sha256d(odd.coinbaseData);
      const leafTx = util.reverseBuf(util.hexToBuf(tx.txid));
      const expected = util.merkleRoot([leafCb, leafTx, leafTx]);
      assertEq(odd.prefix100.subarray(36, 68), expected, 'odd-count merkle');
      assertEq(odd.txCount, 3);
    },
  },
  {
    name: 'sapling field absent -> 32 zero bytes in header',
    fn() {
      const job = jobLib.buildJob(fixtures.gbtFromRealBlock({ finalsaplingroothash: undefined }), 'j1');
      assertEq(job.prefix100.subarray(68, 100), Buffer.alloc(32));
      assert(job.headerHexChecked, 'still matches daemon header (real block sapling is zeros)');
    },
  },
  {
    name: 'serializeBlock rejects malformed solution',
    fn() {
      const blk = fixtures.parseRealBlock();
      const job = jobLib.buildJob(fixtures.gbtFromRealBlock(), 'j1');
      const header = jobLib.serializeHeader(job, util.u32LE(blk.fields.nTime), Buffer.from(blk.fields.nonce));
      assertThrows(() => jobLib.serializeBlock(job, header, blk.solution), 'missing prefix rejected');
      assertThrows(() => jobLib.serializeBlock(job, header.subarray(1), blk.solutionWithPrefix), 'short header rejected');
    },
  },
  {
    name: '200/9: job from the real block reserializes it byte-identically',
    fn() {
      const algo = algos.get('equihash200');
      const blk = fixtures.parseRealBlock('equihash200');
      const job = jobLib.buildJob(fixtures.gbtFromRealBlock({}, 'equihash200'), 'j1', { algo });
      assert(job.headerHexChecked, 'header_hex self-check ran');
      assertEq(job.algo.key, 'equihash200');
      assertEq(job.personalization, 'ZcashPoW');
      const f = blk.fields;
      const header = jobLib.serializeHeader(job, util.u32LE(f.nTime), Buffer.from(f.nonce));
      assertEq(header, Buffer.from(blk.header), 'header bytes');
      assertEq(jobLib.serializeBlock(job, header, Buffer.from(blk.solutionWithPrefix)), blk.raw,
        'full block byte-identical to on-chain block');
      // A 192/7-shaped solution has no business in a 200/9 block.
      assertThrows(() => jobLib.serializeBlock(job, header, fixtures.parseRealBlock().solutionWithPrefix));
    },
  },
  {
    name: '200/9: notify carries version 0x20000400, "200_9" and "ZcashPoW"',
    fn() {
      const job = jobLib.buildJob(fixtures.gbtFromRealBlock({}, 'equihash200'), 'j1', { algo: algos.get('equihash200') });
      const p = jobLib.notifyParams(job, true);
      assertEq(p[1], '00040020', 'version LE verbatim');
      assertEq(p[8], '200_9');
      assertEq(p[9], 'ZcashPoW');
      assertEq(p.length, 10);
    },
  },
  {
    name: 'each algo refuses the other algo\'s template',
    fn() {
      const a192 = algos.get('equihash192');
      const a200 = algos.get('equihash200');
      const t192 = fixtures.gbtFromRealBlock();
      const t200 = fixtures.gbtFromRealBlock({}, 'equihash200');
      assert(jobLib.validateTemplate(t192, a192).ok, '192/7 on 192/7');
      assert(jobLib.validateTemplate(t200, a200).ok, '200/9 on 200/9');
      const x = jobLib.validateTemplate(t200, a192);
      assert(!x.ok && /not equihash192/.test(x.reason), x.reason);
      const y = jobLib.validateTemplate(t192, a200);
      assert(!y.ok && /not equihash200/.test(y.reason), y.reason);
      // Right version nibble but the daemon's own label or parameters disagree.
      assert(!jobLib.validateTemplate(fixtures.gbtFromRealBlock({ algo: 'equihash192' }, 'equihash200'), a200).ok);
      assert(!jobLib.validateTemplate(fixtures.gbtFromRealBlock({ equihash_n: 192, equihash_k: 7 }, 'equihash200'), a200).ok);
      // No personalization in the template -> the algo's own.
      const bare = fixtures.gbtFromRealBlock({ personalization: undefined }, 'equihash200');
      assertEq(jobLib.buildJob(bare, 'j', { algo: a200 }).personalization, 'ZcashPoW');
    },
  },
];

module.exports = { tests };
