'use strict';
// Gate tests: every byte-order assumption is validated against the real
// mainnet equihash192 block before anything is built on top of it.

const { assert, assertEq } = require('./t');
const util = require('../lib/util');
const fixtures = require('./fixtures');

const tests = [
  {
    name: 'raw block parses and re-concatenates byte-identically',
    fn() {
      const blk = fixtures.parseRealBlock();
      const json = fixtures.loadBlockJson();
      assertEq(blk.header.length, 140);
      assertEq(blk.solution.length, 400);
      assertEq(blk.txCount, json.tx.length, 'tx count matches explorer');
      const rebuilt = Buffer.concat([blk.header, blk.solutionWithPrefix, util.varint(blk.txCount), ...blk.txs]);
      assertEq(rebuilt, blk.raw, 'concat identical');
    },
  },
  {
    name: 'transaction txids match explorer JSON (Dash tx walker is correct)',
    fn() {
      const blk = fixtures.parseRealBlock();
      const json = fixtures.loadBlockJson();
      const txids = blk.txs.map(tx => util.reverseHex(util.sha256d(tx).toString('hex')));
      assertEq(txids, json.tx, 'txids in order');
    },
  },
  {
    name: 'merkle root recomputes from coinbase hash + reversed txids',
    fn() {
      const blk = fixtures.parseRealBlock();
      const json = fixtures.loadBlockJson();
      const leaves = [util.sha256d(blk.txs[0])].concat(
        json.tx.slice(1).map(t => util.reverseBuf(util.hexToBuf(t)))
      );
      const root = util.merkleRoot(leaves);
      assertEq(root, Buffer.from(blk.fields.merkleRoot), 'internal-order root matches header');
      assertEq(util.reverseHex(root.toString('hex')), json.merkleroot, 'display form matches explorer');
    },
  },
  {
    name: 'PoW hash meets target read little-endian, fails read big-endian',
    fn() {
      const blk = fixtures.parseRealBlock();
      const json = fixtures.loadBlockJson();
      const h = util.sha256d(Buffer.concat([blk.header, blk.solutionWithPrefix]));
      const target = util.compactToTarget(json.bits);
      assert(util.bufToBigIntLE(h) <= target, 'LE interpretation passes');
      assert(util.bufToBigIntBE(h) > target, 'BE interpretation fails (endianness trap)');
    },
  },
  {
    name: 'header fields match explorer JSON',
    fn() {
      const blk = fixtures.parseRealBlock();
      const json = fixtures.loadBlockJson();
      const f = blk.fields;
      assertEq(f.version, json.version, 'version');
      assertEq((f.version >> 8) & 0xf, 6, 'algo nibble = equihash192');
      assertEq(f.nTime, json.time, 'time');
      assertEq(util.reverseHex(f.prevHash.toString('hex')), json.previousblockhash, 'prevhash display');
      assertEq(util.reverseHex(f.bitsBuf.toString('hex')), json.bits, 'bits display');
      assertEq(f.hashReserved, Buffer.alloc(32), 'sapling root all zeros on this block');
    },
  },
  {
    name: '200/9 block: fd4005 + 1344-byte solution, re-concatenates byte-identically',
    fn() {
      const blk = fixtures.parseRealBlock('equihash200');
      assertEq(blk.header.length, 140);
      assertEq(blk.solutionWithPrefix.subarray(0, 3).toString('hex'), 'fd4005');
      assertEq(blk.solution.length, 1344);
      const rebuilt = Buffer.concat([blk.header, blk.solutionWithPrefix, util.varint(blk.txCount), ...blk.txs]);
      assertEq(rebuilt, blk.raw, 'concat identical');
    },
  },
  {
    name: '200/9 block: txids derived from the bytes reproduce the header merkle root',
    fn() {
      // No explorer JSON for this one, so the header is the witness: if the tx
      // walker or the txid rule were wrong, this root could not come out right.
      const blk = fixtures.parseRealBlock('equihash200');
      const root = util.merkleRoot(blk.txids.map(t => util.reverseBuf(util.hexToBuf(t))));
      assertEq(root, Buffer.from(blk.fields.merkleRoot));
    },
  },
  {
    name: '200/9 block: BIP34 height, algo nibble 4, PoW meets its bits read little-endian',
    fn() {
      const blk = fixtures.parseRealBlock('equihash200');
      const cb = blk.txs[0];
      let o = 4;
      const vin = util.readVarint(cb, o);
      o += vin.size + 36;                      // the single coinbase input's outpoint
      const sl = util.readVarint(cb, o);
      o += sl.size;
      const push = cb[o];
      assertEq(cb.subarray(o + 1, o + 1 + push).readUIntLE(0, push), 122284, 'BIP34 height in the coinbase');
      assertEq(blk.height, 122284);
      const f = blk.fields;
      assertEq((f.version >> 8) & 0xf, 4, 'algo nibble = equihash200');
      const target = util.compactToTarget(util.reverseHex(f.bitsBuf.toString('hex')));
      const h = util.sha256d(Buffer.concat([blk.header, blk.solutionWithPrefix]));
      assert(util.bufToBigIntLE(h) <= target, 'LE interpretation passes');
      assert(util.bufToBigIntBE(h) > target, 'BE interpretation fails');
    },
  },
];

module.exports = { tests };
