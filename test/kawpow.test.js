'use strict';
// KawPoW, against the strongest oracles there are: the ProgPoW test vectors
// Kerrigan itself ships (src/crypto/ethash/progpow_test_vectors.hpp) and two
// real Kerrigan KawPoW blocks. Epoch caches are kept in a shared temp dir, so
// only the first run pays for building them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { assert, assertEq, assertThrows } = require('./t');
const util = require('../lib/util');
const algos = require('../lib/algos');
const keccak = require('../lib/keccak');
const kawpow = require('../lib/kawpow');
const store = require('../lib/kawpow-cache');
const jobLib = require('../lib/job-kawpow');
const fixtures = require('./fixtures');

const CACHE_DIR = path.join(os.tmpdir(), 'stratnum-kawpow-cache');
// Only the last epoch used is kept: the whole suite runs in one process, and
// six ~18 MB contexts held to the end would sit under every later test (the
// zmq suite asserts on the process's memory). prune: false — this suite walks
// six epochs, and keeping their files is what makes every run after the first
// fast; reloading one from disk takes ~0.15 s.
const contexts = new Map();
function ctxFor(epoch) {
  if (!contexts.has(epoch)) {
    contexts.clear();
    contexts.set(epoch, store.loadOrBuild(epoch, CACHE_DIR, { prune: false }).ctx);
  }
  return contexts.get(epoch);
}

// A Uint32Array's bytes, to compare two caches without assertEq's JSON path
// (which would turn 4 million words into strings).
const bytesOf = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

