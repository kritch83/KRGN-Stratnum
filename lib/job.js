'use strict';
// Template -> job. A job is an immutable snapshot of one getblocktemplate
// response: everything needed to notify miners, validate shares, and
// serialize a full block lives here — block assembly never reads newer state.
// A job also carries the algo profile it was built for (lib/algos.js), so the
// share pipeline never has to ask which equihash it is looking at.

const util = require('./util');
const coinbaseLib = require('./coinbase');
const algos = require('./algos');

// Sanity-gate a getblocktemplate response for one algo (default equihash192)
// before building a job from it. Returns { ok: true } or { ok: false, reason }.
// A failing template must be refused (never served to miners) — mining on it
// would burn hashpower on blocks the daemon will reject.
function validateTemplate(tpl, algo) {
  const a = algo || algos.get();
  const fail = reason => ({ ok: false, reason });
  if (!tpl || typeof tpl !== 'object') return fail('template is not an object');
  if (!Number.isInteger(tpl.version)) return fail('missing version');
  const algoNibble = (tpl.version >> 8) & 0xf;
  if (algoNibble !== a.versionNibble) {
    return fail(`template version 0x${(tpl.version >>> 0).toString(16)} is not ${a.key} ` +
      `(algo nibble ${algoNibble}, expected ${a.versionNibble}) — check rpcalgoport/algo settings on the daemon`);
  }
  if (tpl.algo !== undefined && tpl.algo !== a.key) return fail(`template is for ${JSON.stringify(tpl.algo)}, expected ${a.key}`);
  if (tpl.equihash_n !== undefined && tpl.equihash_n !== a.eq.N) return fail(`equihash_n=${tpl.equihash_n}, expected ${a.eq.N}`);
  if (tpl.equihash_k !== undefined && tpl.equihash_k !== a.eq.K) return fail(`equihash_k=${tpl.equihash_k}, expected ${a.eq.K}`);
  const pers = tpl.personalization !== undefined ? tpl.personalization : a.personalization;
  if (typeof pers !== 'string' || pers.length !== 8) return fail(`bad personalization ${JSON.stringify(pers)}`);
  if (!tpl.coinbasetxn || !util.isHex(tpl.coinbasetxn.data) || tpl.coinbasetxn.data.length < 2) {
    return fail('missing coinbasetxn.data — daemon did not build the coinbase (is pooladdress being sent?)');
  }
  if (!util.isHex(tpl.previousblockhash) || tpl.previousblockhash.length !== 64) return fail('bad previousblockhash');
  if (!util.isHex(tpl.target) || tpl.target.length !== 64) return fail('bad target');
  if (!util.isHex(tpl.bits) || tpl.bits.length !== 8) return fail('bad bits');
  if (!Number.isInteger(tpl.height)) return fail('missing height');
  if (!Number.isInteger(tpl.curtime)) return fail('missing curtime');
  if (tpl.finalsaplingroothash !== undefined &&
      (!util.isHex(tpl.finalsaplingroothash) || tpl.finalsaplingroothash.length !== 64)) {
    return fail('bad finalsaplingroothash');
  }
  for (const tx of tpl.transactions || []) {
    if (!util.isHex(tx.data)) return fail('bad transaction data');
    const txid = tx.txid !== undefined ? tx.txid : tx.hash;
    if (!util.isHex(txid) || txid.length !== 64) return fail('bad transaction txid');
  }
  return { ok: true };
}

