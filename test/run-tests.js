'use strict';
// Zero-dependency test runner. Executes every test/*.test.js sequentially.
// Each test file exports { tests: [{ name, fn }] }; fn may be async and may
// return the string 'skip'. Optional argv[2] substring-filters test names.

const fs = require('fs');
const path = require('path');

async function main() {
  const filter = process.argv[2];
  // Skip dot-files: macOS leaves AppleDouble siblings (._foo.test.js) on
  // network shares, and they are binary metadata, not JavaScript.
  const files = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.test.js') && !f.startsWith('.'))
    .sort();
  let pass = 0, fail = 0, skip = 0;
  const t0 = Date.now();

  for (const file of files) {
    let mod;
    try {
      mod = require(path.join(__dirname, file));
    } catch (err) {
      fail++;
      console.log(`FAIL ${file} (load)\n     ${err.stack ? err.stack.split('\n').slice(0, 5).join('\n     ') : err}`);
      continue;
    }
    for (const t of mod.tests || []) {
      const full = `${file.replace(/\.test\.js$/, '')} :: ${t.name}`;
      if (filter && !full.includes(filter)) continue;
      try {
        const res = await t.fn();
        if (res === 'skip') { skip++; console.log(`SKIP ${full}`); }
        else { pass++; console.log(`ok   ${full}`); }
      } catch (err) {
        fail++;
        console.log(`FAIL ${full}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n     ') : err}`);
      }
    }
  }

  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
