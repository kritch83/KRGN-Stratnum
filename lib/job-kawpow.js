'use strict';
// KawPoW template -> job. Kerrigan's KawPoW block is an 80-byte header, then
// nHeight (u32), the miner's 64-bit nonce and its 32-byte mix hash. Miners only
// ever see the header's sha256d — the "header hash" — so the coinbase is the
// daemon's own, untouched apart from an optional tag: with a 64-bit nonce
// there is nothing for an extranonce to do in it.

const util = require('./util');
const coinbaseLib = require('./coinbase');
const kawpow = require('./kawpow');

function validateTemplate(tpl, algo) {
  const fail = reason => ({ ok: false, reason });
  if (!tpl || typeof tpl !== 'object') return fail('template is not an object');
  if (!Number.isInteger(tpl.version)) return fail('missing version');
  const nibble = (tpl.version >> 8) & 0xf;
  if (nibble !== algo.versionNibble) {
    return fail(`template version 0x${(tpl.version >>> 0).toString(16)} is not ${algo.key} ` +
      `(algo nibble ${nibble}, expected ${algo.versionNibble}) — check rpcalgoport/algo settings on the daemon`);
  }
  if (tpl.algo !== undefined && tpl.algo !== algo.key) return fail(`template is for ${JSON.stringify(tpl.algo)}, expected ${algo.key}`);
  if (!tpl.coinbasetxn || !util.isHex(tpl.coinbasetxn.data) || tpl.coinbasetxn.data.length < 2) {
    return fail('missing coinbasetxn.data — daemon did not build the coinbase (is pooladdress being sent?)');
  }
  if (!util.isHex(tpl.previousblockhash) || tpl.previousblockhash.length !== 64) return fail('bad previousblockhash');
  if (!util.isHex(tpl.target) || tpl.target.length !== 64) return fail('bad target');
  if (!util.isHex(tpl.bits) || tpl.bits.length !== 8) return fail('bad bits');
  if (!Number.isInteger(tpl.height) || tpl.height < 1) return fail('missing height');
  if (!Number.isInteger(tpl.curtime)) return fail('missing curtime');
  for (const k of ['headerhash', 'seedhash']) {
    if (tpl[k] !== undefined && (!util.isHex(tpl[k]) || tpl[k].length !== 64)) return fail(`bad ${k}`);
  }
  for (const tx of tpl.transactions || []) {
    if (!util.isHex(tx.data)) return fail('bad transaction data');
    const txid = tx.txid !== undefined ? tx.txid : tx.hash;
    if (!util.isHex(txid) || txid.length !== 64) return fail('bad transaction txid');
  }
  return { ok: true };
}

function header80(tpl, merkleRoot, nNonce) {
  return Buffer.concat([
    util.u32LE(tpl.version),
    util.reverseBuf(util.hexToBuf(tpl.previousblockhash)),
    merkleRoot,
    util.u32LE(tpl.curtime),
    util.reverseBuf(util.hexToBuf(tpl.bits)),
    util.u32LE(nNonce),
  ]);
}

// The header hash in the byte order miners see — the daemon's `headerhash`.
const headerHashOf = header => util.reverseBuf(util.sha256d(header));

function merkleOf(coinbaseData, txs) {
  return util.merkleRoot([util.sha256d(coinbaseData)].concat(
    txs.map(tx => util.reverseBuf(util.hexToBuf(tx.txid !== undefined ? tx.txid : tx.hash, 'txid')))));
}

