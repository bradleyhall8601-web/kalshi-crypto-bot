// A day key a second off (two clock reads straddling a second) is the same day: no false "yesterday" report, today's tally kept (live 11/27 4:27 AM CT).
process.env.BOT_TEST = '1';
const { W, start } = require('./harness');
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x = '') => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, x); } };
const msgs = () => W.tg.filter(x => x.method === 'sendMessage' && !String(x.body.text).startsWith('⚙️ BOT SETTINGS')).map(x => x.body.text);
const now = Date.now(), p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map(x => [x.type, x.value]));
const mid = Math.floor((now - (+p.hour * 3600 + +p.minute * 60 + +p.second) * 1000) / 1000);
W.pinned = '⚙️ BOT SETTINGS (do not unpin)\n' + JSON.stringify({ v: 20, SERIES: ['KXBTCD'], SETL: Date.now(),
  LED: { day: String(mid + 1), spent: 3, fast: 0, autoPnl: 0, streak: 0, fastOff: false, auto: [], n: 7, nAuto: 7, w: 6, l: 1, pnl: 2.17, fees: 0.2, best: 0.5, worst: -0.9 } });
(async () => {
  const { post } = start({}); await wait(800);
  await post({ message: { chat: { id: 42 }, text: '/status' } }); await wait(800);
  await post({ message: { chat: { id: 42 }, text: '/report' } }); await wait(800);
  ok(!msgs().some(m => /DAILY REPORT \(yesterday\)/.test(m)), 'a day key 1 s off is not a new day', msgs().join(' | ').slice(0, 300));
  const r = msgs().find(m => /TODAY SO FAR/.test(m)) || '';
  ok(/🧾 Trades: 7/.test(r) && /P&L \+\$2\.17/.test(r), "today's tally kept", r);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
