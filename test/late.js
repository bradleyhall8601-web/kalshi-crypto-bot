// 10th/12th-minute "buy the winner" tests (paper only, own records). Run: node test/late.js
process.env.BOT_TEST = '1';
const { W, start } = require('./harness');
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x = '') => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, x); } };
const msgs = () => W.tg.filter(x => x.method === 'sendMessage' && !String(x.body.text).startsWith('⚙️ BOT SETTINGS')).map(x => x.body.text);
const last = () => msgs().slice(-1)[0] || '';
const zlib = require('zlib');
const pinned = () => { const t = W.pinned, zi = t.indexOf('Z:'); return zi >= 0 ? JSON.parse(zlib.inflateRawSync(Buffer.from(t.slice(zi + 2).trim(), 'base64')).toString()) : JSON.parse(t.slice(t.indexOf('{'))); };
let seq = 0;
function market(series, mins, yesMid) {
  const ev = `${series}-L${++seq}`, ticker = `${ev}-00`;
  const m = { ticker, event_ticker: ev, close_time: new Date(Date.now() + mins * 60e3).toISOString(), floor_strike: 60000, strike_type: 'greater_or_equal',
    yes_ask_dollars: (yesMid + 0.01).toFixed(4), yes_bid_dollars: (yesMid - 0.01).toFixed(4), no_ask_dollars: (1 - yesMid + 0.01).toFixed(4), exchange_index: 2, status: 'open' };
  W.markets[ticker] = m; return m;
}
const settle = (m, result) => Object.assign(m, { close_time: new Date(Date.now() - 5 * 60e3).toISOString(), status: 'settled', result, keep: true });
// production-sized state (what overflowed Telegram's 4096-char limit on 11/23): full calibration history, every lane, research results
const rnd = (a, b) => Math.round((a + Math.random() * (b - a)) * 100) / 100;
const coins = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE', 'NEAR', 'ZEC'];
const LANES = Object.fromEntries(coins.flatMap(c => ['m15', 'h1', 'd1'].map(t => [`${c}|${t}`, { r: Array.from({ length: 12 }, () => rnd(-0.9, 0.8)), bar: 0.03, bench: 0 }])));
const LRN = Object.fromEntries(coins.map(c => [c, { m15: { k: -0.2, mult: 0.55, adopt: true, gain: 0.0234, n: 1602, at: Date.now() }, h1: { k: -0.1, mult: 0.5, adopt: false, gain: -0.0971, n: 330, at: Date.now() } }]));
const hist = Array.from({ length: 200 }, () => [Math.floor(rnd(1, 9.9) * 100), Math.floor(rnd(1, 9.9) * 100), Math.random() < 0.5 ? 1 : 0]);
W.pinned = '⚙️ BOT SETTINGS (do not unpin)\n' + JSON.stringify({ v: 12, PAPER: 1, MAKER: 1, AUTO_FAST: 1, AUTO_HOURLY: 1, ALWAYS_IN: 0, RESERVE: 1, PAPERS: { r: Array.from({ length: 45 }, () => rnd(-0.9, 0.6)).concat([0.1, -0.2]).slice(-2), pos: [], bids: {}, since: Date.now() },
  LANES, LRN, SC: { n: 85, wins: 29, sumP: 36, brier: 18, pnl: -2.9, open: [], ev: {}, hist } });
W.shards = { 0: 0.66, 2: 0 };