// [height, header hash, nonce, mix hash, final hash] — verbatim from Kerrigan's
// progpow_test_vectors.hpp ("standard Ravencoin KawPoW").
const VECTORS = [
  [0, '0000000000000000000000000000000000000000000000000000000000000000', '0000000000000000',
    '6e97b47b134fda0c7888802988e1a373affeb28bcd813b6e9a0fc669c935d03a', 'e601a7257a70dc48fccc97a7330d704d776047623b92883d77111fb36870f3d1'],
  [49, '63155f732f2bf556967f906155b510c917e48e99685ead76ea83f4eca03ab12b', '0000000007073c07',
    'd36f7e815ee09e74eceb9c96993a3d681edf2bf0921fc7bb710364042db99777', 'e7ced124598fd2500a55ad9f9f48e3569327fe50493c77a4ac9799b96efb9463'],
  [50, '9e7248f20914913a73d80a70174c331b1d34f260535ac3631d770e656b5dd922', '00000000076e482e',
    'd6dc634ae837e2785b347648ea515e25e5d8821ae0b95e1c2a9c2d497e0dcfbd', 'ab0ad7ef8d8ee317dd12d10310aceed7321d34fb263791c2de5776a6658d177e'],
  [99, 'de37e1824c86d35d154cf65a88de6d9286aec4f7f10c3fc9f0fa1bcc2687188d', '000000003917afab',
    'fa706860e5e0e830d5d1d7157e5bea7f5f8a350c7c8612ac1d1fcf2974d64244', 'aa85340690f2e907054324a5021937910e15edfd1ef1577231843e7d32ec3a61'],
  [29950, 'ac7b55e801511b77e11d52e9599206101550144525b5679f2dab19386f23dcce', '005d409dbc23a62a',
    '5359807b77a74878269c3a3044df8618a576ce8dc52e1c48d927d4a60e7c6b79', '022019e5408683f7f8326b4e46b42864a3a069f17b6151e434fcaedecaadd918'],
  [29999, 'e43d7e0bdc8a4a3f6e291a5ed790b9fa1a0948a2b9e33c844888690847de19f5', '005db5fa4c2a3d03',
    'd15de3f9bfedd9b6d0f498273eb3b437115bdc8326c96c6457ac06deb5c9f389', '4e93630b81198752f876b24380999189b7b9366c08222ac05e4237b87114f305'],
  [30000, 'd34519f72c97cae8892c277776259db3320820cb5279a299d0ef1e155e5c6454', '005db8607994ff30',
    'de0348b69bf91dfe2c3d3dba6f0132e9048a5284e57b8d9d20adc5f3dc0d3236', 'c7953d848cda6e304f77b4c6d735645c8e8508a5e74c9e9814ef37b19087cd6c'],
  [30049, '8b6ce5da0b06d18db7bd8492d9e5717f8b53e7e098d9fef7886d58a6e913ef64', '005e2e215a8ca2e7',
    '975c6a9decc89cba7ace69338d4de8510d9619aef42b1d35d0bef7e0ce0614a9', 'c262d8055e288d04b951a844bfca8ba529f5b4d652b408e3942727d7dd90957a'],
  [30050, 'c2c46173481b9ced61123d2e293b42ede5a1b323210eb2a684df0874ffe09047', '005e30899481055e',
    '362f2fabdb9699d3634b6499703f939f378ee4eac803396c2b0ed0fe1d154972', '4cd7e6e79e0b63d42b2b06716a919ccc7834077ec727a9ea94edcdaff2fefab8'],
  [30099, 'ea42197eb2ba79c63cb5e655b8b1f612c5f08aae1a49ff236795a3516d87bc71', '005ea6aef136f88b',
    'b1196457261bd05ccb387a8ff3fd02687bf496bd7943d89419465289669e27aa', '39d1ebfa783b61a6fa8e9747d0f9f134efae5cfba284a2c80e8deabae6b98676'],
  [59950, '49e15ba4bf501ce8fe8876101c808e24c69a859be15de554bf85dbc095491bd6', '02ebe0503bd7b1da',
    'df3dbb1669fd35dbb0ae96bbea2d498f0c6992cbddd092aeace42dd933505f95', 'b8984cf4021c4433f753654848d721f33a0792b4417241f0cf7c7c2db011a54a'],
  [59999, 'f5c50ba5c0d6210ddb16250ec3efda178de857b2b1703d8d5403bd0f848e19cf', '02edb6275bd221e3',
    '5017df70e97ca35638cf439cdbe54f30383d335e18eb4a74d6e166736f1038fa', '4cf1fa62f25b577ac822a6a28d55f8b7e3ae7fe983abd868ae00927e68c41016'],
  [170915, '5b3e8dfa1aafd3924a51f33e2d672d8dae32fa528d8b1d378d6e4db0ec5d665d', '0000000044975727',
    'efb29147484c434f1cc59629da90fd0343e3b047407ecd36e9ad973bd51bbac5', 'e7e6bb3b2f9acd3864bc86f72f87237eaf475633ef650c726ac80eb0adf116b6'],
];

const algo = algos.get('kawpow');
const realBlocks = ['kawpow', 'kawpow2'];

