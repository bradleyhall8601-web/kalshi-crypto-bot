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
  const iso = h => new Date(Date.now() - h * 3600e3).toISOString(), S1 = (tk, side, n, cost, rev, h) => ({ ticker: tk, market_result: side, yes_count_fp: side === 'yes' ? String(n) : '0', no_count_fp: side === 'no' ? String(n) : '0', yes_total_cost_dollars: side === 'yes' ? String(cost) : '0', no_total_cost_dollars: side === 'no' ? String(cost) : '0', revenue: rev, fee_cost: '0.01', settled_time: iso(h) });
  W.settlements.push(S1('KXBTC15M-26NOV270100-00', 'yes', 1, 0.95, 100, 2), S1('KXBTC15M-26NOV270115-15', 'yes', 2, 1.84, 0, 3), S1('KXETH15M-26NOV270100-00', 'no', 1, 0.65, 100, 2), S1('KXMVECROSSCATEGORY-X', 'yes', 5, 4, 0, 2), S1('KXNEAR15M-26NOV271030-30', 'yes', 1, 11.45, 100, 2));
  await post({ message: { chat: { id: 42 }, text: '/realstats 3' } }); await wait(800);
  const rs = msgs().find(m => /REAL 15-MIN RESULTS/.test(m)) || '';
  ok(/All: 3 · 67% won/.test(rs) && /90–94¢: 1 · 0% won · −\$1\.85/.test(rs) && /60–69¢: 1 · 100% won · \+\$0\.34/.test(rs) && /2\+ contracts: 1/.test(rs) && !/MVE/.test(rs), '/realstats splits real 15-min results (combo bets and sold-before-close records left out)', rs);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
