# X11 hash functions — vendored, unmodified

These files are Dash's pure-JavaScript X11 implementation, copied verbatim so
stratnum keeps zero npm dependencies:

- Package: `@dashevo/x11-hash-js` 1.0.3 (MIT — see `LICENSE`; `lib/keccak.js`
  also carries its own MIT notice, from js-sha3 by Chen, Yi-Cyuan)
- Source: https://github.com/dashpay/x11-hash-js
- Commit: `008f75bcd613983902ddf896c2717b8ab2cc04bf` (2018-11-15)
- Files: `index.js`, `lib/{aes,blake,bmw,cubehash,echo,groestl,helper,jh,keccak,luffa,op,shavite,simd,skein}.js`

Nothing here is edited. stratnum calls it only through `../x11.js`, and
`test/x11.test.js` checks it against real Kerrigan blocks of all four algos
(every Kerrigan block hash is the X11 of its header — 140 bytes on equihash,
80 on KawPoW and X11) and the package's own published vectors.

Audited when vendored: no `eval`/`Function`, no dynamic `require`, no file,
network, timer or console use, no deprecated `new Buffer()`.