const tests = [
  {
    name: 'keccak: original Keccak (not SHA-3) known answers, and the 64-byte fast path agrees',
    fn() {
      assertEq(keccak.keccak256(Buffer.alloc(0)).toString('hex'), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
      assertEq(keccak.keccak256(Buffer.from('The quick brown fox jumps over the lazy dog')).toString('hex'),
        '4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15');
      assertEq(keccak.keccak512(Buffer.alloc(0)).toString('hex'),
        '0eab42de4c3ceb9235fc91acffe746b29c29a8c366b7c60e4e67c466f36a4304c00fa9caf9d87976ba469bcbe06713b435f091ef2769fb160cdab33d3670680e');
      const bytes = Buffer.from(Array.from({ length: 64 }, (_, i) => i * 7 + 3));
      const w = new Uint32Array(16);
      for (let i = 0; i < 16; i++) w[i] = bytes.readUInt32LE(4 * i);
      const out = new Uint32Array(16);
      keccak.keccak512Words(w, 0, out, 0);
      assertEq(Buffer.from(out.buffer), keccak.keccak512(bytes), 'keccak512Words == keccak512 on 64 bytes');
    },
  },
  {
    name: 'ethash epoch parameters match the reference values',
    fn() {
      assertEq(kawpow.lightCacheItems(0), 262139, 'epoch 0 light cache: 16 MB, largest prime item count');
      assertEq(kawpow.fullDatasetItems(0), 8388593, 'epoch 0 dataset: 1073739904 bytes');
      assertEq(kawpow.epochSeed(0), Buffer.alloc(32));
      assertEq(kawpow.epochSeed(1).toString('hex'), '290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563');
      assertEq([kawpow.epochOf(7499), kawpow.epochOf(7500), kawpow.epochOf(122281)], [0, 1, 16]);
    },
  },
  {
    name: 'the 32-bit helpers agree with exact arithmetic',
    fn() {
      for (let i = 0; i < 20000; i++) {
        const a = (Math.random() * 2 ** 32) >>> 0;
        const b = (Math.random() * 2 ** 32) >>> 0;
        assertEq(kawpow._mulHi32(a, b), Number((BigInt(a) * BigInt(b)) >> 32n));
        assertEq(kawpow._popcount32(a), a.toString(2).replace(/0/g, '').length);
      }
      assertEq(kawpow._mulHi32(0xffffffff, 0xffffffff), 0xfffffffe);
    },
  },
  {
    name: 'all 13 of Kerrigan\'s KawPoW test vectors: mix and final hash, epochs 0-22',
    fn() {
      for (const [height, header, nonce, mix, final] of VECTORS) {
        const r = kawpow.hash(ctxFor(kawpow.epochOf(height)), height, Buffer.from(header, 'hex'), BigInt('0x' + nonce));
        assertEq(r.mixHash.toString('hex'), mix, `mix at height ${height}`);
        assertEq(r.finalHash.toString('hex'), final, `final at height ${height}`);
        assertEq(kawpow.finalHash(height, Buffer.from(header, 'hex'), Buffer.from(mix, 'hex'), BigInt('0x' + nonce)).toString('hex'),
          final, `cheap final at height ${height}`);
      }
    },
  },
  {
    name: 'real Kerrigan KawPoW blocks: the recomputed mix is the one on chain, and it meets the bits',
    fn() {
      for (const key of realBlocks) {
        const blk = fixtures.parseRealBlock(key);
        assertEq(blk.nHeight, blk.height, 'nHeight field is the block height');
        const r = kawpow.hash(ctxFor(kawpow.epochOf(blk.height)), blk.height, blk.headerHash, blk.nonce);
        assertEq(r.mixHash, blk.mixHash, `${blk.height}: mix`);
        const target = util.compactToTarget(util.reverseHex(blk.fields.bitsBuf.toString('hex')));
        assert(BigInt('0x' + r.finalHash.toString('hex')) <= target, `${blk.height}: final hash meets its bits`);
      }
    },
  },
  {
    name: 'performance: a full share check takes well under a tenth of a second',
    fn() {
      const blk = fixtures.parseRealBlock('kawpow');
      const ctx = ctxFor(16);
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 5; i++) kawpow.hash(ctx, blk.height, blk.headerHash, blk.nonce + BigInt(i));
      const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 5;
      console.log(`     (${ms.toFixed(1)} ms/verify)`);
      assert(ms < 100, `too slow: ${ms} ms`);
    },
  },
  {
    name: 'job: the real template reserializes the real block byte for byte',
    fn() {
      for (const key of realBlocks) {
        const blk = fixtures.parseRealBlock(key);
        const job = jobLib.buildJob(fixtures.gbtFromRealBlock({}, key), 'j1', { algo });
        assert(job.headerHashChecked, 'headerhash self-check ran');
        assertEq(job.headerNonce, blk.height, 'these blocks carry the height in nNonce, and the check found it');
        assertEq(job.header, blk.header);
        assertEq(job.headerHashHex, blk.headerHash.toString('hex'));
        assertEq(jobLib.serializeBlock(job, blk.nonce, blk.mixHash), blk.raw, `${blk.height} byte-identical`);
        assertEq(job.cbTxidDisplay, blk.txids[0]);
        assertEq(job.seedHashHex, kawpow.epochSeed(16).toString('hex'));
      }
    },
  },
  {
    name: 'job: nNonce follows the daemon\'s headerhash — 0 for the node\'s own templates — and a mismatch is refused',
    fn() {
      const base = fixtures.gbtFromRealBlock({}, 'kawpow');
      const blk = fixtures.parseRealBlock('kawpow');
      // Exactly what the live node serves (src/rpc/mining.cpp): headerhash
      // over its template header, merkle root never filled in, nNonce = 0.
      // The job must still carry the REAL merkle root.
      const tpl0 = Object.assign({}, base, { headerhash: fixtures.daemonHeaderHash(blk.header, 0).toString('hex') });
      const job0 = jobLib.buildJob(tpl0, 'j', { algo });
      assert(job0.headerHashChecked);
      assertEq(job0.headerNonce, 0);
      assertEq(job0.header.readUInt32LE(76), 0);
      assertEq(job0.header.subarray(36, 68), blk.fields.merkleRoot, 'the real merkle root, not the zeroed one');
      assertEq(job0.header.subarray(0, 76), blk.header.subarray(0, 76), 'every other field as on chain');
      // A node that did fill in the merkle root is followed too.
      const filled = Buffer.from(blk.header);
      filled.writeUInt32LE(0, 76);
      const tplFilled = Object.assign({}, base, { headerhash: jobLib.headerHashOf(filled).toString('hex') });
      assertEq(jobLib.buildJob(tplFilled, 'j', { algo }).header, filled);
      const err = assertThrows(() => jobLib.buildJob(Object.assign({}, base, { headerhash: 'ab'.repeat(32) }), 'j', { algo }));
      assert(/headerhash self-check failed/.test(err.message), err.message);
      const err2 = assertThrows(() => jobLib.buildJob(Object.assign({}, base, { seedhash: 'cd'.repeat(32) }), 'j', { algo }));
      assert(/seedhash self-check failed/.test(err2.message), err2.message);
      // A coinbase tag changes the merkle root but not the convention check,
      // which is done against the daemon's own coinbase.
      const tagged = jobLib.buildJob(base, 'j', { algo, coinbaseTag: '/stratnum/' });
      assert(tagged.coinbaseTagged && tagged.headerHashChecked);
      assert(!tagged.header.equals(blk.header), 'tagged header differs (new merkle root)');
      assert(!jobLib.validateTemplate(fixtures.gbtFromRealBlock(), algo).ok, 'an equihash template is refused');
    },
  },
  {
    name: 'disk cache: a good file round-trips, a damaged one is never trusted, and pruning keeps neighbours',
    fn() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratnum-kpbad-'));
      const ctx = ctxFor(0);
      store.save(dir, 0, ctx.cache);
      assert(bytesOf(store.load(dir, 0)).equals(bytesOf(ctx.cache)), 'the saved cache loads back word for word');
      const good = fs.readFileSync(store.fileFor(dir, 0));
      const bad = Buffer.from(good);
      bad[100000] ^= 1;
      fs.writeFileSync(store.fileFor(dir, 0), bad);
      assertEq(store.load(dir, 0), null, 'a flipped bit fails the checksum');
      fs.writeFileSync(store.fileFor(dir, 0), good.subarray(0, 1000));
      assertEq(store.load(dir, 0), null, 'a truncated file is rejected');
      assertEq(store.load(dir, 3), null, 'a missing file is just absent');
      // Pruning: saving epoch 3 keeps 2..4 and drops the rest. Fake files are
      // enough — pruning goes by name.
      for (const e of [0, 2, 4, 9]) fs.writeFileSync(store.fileFor(dir, e), 'x');
      store.save(dir, 3, ctxFor(3).cache);
      const left = fs.readdirSync(dir).filter(f => f.endsWith('.bin')).sort();
      assertEq(left, ['kawpow-epoch-2.bin', 'kawpow-epoch-3.bin', 'kawpow-epoch-4.bin']);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  },
];

module.exports = { tests };
