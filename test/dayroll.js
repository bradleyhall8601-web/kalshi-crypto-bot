// Day rollover: yesterday's numbers are reported, today starts fresh.
process.env.BOT_TEST = '1';
const { W, start } = require('./harness');
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x = '') => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, x); } };
const msgs = () => W.tg.filter(x => x.method === 'sendMessage' && !String(x.body.text).startsWith('⚙️ BOT SETTINGS')).map(x => x.body.text);
W.pinned = '⚙️ BOT SETTINGS (do not unpin)\n' + JSON.stringify({ v: 5, SERIES: ['KXBTCD'], SETL: Date.now(), SC: { n: 4, wins: 3, sumP: 2, brier: 0.5, pnl: 0.4, open: [], ev: {} },
  LED: { day: '1000', spent: 9.5, fast: 4, autoPnl: 1.2, streak: 0, fastOff: true, auto: [], n: 5, nAuto: 4, w: 3, l: 2, pnl: 1.85, fees: 0.41, best: 3.17, worst: -1.83 } });
(async () => {
  const { post } = start({}); await wait(800);
  await post({ message: { chat: { id: 42 }, text: '/status' } }); await wait(800);
  const rep = msgs().find(m => /DAILY REPORT \(yesterday\)/.test(m)) || '';
  ok(/🧾 Trades: 5 \(🤖 auto 4 · 👆 tap 1\)/.test(rep) && /🏆 Wins 3 · 💔 Losses 2 · 60% hit/.test(rep) && /📈 P&L \+\$1\.85 · 💸 fees \$0\.41/.test(rep) && /🥇 best \+\$3\.17 · 🥶 worst −\$1\.83/.test(rep), 'yesterday reported with emojis', rep);
  const st = msgs().slice(-1)[0];
  ok(/Today: \$0\.00/.test(st) && /Auto 15-min: ON/.test(st), 'new day: spend reset and auto 15-min re-enabled', st);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