// opts: { algo, coinbaseTag? }
function buildJob(tpl, jobId, opts) {
  const algo = opts.algo;
  const gate = validateTemplate(tpl, algo);
  if (!gate.ok) throw new Error('invalid template: ' + gate.reason);

  const daemonCoinbase = util.hexToBuf(tpl.coinbasetxn.data, 'coinbasetxn');
  let coinbaseData = daemonCoinbase;
  let coinbaseTagged = false;
  let tagSkipped = null;
  if (opts.coinbaseTag) {
    const r = coinbaseLib.appendTag(tpl.coinbasetxn.data, opts.coinbaseTag);
    if (r.applied) { coinbaseData = util.hexToBuf(r.hex); coinbaseTagged = true; } else tagSkipped = r.reason;
  }
  const txs = tpl.transactions || [];

  // The daemon's `headerhash` is sha256d(version | prevhash | merkle root |
  // time | bits | nNonce) over its own template block, whose merkle root it
  // never fills in — pool software computes that, and equihash's header_hex
  // shows the same zeroed field. So it pins down every header field except
  // the merkle root, plus which value went in nNonce: a convention, not a
  // rule — the node's own templates use 0, Ravencoin-style pools the height,
  // and the node accepts either. Reproduce it with the zeroed root, or with
  // the daemon's own (untagged) coinbase in case a node ever fills it in,
  // follow whichever nNonce matches, and refuse the template if none does.
  // The merkle root itself comes from the same code as every other algo's.
  let nNonce = 0;
  let headerHashChecked = false;
  if (tpl.headerhash !== undefined) {
    const want = tpl.headerhash.toLowerCase();
    let found;
    for (const root of [Buffer.alloc(32), merkleOf(daemonCoinbase, txs)]) {
      found = [0, tpl.height].find(n => headerHashOf(header80(tpl, root, n)).toString('hex') === want);
      if (found !== undefined) break;
    }
    if (found === undefined) {
      throw new Error('headerhash self-check failed: our serialized header does not reproduce the daemon\'s ' +
        `headerhash ${want} (tried a zeroed and the daemon's own merkle root, nNonce 0 and the height)`);
    }
    nNonce = found;
    headerHashChecked = true;
  }

  const epoch = kawpow.epochOf(tpl.height);
  const seedHash = kawpow.epochSeed(epoch);
  if (tpl.seedhash !== undefined && tpl.seedhash.toLowerCase() !== seedHash.toString('hex')) {
    throw new Error(`seedhash self-check failed: the daemon says ${tpl.seedhash} for height ${tpl.height}, ` +
      `epoch ${epoch} is ${seedHash.toString('hex')}`);
  }

  const merkleRoot = merkleOf(coinbaseData, txs);
  const header = header80(tpl, merkleRoot, nNonce);
  const headerHash = headerHashOf(header);
  return {
    id: jobId,
    algo,
    createdAt: Date.now(),
    height: tpl.height,
    curtime: tpl.curtime,
    epoch,
    prevHashDisplay: tpl.previousblockhash.toLowerCase(),
    blockTarget: BigInt('0x' + tpl.target),
    bitsHex: tpl.bits.toLowerCase(),
    minerRewardSat: Number.isInteger(tpl.coinbasevalue_miner) ? tpl.coinbasevalue_miner
      : Number.isInteger(tpl.coinbasevalue) ? tpl.coinbasevalue : 0,
    templateHash: tpl.template_hash,
    txCount: 1 + txs.length,
    header,
    headerHash,
    headerHashHex: headerHash.toString('hex'),
    seedHashHex: seedHash.toString('hex'),
    coinbaseData,
    txDatas: txs.map(tx => util.hexToBuf(tx.data, 'tx data')),
    cbTxidDisplay: util.reverseHex(util.sha256d(coinbaseData).toString('hex')),
    merkleRootDisplay: util.reverseHex(merkleRoot.toString('hex')),
    headerNonce: nNonce,
    headerHashChecked,
    coinbaseTagged,
    tagSkipped,
    seen: new Set(),
  };
}

// nonce: u64 BigInt; mixHash: 32 bytes in the order miners send it. The block
// stores the mix as a uint256, i.e. byte-reversed.
function serializeBlock(job, nonce, mixHash) {
  if (typeof nonce !== 'bigint' || !Buffer.isBuffer(mixHash) || mixHash.length !== 32) {
    throw new Error('serializeBlock: bad nonce or mix hash');
  }
  const tail = Buffer.alloc(44);
  tail.writeUInt32LE(job.height, 0);
  tail.writeBigUInt64LE(nonce, 4);
  util.reverseBuf(mixHash).copy(tail, 12);
  return Buffer.concat([job.header, tail, util.varint(job.txCount), job.coinbaseData, ...job.txDatas]);
}

module.exports = { validateTemplate, buildJob, serializeBlock, header80, headerHashOf };
