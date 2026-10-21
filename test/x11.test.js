'use strict';
// X11: the hash, the classic-stratum job and the coinbase split, against real
// Kerrigan blocks and Dash's own published vectors. The real blocks were
// mined by a pool that wrote its own extranonce and name into the coinbase,
// so no share of ours can reproduce them byte for byte; instead every piece
// is pinned to real data on its own — the hash to the block hashes, the
// header's byte order to the real header, the merkle branch to a real block's
// root — and the whole share to an independently written miner.

const { assert, assertEq, assertThrows } = require('./t');
const util = require('../lib/util');
const algos = require('../lib/algos');
const coinbaseLib = require('../lib/coinbase');
const jobLib = require('../lib/job-x11');
const { x11 } = require('../lib/x11');
const fixtures = require('./fixtures');

const X11 = algos.get('x11');

// The coinbase's scriptSig and everything after it.
function dissect(buf) {
  let off = 4;
  off += util.readVarint(buf, off).size + 36;
  const sl = util.readVarint(buf, off);
  return { script: buf.subarray(off + sl.size, off + sl.size + sl.value), tail: buf.subarray(off + sl.size + sl.value) };
}

// A daemon-shaped coinbase whose scriptSig is `len` bytes long.
function coinbaseWithScript(len) {
  const real = fixtures.x11DaemonCoinbase('x11');
  let off = 4;
  off += util.readVarint(real, off).size + 36;
  const sl = util.readVarint(real, off);
  return Buffer.concat([real.subarray(0, off), util.varint(len), Buffer.alloc(len, 0x51),
    real.subarray(off + sl.size + sl.value)]).toString('hex');
}

