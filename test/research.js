// Research engine sanity: no false discoveries on a random walk; finds planted momentum and reversion.
const R = require('../research');
let pass = 0, fail = 0; const ok = (c, n, x = '') => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, x); } };
function series(n, vol, mode, seed = 7) { // mode: 'rw' | 'mom' (persistent trend) | 'rev' (temporary swings that snap back)
  let s = seed; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const out = []; let base = Math.log(60000), drift = 0, ou = 0, hist = [], t = 1795000000 - (1795000000 % 3600);
  for (let i = 0; i < n; i++) {
    if (mode === 'mom') drift = 0.97 * drift + 0.00012 * g();
    if (mode === 'rev') drift = -0.06 * (hist.slice(-5).reduce((a, x) => a + x, 0)); // each 5-min move partly reverses
    const step = drift + vol * g(); hist.push(step); base += step;
    out.push({ t: t + i * 60, c: Math.exp(base + ou) });
  }
  return out;
}
const n = 4320 * 2; // 6 days of minutes
const rw = R.fit(R.buildSamples(series(n, 0.0005, 'rw'), 15, [3, 5, 7, 9, 11, 13], 5));
console.log('   random walk:', JSON.stringify(rw));
ok(rw.ok && !rw.adopt, 'random walk: nothing adopted (no false discovery)');
ok(Math.abs(rw.mult - 1) <= 0.1, 'random walk: volatility scale ≈ 1', rw.mult);
const mo = R.fit(R.buildSamples(series(n, 0.0005, 'mom', 11), 15, [3, 5, 7, 9, 11, 13], 5));
console.log('   momentum:', JSON.stringify(mo));
ok(mo.ok && mo.adopt && mo.k > 0, 'planted momentum detected and adopted (k > 0)', mo.k);
const mr = R.fit(R.buildSamples(series(n, 0.0005, 'rev', 13), 15, [3, 5, 7, 9, 11, 13], 5));
console.log('   reversion:', JSON.stringify(mr));
ok(mr.ok && (mr.adopt ? mr.k < 0 && mr.gain > 0.005 : mr.gain <= 0.005), 'never adopts a change that fails on unseen data (direction right when found)', JSON.stringify({ k: mr.k, gain: mr.gain }));
console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