(async () => {
  const { post } = start({}); await wait(800);
  const send = t => post({ message: { chat: { id: 42 }, text: t } });
  const o0 = W.orders.length, hist0 = (pinned().SC || {}).hist || [];

  console.log('\n1. Buys whichever side is winning at the 10th and 12th minute');
  const early = market('KXETH15M', 9, 0.80);          // 9 min left: too early for this test
  const up = market('KXBTC15M', 2.9, 0.80);             // YES winning at 80¢
  const down = market('KXSOL15M', 2.9, 0.15);           // NO winning (YES at 15¢ → NO ask 86¢)
  const tie = market('KXXRP15M', 2.9, 0.50);            // no clear leader
  const dear = market('KXDOGE15M', 2.9, 0.985);         // winner costs 99.5¢ — above the max
  await send('/_fasttick'); await wait(3500);
  const L = k => (((pinned().PAPERS || {}).late || {}).v || {})[k] || { pos: [], r: [] };
  const pos = L('m12').pos;
  ok(pos.some(o => o.t === up.ticker && o.side === 'yes' && Math.abs(o.px - 0.81) < 1e-9), 'YES winning → paper buy YES at the ask (81¢)', JSON.stringify(pos));
  ok(pos.some(o => o.t === down.ticker && o.side === 'no' && Math.abs(o.px - 0.86) < 1e-9), 'NO winning → paper buy NO at the ask (86¢)', JSON.stringify(pos));
  ok(!pos.some(o => o.t === tie.ticker), 'no clear leader (50/50) → no trade');
  ok(!pos.some(o => o.t === dear.ticker), 'winner above the max price → no trade');
  ok(!pos.some(o => o.t === early.ticker) && !L('m10').pos.some(o => o.t === early.ticker), 'nothing before the 10th minute');
  ok(L('m10').pos.length === 0, 'markets at the 12th minute are not 10th-minute entries');
  ok(W.orders.length === o0, 'paper only: no real orders');
  await send('/_fasttick'); await wait(2500);
  ok(L('m12').pos.filter(o => o.t === up.ticker).length === 1, 'one entry per window (no repeats on later scans)');
  const notYet = market('KXZEC15M', 3.4, 0.80);        // 11:36 into the window — before the 12th minute
  await send('/_fasttick'); await wait(2500);
  ok(!L('m12').pos.some(o => o.t === notYet.ticker), 'waits for the full 12 minutes (not at 11:36)');
  delete W.markets[notYet.ticker];
  const ten = market('KXETH15M', 4.8, 0.70);           // 10th minute, YES winning
  await send('/_fasttick'); await wait(3000);
  ok(L('m10').pos.some(o => o.t === ten.ticker && o.side === 'yes') && !L('m12').pos.some(o => o.t === ten.ticker), '10th-minute entry goes to its own record');
  delete W.markets[ten.ticker];

  console.log('\n2. Graded on Kalshi results, separate from the main paper record');
  settle(up, 'yes'); settle(down, 'yes'); await send('/_lateclosed'); await wait(100);
  await send('/scan'); await wait(5000);
  const res = msgs().find(m => /BUY-THE-WINNER TEST/.test(m)) || '';
  ok(/✅ BTC 15-min YES @ 81¢ \+\$0\.18/.test(res), 'winner graded: +19¢ less the taker fee', res);
  ok(/❌ SOL 15-min NO @ 86¢ −\$0\.87/.test(res), 'loser graded: −86¢ less the taker fee', res);
  ok(/12th-minute test: 2 trades · 1W·1L · −\$0\.69/.test(res) && /10th-minute test: 0 trades/.test(res), 'each variant keeps its own record', res);
  ok((pinned().PAPERS.r || []).length === 2, 'main paper record untouched (go-live proof unaffected)');
  ok(((pinned().SC || {}).hist || []).length === hist0.length, 'calibration history untouched');
  await send('/paper'); await wait(300);
  ok(/⏰ 10th-minute test: 0 trades.*1 open/.test(last()) && /⏰ 12th-minute test: 2 trades/.test(last()), '/paper shows both test records', last());

  console.log('\n3. Can be switched off');
  await send('/set late 0'); await wait(300);
  const off = market('KXHYPE15M', 2.9, 0.80);
  await send('/_fasttick'); await wait(3000);
  ok(!L('m12').pos.some(o => o.t === off.ticker), '/set late 0 → no entries');

  console.log('\n4. Saved state always fits in Telegram (4096 chars) with a full day of test trades');
  await send('/set late 1'); await wait(200);
  for (let k = 0; k < 3; k++) { for (const c of ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE', 'NEAR', 'ZEC']) { market(`KX${c}15M`, 4.8, 0.8); market(`KX${c}15M`, 2.9, 0.2); } await send('/_fasttick'); await wait(4000); } // 3 windows of open positions (more than ever pile up live)
  const P = pinned();
  ok(W.pinned.length <= 4096, `pinned settings fit Telegram's limit (${W.pinned.length} chars)`);
  ok(P.PAPERS.late.v.m10.pos.length >= 18 && P.PAPERS.late.v.m12.pos.length >= 18, 'open test positions were saved', JSON.stringify({ m10: P.PAPERS.late.v.m10.pos.length, m12: P.PAPERS.late.v.m12.pos.length }));
  ok(P.PAPERS.late.v.m12.n === 2 && P.PAPERS.late.v.m12.w === 1 && Math.abs(P.PAPERS.late.v.m12.sum + 0.69) < 1e-9, 'running totals saved (survive restarts)', JSON.stringify(P.PAPERS.late.v.m12));
  ok(!P.PAPERS.late.seen, 'in-memory dedupe map not saved (it overflowed the limit)');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('TEST CRASH', e); process.exit(1); });