// opts: { algo?: profile (default equihash192), coinbaseTag?: string } — when
// coinbaseTag is set, the tag is embedded in the coinbase scriptSig (fail-safe:
// skipped, with tagSkipped reason, on any anomaly) and the merkle root is
// recomputed from the modified coinbase.
function buildJob(tpl, jobId, opts) {
  const algo = (opts && opts.algo) || algos.get();
  const gate = validateTemplate(tpl, algo);
  if (!gate.ok) throw new Error('invalid template: ' + gate.reason);

  let coinbaseHex = tpl.coinbasetxn.data;
  let coinbaseTagged = false;
  let tagSkipped = null;
  if (opts && opts.coinbaseTag) {
    const tagRes = coinbaseLib.appendTag(coinbaseHex, opts.coinbaseTag);
    if (tagRes.applied) {
      coinbaseHex = tagRes.hex;
      coinbaseTagged = true;
    } else {
      tagSkipped = tagRes.reason;
    }
  }

  const coinbaseData = util.hexToBuf(coinbaseHex, 'coinbasetxn');
  const cbHash = util.sha256d(coinbaseData);
  const txs = tpl.transactions || [];
  const txDatas = txs.map(tx => util.hexToBuf(tx.data, 'tx data'));
  const leaves = [cbHash].concat(
    txs.map(tx => util.reverseBuf(util.hexToBuf(tx.txid !== undefined ? tx.txid : tx.hash, 'txid')))
  );
  const merkleRootBuf = util.merkleRoot(leaves);

  const versionBuf = util.u32LE(tpl.version);
  const prevHashBuf = util.reverseBuf(util.hexToBuf(tpl.previousblockhash, 'previousblockhash'));
  const saplingBuf = tpl.finalsaplingroothash
    ? util.reverseBuf(util.hexToBuf(tpl.finalsaplingroothash, 'finalsaplingroothash'))
    : Buffer.alloc(32);
  const curtimeBuf = util.u32LE(tpl.curtime);
  const bitsBuf = util.reverseBuf(util.hexToBuf(tpl.bits, 'bits'));

  // Header bytes [0,100): version | prevhash | merkleroot | reserved.
  const prefix100 = Buffer.concat([versionBuf, prevHashBuf, merkleRootBuf, saplingBuf]);
  const header108 = Buffer.concat([prefix100, curtimeBuf, bitsBuf]);

  // Runtime self-check: the daemon serialized the same 108-byte prefix in
  // header_hex. The live daemon leaves the merkle-root field zeroed there
  // (pool software is expected to compute it), so that segment is only
  // compared when the daemon filled it in. Any other disagreement means our
  // serialization is wrong for this template — refuse to serve it.
  // hex offsets: 0..8 version | 8..72 prevhash | 72..136 merkle |
  //              136..200 reserved | 200..208 time | 208..216 bits
  let headerHexChecked = false;
  if (typeof tpl.header_hex === 'string' && tpl.header_hex.length >= 216) {
    const daemonHdr = tpl.header_hex.slice(0, 216).toLowerCase();
    const ourHdr = header108.toString('hex');
    // A tagged coinbase intentionally diverges from the daemon's merkle root.
    const skipMerkle = coinbaseTagged || daemonHdr.slice(72, 136) === '0'.repeat(64);
    const ranges = skipMerkle ? [[0, 72], [136, 216]] : [[0, 216]];
    for (const [a, b] of ranges) {
      if (daemonHdr.slice(a, b) !== ourHdr.slice(a, b)) {
        throw new Error(
          'header_hex self-check failed: our serialized header disagrees with the daemon ' +
          `in hex range ${a}..${b}. ours=${ourHdr} daemon=${daemonHdr}`
        );
      }
    }
    headerHexChecked = true;
  }

  return {
    id: jobId,
    algo,
    createdAt: Date.now(),
    height: tpl.height,
    curtime: tpl.curtime,
    prevHashDisplay: tpl.previousblockhash.toLowerCase(),
    blockTarget: BigInt('0x' + tpl.target),
    personalization: tpl.personalization !== undefined ? tpl.personalization : algo.personalization,
    minerRewardSat: Number.isInteger(tpl.coinbasevalue_miner) ? tpl.coinbasevalue_miner
      : Number.isInteger(tpl.coinbasevalue) ? tpl.coinbasevalue : 0,
    templateHash: tpl.template_hash,
    txCount: 1 + txDatas.length,
    prefix100,
    curtimeBuf,
    bitsBuf,
    coinbaseData,
    txDatas,
    cbTxidDisplay: util.reverseHex(cbHash.toString('hex')),
    merkleRootDisplay: util.reverseHex(merkleRootBuf.toString('hex')),
    headerHexChecked,
    coinbaseTagged,
    tagSkipped,
    seen: new Set(),
  };
}

// mining.notify params — elements 1..6 are the literal header bytes [0,108)
// hex-encoded; 8 (the algo, "192_7" or "200_9") and 9 (the personalization)
// are the kerrigan-network stratum extensions.
function notifyParams(job, cleanJobs) {
  return [
    job.id,
    job.prefix100.subarray(0, 4).toString('hex'),
    job.prefix100.subarray(4, 36).toString('hex'),
    job.prefix100.subarray(36, 68).toString('hex'),
    job.prefix100.subarray(68, 100).toString('hex'),
    job.curtimeBuf.toString('hex'),
    job.bitsBuf.toString('hex'),
    !!cleanJobs,
    job.algo.notifyAlgo,
    job.personalization,
  ];
}

// nTimeBuf: 4 bytes (LE, as submitted); nonceBuf: 32 bytes (en1 || en2).
function serializeHeader(job, nTimeBuf, nonceBuf) {
  if (nTimeBuf.length !== 4 || nonceBuf.length !== 32) throw new Error('serializeHeader: bad input sizes');
  return Buffer.concat([job.prefix100, nTimeBuf, job.bitsBuf, nonceBuf]);
}

// solnWithPrefix: the CompactSize length, then the solution — fd9001 + 400
// bytes on 192/7, fd4005 + 1344 on 200/9.
function serializeBlock(job, header140, solnWithPrefix) {
  if (header140.length !== 140) throw new Error('serializeBlock: bad header size');
  const eq = job.algo.eq;
  const prefix = Buffer.from(eq.SOLUTION_PREFIX, 'hex');
  if (solnWithPrefix.length !== prefix.length + eq.SOLUTION_BYTES ||
      !solnWithPrefix.subarray(0, prefix.length).equals(prefix)) {
    throw new Error('serializeBlock: bad solution');
  }
  return Buffer.concat([
    header140,
    solnWithPrefix,
    util.varint(job.txCount),
    job.coinbaseData,
    ...job.txDatas,
  ]);
}

module.exports = { validateTemplate, buildJob, notifyParams, serializeHeader, serializeBlock };