const tests = [
  {
    name: 'X11 reproduces Dash\'s published vectors',
    fn() {
      assertEq(x11(Buffer.alloc(0)).toString('hex'), '51b572209083576ea221c27e62b4e22063257571ccb6cc3dc3cd17eb67584eba');
      assertEq(x11(Buffer.from('The quick brown fox jumps over the lazy dog')).toString('hex'),
        '534536a4e4f16b32447f02f77200449dc2f23b532e3d9878fe111c9de666bc5c');
      assertEq(x11(Buffer.from('DASH')).toString('hex'), 'fe809ebca8753d907f6ad32cdcf8e5c4e090d7bece5df35b2147e10b88c12d26');
      assertThrows(() => x11('not a buffer'));
    },
  },
  {
    name: 'every real block\'s hash is the X11 of its header, whatever the algo',
    fn() {
      // Kerrigan identifies every block by X11 — over the 140-byte header on
      // equihash, the 80-byte one on KawPoW and X11 — so all six real blocks
      // are X11 vectors.
      const fs = require('fs');
      const path = require('path');
      const hashOf = key => key === 'equihash192' ? fixtures.loadBlockJson().hash
        : JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors', fixtures.REAL[key].file), 'utf8')).hash;
      for (const key of ['equihash192', 'equihash200', 'kawpow', 'kawpow2', 'x11', 'x11b']) {
        const blk = fixtures.parseRealBlock(key);
        assertEq(util.reverseHex(x11(blk.header).toString('hex')), hashOf(key), `${key} block ${blk.height}`);
      }
    },
  },
  {
    name: 'a real X11 block\'s X11 is its proof of work: it meets its bits',
    fn() {
      for (const key of ['x11', 'x11b']) {
        const blk = fixtures.parseRealBlock(key);
        const vec = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'vectors', fixtures.REAL[key].file), 'utf8'));
        const h = x11(blk.header);
        assertEq(util.reverseHex(h.toString('hex')), vec.hash, `block ${blk.height}`);
        const bits = util.reverseHex(blk.fields.bitsBuf.toString('hex'));
        assertEq(bits, vec.bits);
        assert(util.bufToBigIntLE(h) <= util.compactToTarget(bits), `block ${blk.height} meets its own target`);
        assertEq((blk.fields.version >> 8) & 0xf, X11.versionNibble, 'X11 version nibble');
      }
    },
  },
  {
    name: 'the merkle branch folds to the full tree\'s root for 1..33 leaves, and to a real block\'s root',
    fn() {
      const crypto = require('crypto');
      for (let n = 1; n <= 33; n++) {
        const leaves = Array.from({ length: n }, () => crypto.randomBytes(32));
        const branch = jobLib.merkleBranch(leaves.slice(1));
        assertEq(jobLib.foldBranch(leaves[0], branch), util.merkleRoot(leaves), `${n} leaves`);
        assertEq(branch.length, n === 1 ? 0 : Math.ceil(Math.log2(n)), `${n} leaves: branch depth`);
      }
      // The 192/7 block carries a real transaction beside its coinbase.
      const blk = fixtures.parseRealBlock('equihash192');
      const branch = jobLib.merkleBranch(blk.txids.slice(1).map(t => util.reverseBuf(util.hexToBuf(t))));
      assertEq(jobLib.foldBranch(util.sha256d(blk.txs[0]), branch), blk.fields.merkleRoot, 'real block 116370');
    },
  },
  {
    name: 'splitForExtranonce: the daemon\'s outputs and payload survive; the tag gives way, the extranonce does not',
    fn() {
      const daemon = fixtures.x11DaemonCoinbase('x11');
      const before = dissect(daemon);
      assertEq(before.script, Buffer.from([0x6a]), 'the daemon\'s 1-byte scriptSig');

      const s = coinbaseLib.splitForExtranonce(daemon.toString('hex'), 8, '/stratnum/');
      assertEq([s.tagUsed, s.tagSkipped], ['/stratnum/', null]);
      const en = Buffer.from('aabbccdd00000001', 'hex');
      const after = dissect(Buffer.concat([s.coinb1, en, s.coinb2]));
      assertEq(after.tail, before.tail, 'sequence, outputs, locktime and CbTx payload byte-identical');
      assertEq(after.script, Buffer.concat([Buffer.from([0x6a, 10]), Buffer.from('/stratnum/'), Buffer.from([8]), en]),
        'script = daemon || push(tag) || push(extranonce)');

      const bare = coinbaseLib.splitForExtranonce(daemon.toString('hex'), 8);
      assertEq([bare.tagUsed, bare.tagSkipped], [null, null], 'no tag asked for, none skipped');
      assertEq(dissect(Buffer.concat([bare.coinb1, en, bare.coinb2])).script, Buffer.concat([Buffer.from([0x6a, 8]), en]));

      // 91 + 9 = 100: the extranonce still fits, a tag no longer does.
      const full = coinbaseLib.splitForExtranonce(coinbaseWithScript(91), 8, '/stratnum/');
      assertEq([full.tagUsed, full.tagSkipped], [null, 'no room in scriptSig (100-byte cap)']);
      assertEq(dissect(Buffer.concat([full.coinb1, en, full.coinb2])).script.length, 100);
      assertThrows(() => coinbaseLib.splitForExtranonce(coinbaseWithScript(92), 8), 'no room for the extranonce: refuse');

      const notCoinbase = Buffer.from(daemon);
      notCoinbase[5] = 1;   // outpoint no longer null
      assertThrows(() => coinbaseLib.splitForExtranonce(notCoinbase.toString('hex'), 8));
      assertEq(coinbaseLib.splitForExtranonce(daemon.toString('hex'), 8, '\x01\x02').tagSkipped, 'empty tag after sanitizing');
    },
  },
  {
    name: 'notify -> the header an independently written miner builds is the pool\'s, and real block 122283\'s field for field',
    fn() {
      const tpl = fixtures.gbtFromRealBlock({}, 'x11');
      const job = jobLib.buildJob(tpl, '1f', { algo: X11, coinbaseTag: '/stratnum/' });
      const np = jobLib.notifyParams(job, true);
      assertEq(np.length, 9);
      assertEq([np[0], np[5], np[6], np[8]], ['1f', '20000000', '1a55b93c', true], 'id, version, nbits, clean');
      assertEq(np[7], tpl.curtime.toString(16).padStart(8, '0'), 'ntime, big-endian');
      assertEq(np[4], [], 'a coinbase-only block has an empty branch');

      // The real block's own nTime and nonce, through the miner's hands.
      const blk = fixtures.parseRealBlock('x11');
      const be = n => n.toString(16).padStart(8, '0');
      const m = fixtures.x11MinerAssemble(np, 'aabbccdd', '00000001', be(blk.fields.nTime), be(blk.fields.nNonce));
      const root = jobLib.foldBranch(util.sha256d(m.coinbase), job.merkleBranch);
      const header = jobLib.serializeHeader(job, root, blk.fields.nTime, blk.fields.nNonce);
      assertEq(header, m.header, 'pool header == miner header');
      const real = Buffer.from(blk.header);
      root.copy(real, 36);
      assertEq(header, real, 'the real header with only the merkle root swapped for ours');
    },
  },
  {
    name: 'buildJob refuses another algo\'s template and checks its own merkle branch',
    fn() {
      const tpl = fixtures.gbtFromRealBlock({}, 'x11');
      assertThrows(() => jobLib.buildJob(Object.assign({}, tpl, { version: 0x20000200 }), '1', { algo: X11 }),
        'a KawPoW template on the X11 port');
      assertThrows(() => jobLib.buildJob(Object.assign({}, tpl, { coinbasetxn: undefined }), '1', { algo: X11 }));
      // Seven transactions: the branch must agree with the full tree.
      const txs = Array.from({ length: 7 }, (_, i) => {
        const data = Buffer.alloc(60, i + 1);
        const txid = util.reverseHex(util.sha256d(data).toString('hex'));
        return { data: data.toString('hex'), txid, hash: txid };
      });
      const job = jobLib.buildJob(Object.assign({}, tpl, { transactions: txs }), '2', { algo: X11 });
      assertEq(job.merkleBranch.length, 3);
      assertEq(job.txCount, 8);
    },
  },
];

module.exports = { tests };
