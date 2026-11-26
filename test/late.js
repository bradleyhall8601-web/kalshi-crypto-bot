// 12th-minute / last-12-min "buy the winner" tests (own records; real money for the 12th-minute). Run: node test/late.js
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
const until = async (f, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (f()) return true; } catch (e) {} await new Promise(r => setTimeout(r, 200)); } return false; }; // pinned saves can lag under load
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

  console.log('\n1. Buys whichever side is winning at the 12th minute');
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
  ok(!pos.some(o => o.t === early.ticker), 'nothing 9 minutes before the close');
  ok(!(((pinned().PAPERS || {}).late || {}).v || {}).m10, '10th-minute test is gone from the saved settings (removed 11/25)');
  ok(W.orders.length === o0, 'paper only: no real orders');
  await send('/_fasttick'); await wait(2500);
  ok(L('m12').pos.filter(o => o.t === up.ticker).length === 1, 'one entry per window (no repeats on later scans)');
  const notYet = market('KXZEC15M', 3.4, 0.80);        // 11:36 into the window — before the 12th minute
  await send('/_fasttick'); await wait(2500);
  ok(!L('m12').pos.some(o => o.t === notYet.ticker), 'waits for the full 12 minutes (not at 11:36)');
  delete W.markets[notYet.ticker];
  const ten = market('KXETH15M', 4.8, 0.70);           // 10th minute, YES winning
  await send('/_fasttick'); await wait(3000);
  ok(!L('m12').pos.some(o => o.t === ten.ticker) && W.orders.length === o0, '10th minute is no longer traded (failed test removed)');
  delete W.markets[ten.ticker];

  console.log('\n2. Graded on Kalshi results, separate from the main paper record');
  settle(up, 'yes'); settle(down, 'yes'); await send('/_lateclosed'); await wait(100);
  await send('/scan'); await wait(5000);
  const res = msgs().find(m => /BUY-THE-WINNER TEST/.test(m)) || '';
  ok(/✅ BTC 15-min YES @ 81¢ \+\$0\.18/.test(res), 'winner graded: +19¢ less the taker fee', res);
  ok(/❌ SOL 15-min NO @ 86¢ −\$0\.87/.test(res), 'loser graded: −86¢ less the taker fee', res);
  ok(/12th-minute test: 2 trades · 1W·1L · −\$0\.69/.test(res) && !/10th-minute/.test(res), 'the 12th-minute test keeps its own record (no 10th-minute line)', res);
  ok((pinned().PAPERS.r || []).length === 2, 'main paper record untouched (go-live proof unaffected)');
  ok(((pinned().SC || {}).hist || []).length === hist0.length, 'calibration history untouched');
  await send('/paper'); await wait(300);
  ok(/⏰ 12th-minute test: 2 trades/.test(last()) && !/10th-minute/.test(last()), '/paper shows the 12th-minute record', last());

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
  ok(P.PAPERS.late.v.m12.pos.length >= 18, 'open test positions were saved', JSON.stringify({ m12: P.PAPERS.late.v.m12.pos.length }));
  ok(P.PAPERS.late.v.m12.n === 2 && P.PAPERS.late.v.m12.w === 1 && Math.abs(P.PAPERS.late.v.m12.sum + 0.69) < 1e-9, 'running totals saved (survive restarts)', JSON.stringify(P.PAPERS.late.v.m12));
  ok(!P.PAPERS.late.seen, 'in-memory dedupe map not saved (it overflowed the limit)');

  console.log('\n5. Counts 15-min windows and gives a verdict at 50');
  ok(/12th-minute test: 2 trades.*· 1\/50 windows/.test((await (send('/paper'), wait(300)), last())), 'two coins in one window count as 1 window', last());
  await send('/_latewindows 49'); await wait(100);
  const v1 = market('KXBTC15M', 2.9, 0.80); await send('/_fasttick'); await wait(3000);
  settle(v1, 'yes'); await send('/_lateclosed'); await wait(100); await send('/scan'); await wait(5000);
  const vm = msgs().filter(m => /BUY-THE-WINNER TEST/.test(m)).slice(-1)[0] || '';
  ok(/❌ 12th-minute test FAILED after 50 windows: -17\.0¢\/contract \(needed \+2¢\)/.test(vm), 'losing record at 50 windows → FAILED verdict', vm);
  ok(pinned().PAPERS.late.v.m12.verdict === 'fail' && pinned().PAPERS.late.v.m12.nw === 50, 'verdict and window count saved', JSON.stringify(pinned().PAPERS.late.v.m12));
  const v2 = market('KXBTC15M', 2.9, 0.80); await send('/_fasttick'); await wait(3000);
  settle(v2, 'yes'); await send('/_lateclosed'); await wait(100); await send('/scan'); await wait(5000);
  ok(!/FAILED|PASSED/.test(msgs().filter(m => /BUY-THE-WINNER TEST/.test(m)).slice(-1)[0] || ''), 'verdict is announced only once');

  console.log('\n7. REAL money 12th-minute strategy (Brad 11/24: go full blown)');
  W.shards[0] = 15.66; W.shards[2] = 0;
  const r0 = W.orders.length;
  await send('/set latestop 0.5'); await wait(200);
  await send('/set latelive 1'); await wait(300);
  const lb = market('KXBTC15M', 2.9, 0.80), le = market('KXETH15M', 2.9, 0.80), l10 = market('KXSOL15M', 4.8, 0.80);
  await send('/_fasttick'); await wait(4000);
  const real = W.orders.slice(r0);
  ok(real.some(o => o.ticker === lb.ticker && o.side === 'bid' && o.count === '1.00' && o.time_in_force === 'immediate_or_cancel'), 'BTC: real buy of 1 YES at the 12th minute', JSON.stringify(real));
  ok(real.some(o => o.ticker === le.ticker), 'every coin trades, not just BTC');
  ok(!real.some(o => o.ticker === l10.ticker), 'nothing at the 10th minute (removed variant) uses real money');
  const rb = msgs().filter(m => /💵 REAL BUY \(12th-minute\)/.test(m));
  ok(rb.length === 1 && /BTC 15-min/.test(rb[0]) && /ETH 15-min/.test(rb[0]) && /2 coins/.test(rb[0]) && /Wallet ≈/.test(rb[0]), 'all the window\'s real buys arrive in ONE message', JSON.stringify(rb));
  ok(L('m12').pos.some(o => o.t === lb.ticker), 'paper record still kept alongside');
  await send('/_fasttick'); await wait(2500);
  ok(W.orders.slice(r0).filter(o => o.ticker === lb.ticker).length === 1, 'one real buy per coin per window');
  settle(lb, 'yes'); settle(le, 'no'); await send('/_lateclosed'); await send('/_livelateclosed'); await wait(100);
  await send('/scan'); await wait(5000);
  await until(() => (pinned().PAPERS.late.live || {}).n === 2);
  const lm = msgs().filter(m => /BUY-THE-WINNER/.test(m)).slice(-1)[0] || '', LVr = pinned().PAPERS.late.live;
  ok(LVr.n === 2 && LVr.w === 1 && Math.abs(LVr.sum + 0.66) < 1e-9, 'real results graded with the real fill price and fee (+$0.17, −$0.83)', JSON.stringify(LVr));
  ok(/STOPPED itself: down \$0\.66/.test(lm), 'turns itself off after the loss limit', lm);
  ok(!/REAL money:/.test(msgs().join('\n')), 'real wins/losses are not repeated in the test summary (Kalshi results message covers them)');
  const P7 = pinned(); ok(P7.LATE_LIVE === 0 && P7.PAPERS.late.live.n === 2 && P7.PAPERS.late.live.stopped, 'stop and real record saved', JSON.stringify({ on: P7.LATE_LIVE, live: P7.PAPERS.late.live }));
  const r1 = W.orders.length; market('KXXRP15M', 2.9, 0.80); await send('/_fasttick'); await wait(3000);
  ok(W.orders.length === r1, 'no real buys after the stop');

  console.log('\n8. Size grows with the account, capped at 60% in open bets');
  await send('/_livereset'); await send('/set latestop 50'); await send('/set latelive 1'); await wait(300);
  W.shards[0] = 40; W.shards[2] = 0; const r2 = W.orders.length;
  const g1 = market('KXBTC15M', 2.9, 0.80); await send('/_fasttick'); await wait(3500);
  ok(W.orders.slice(r2).some(o => o.ticker === g1.ticker && o.count === '2.00'), '$40 account → 2 contracts per coin', JSON.stringify(W.orders.slice(r2)));
  await send('/set lateper 1'); await wait(200); W.shards[0] = 10; W.shards[2] = 0; const r3 = W.orders.length;
  const g2 = market('KXETH15M', 2.9, 0.80); await send('/_fasttick'); await wait(3500);
  const big = W.orders.slice(r3).find(o => o.ticker === g2.ticker), open7 = 2 * 0.81 + 0.03;
  ok(big && Number(big.count) * 0.81 <= 0.6 * (10 + open7) - open7 + 1e-9 && Number(big.count) >= 1, 'never more than 60% of the money in open bets', JSON.stringify(big));
  ok(W.pinned.length <= 4096, `still fits Telegram's limit (${W.pinned.length} chars)`);

  console.log('\n9. Hourly + daily: strike nearest the opening price, buy the leader with 12 min left; real money only after passing');
  const ladder = (ev, mins, mids) => mids.map((mid, i) => { const t = `${ev}-T${60000 + i * 500}`; const m = { ticker: t, event_ticker: ev, close_time: new Date(Date.now() + mins * 60e3).toISOString(), floor_strike: 60000 + i * 500, strike_type: 'greater_or_equal',
    yes_ask_dollars: (mid + 0.01).toFixed(4), yes_bid_dollars: (mid - 0.01).toFixed(4), no_ask_dollars: (1 - mid + 0.01).toFixed(4), exchange_index: 0, status: 'open' }; W.markets[t] = m; return m; });
  const reclose = (ms, mins, mids) => ms.forEach((m, i) => Object.assign(m, { close_time: new Date(Date.now() + mins * 60e3).toISOString(), yes_ask_dollars: (mids[i] + 0.01).toFixed(4), yes_bid_dollars: (mids[i] - 0.01).toFixed(4), no_ask_dollars: (1 - mids[i] + 0.01).toFixed(4) }));
  const hEv = 'KXBTCD-26NOV2410'; let hs = ladder(hEv, 59, [0.85, 0.52, 0.18]);
  await send('/scan'); await wait(3000);
  reclose(hs, 11.5, [0.97, 0.80, 0.30]); const rh = W.orders.length;
  await send('/scan'); await wait(3000);
  await until(() => L('h12').pos.some(o => o.t === hs[1].ticker));
  ok(L('h12').pos.some(o => o.t === hs[1].ticker && o.side === 'yes'), 'hourly: buys the leader on the strike that was at-the-money when the hour opened', JSON.stringify(L('h12').pos));
  ok(!L('h12').pos.some(o => o.t === hs[0].ticker || o.t === hs[2].ticker), 'only that one strike per hour');
  ok(W.orders.length === rh, 'hourly stays paper until it passes its own 50-window test');
  await send('/_latepass h12'); await send('/_livereset'); W.shards[0] = 40; await wait(100);
  const hEv2 = 'KXBTCD-26NOV2411'; const hs2 = ladder(hEv2, 59, [0.80, 0.49, 0.2]); await send('/scan'); await wait(3000);
  reclose(hs2, 11.5, [0.9, 0.20, 0.05]); const rh2 = W.orders.length; await send('/scan'); await wait(3500);
  ok(W.orders.slice(rh2).some(o => o.ticker === hs2[1].ticker && o.side === 'ask'), 'after passing, hourly trades real money (NO leader here)', JSON.stringify(W.orders.slice(rh2)));
  await send('/paper'); await wait(300);
  ok(/hourly last-12-min test/.test(last()) && /daily last-12-min test/.test(last()), '/paper shows the hourly and daily tests', last());
  ok(((pinned().PAPERS.late || {}).hA || {})[hEv2], 'hourly anchors are saved too (a restart keeps the hour)');
  ok(W.pinned.length <= 4096, `still fits Telegram's limit (${W.pinned.length} chars)`);

  console.log('\n10. Daily: strike pinned when the day is listed, saved for restarts, leader bought with 12 min left');
  let fivePM = Math.ceil(Date.now() / 3600e3) * 3600e3; while (new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(fivePM) !== '17') fivePM += 3600e3;
  for (const k of Object.keys(W.markets)) if (k.startsWith('KXETHD')) delete W.markets[k];
  const dEv = 'KXETHD-DAILYTEST'; const ds = ladder(dEv, 60, [0.9, 0.5, 0.1]); ds.forEach(m => { m.close_time = new Date(fivePM).toISOString(); });
  await send('/_ladderat KXETHD 800'); await wait(5000); // the pinned save can lag a few seconds behind
  await until(() => ((pinned().PAPERS.late || {}).dA || {})[dEv]);
  const dA = (pinned().PAPERS.late || {}).dA || {};
  ok(dA[dEv] && dA[dEv].t === ds[1].ticker, 'daily: at-the-money strike pinned and saved in the settings (survives a restart)', JSON.stringify(dA));
  reclose(ds, 0, [0.99, 0.12, 0.02]); ds.forEach(m => { m.close_time = new Date(fivePM).toISOString(); });
  await send('/_ladderat KXETHD 11.5'); await wait(2500);
  await until(() => L('d12').pos.some(o => o.t === ds[1].ticker));
  ok(L('d12').pos.some(o => o.t === ds[1].ticker && o.side === 'no'), 'daily: buys the leader (NO) on the pinned strike with 12 min left', JSON.stringify(L('d12').pos));

  console.log('\n11. Real fills: one transfer per window, one re-quote retry when the price jumps');
  await send('/_livereset'); await send('/set lateper 15'); await send('/set latestop 50'); await send('/set latelive 1'); await wait(300);
  W.shards[0] = 15; W.shards[2] = 0; const tr11 = W.transfers.length, or11 = W.orders.length;
  const f1 = market('KXBTC15M', 2.9, 0.80), f2 = market('KXETH15M', 2.9, 0.80), f3 = market('KXSOL15M', 2.9, 0.20), f4 = market('KXXRP15M', 2.9, 0.80);
  W.jump = { [f2.ticker]: 0.02, [f4.ticker]: 0.06 };
  await send('/_fasttick'); await wait(6000);
  const ords = W.orders.slice(or11);
  ok(W.transfers.length - tr11 === 1, 'only one shard transfer for the whole window (was one per coin)', `${W.transfers.length - tr11} transfers`);
  ok(ords.filter(o => o.ticker === f2.ticker).length === 2 && W.fills.some(f => f.ticker === f2.ticker), 'missed by a 2¢ jump → re-quoted and filled on the retry', JSON.stringify(ords.filter(o => o.ticker === f2.ticker)));
  ok(ords.filter(o => o.ticker === f4.ticker).length === 1 && !W.fills.some(f => f.ticker === f4.ticker), 'jumped 6¢ → no chasing (retry only up to 3¢ higher)');
  ok(W.fills.some(f => f.ticker === f1.ticker) && W.fills.some(f => f.ticker === f3.ticker), 'the other coins fill normally (YES and NO)');
  await until(() => pinned().PAPERS.late.live.pos.length === 3); const LV11 = pinned().PAPERS.late.live; ok(LV11.pos.length === 3, 'three real positions recorded (BTC, ETH retry, SOL)', JSON.stringify(LV11.pos.map(o => o.t)));

  console.log('\n12. Settings still save at the size that overflowed on 11/24 (anchors + live record + long news titles)');
  await send('/_bloat');
  await until(() => ((pinned().PAPERS.late || {}).live || {}).n === 145);
  const P12 = pinned();
  ok(W.pinned.length <= 4096 && P12.PAPERS.late.live.n === 145 && P12.PAPERS.late.live.stopped, `saved (${W.pinned.length} chars) with the real record and stop flag intact`, String(W.pinned.length));
  ok(Object.keys(P12.PAPERS.late.dA || {}).length === 7 && Object.keys(P12.PAPERS.late.hA || {}).length === 14, 'all daily and hourly anchors kept');
  ok(P12.LATE_LIVE !== undefined && P12.LATE_STOP !== undefined, 'settings themselves never trimmed');

  console.log('\n13. 12½-minute test, the four filters, the self-learning switch, partial fills (Brad 11/25: "yes all of that")');
  for (const k of Object.keys(W.markets)) if (W.markets[k].status === 'open') delete W.markets[k];
  await send('/_livereset'); await send('/set latestop 10000'); await send('/set latelive 0'); await wait(300);
  W.shards[0] = 15.66; W.shards[2] = 0;
  const m125open = async () => { await send('/paper'); await wait(400); const x = last().match(/12½-minute test: [^\n]*· (\d+) open/); return x ? +x[1] : -1; };
  const k0 = await m125open();
  const h9 = market('KXBTC15M', 2.9, 0.80);
  await send('/_fasttick'); await wait(3000);
  ok(await m125open() === k0 && L('m12').pos.some(o => o.t === h9.ticker), '12th-minute enters at 2.9 min left; 12½-minute waits', last());
  h9.close_time = new Date(Date.now() + 2.4 * 60e3).toISOString();
  await send('/_fasttick'); await wait(3000);
  ok(await m125open() === k0 + 1, '12½-minute enters at 2.4 min left (12:36 into the window)', last());
  ok(L('m12').pos.filter(o => o.t === h9.ticker).length === 1, 'the 12th-minute entry is not repeated');
  ok((((pinned().PAPERS.late.v || {}).m125 || {}).pos || []).length === 0, '12½-minute open trades stay in memory (keeps the save small)');
  ok(['max 2 per side', 'model agrees', 'calm market', 'no fresh news', 'all filters'].every(n => last().includes('🔎 12th-min · ' + n + ':')), '/paper lists every filter record', last());
  const fl = L('m12').pos.find(o => o.t === h9.ticker);
  ok(fl && typeof fl.f === 'number' && (fl.f & 4), 'filters recorded on the trade (no fresh news → news filter passes)', JSON.stringify(fl));
  await send('/_newsfresh');
  const n1 = market('KXETH15M', 2.9, 0.15); // NO leads at 86¢; ETH ~$1,680 vs a $60,000 strike, so the model is sure NO wins
  await send('/_fasttick'); await wait(3000);
  const fn = L('m12').pos.find(o => o.t === n1.ticker);
  ok(fn && !(fn.f & 4) && (fn.f & 1), 'fresh market-moving headline → news filter skips it; the model agrees with the leader', JSON.stringify(fn));
  await send('/_newsold');
  // one window, three coins betting YES and one NO: "max 2 per side" keeps the two YES priced highest
  const wa = market('KXSOL15M', 2.9, 0.90), wb = market('KXXRP15M', 2.9, 0.70), wc = market('KXDOGE15M', 2.9, 0.15), wd = market('KXZEC15M', 2.9, 0.80);
  for (const m of [wb, wc, wd]) m.close_time = wa.close_time;
  await send('/_fasttick'); await wait(4000);
  ok([wa, wb, wc, wd].every(m => L('m12').pos.some(o => o.t === m.ticker)), 'all four coins entered by the 12th-minute rule', JSON.stringify(L('m12').pos.map(o => o.t)));
  const q0 = pinned().PAPERS.late.f; await send('/_lateelig cap'); await wait(100);
  settle(h9, 'yes'); settle(n1, 'no'); settle(wa, 'yes'); settle(wb, 'no'); settle(wc, 'no'); settle(wd, 'yes');
  await send('/_lateage'); await send('/scan'); await wait(6000);
  await until(() => (pinned().PAPERS.late.f.news || {}).n >= (q0.news.n || 0) + 5);
  const q1 = pinned().PAPERS.late.f;
  ok(q1.news.n - q0.news.n === 5, 'news filter record: the 5 trades without fresh news', JSON.stringify({ before: q0.news, after: q1.news }));
  ok(q1.cap.n === 60 + 5 && Math.abs(q1.cap.sum - (3 + 0.18 + 0.13 + 0.08 + 0.13 + 0.18)) < 0.02, 'max-2-per-side record: XRP (3rd YES, cheapest) left out of the window', JSON.stringify(q1.cap));
  const sw = msgs().filter(m => /SELF-LEARNING SWITCH/.test(m)).slice(-1)[0] || '';
  ok(/now follows "12th-min · max 2 per side"/.test(sw) && pinned().PAPERS.late.ch === 'cap', 'a rule proven over 50+ windows at +2¢ takes over real money (and it is saved)', sw);
  // real money now follows "max 2 per side": only the two YES priced highest are bought; a sliver fill is topped up
  await send('/set latelive 1'); await wait(300);
  const r13 = W.orders.length;
  const xa = market('KXSOL15M', 2.9, 0.90), xb = market('KXXRP15M', 2.9, 0.70), xc = market('KXDOGE15M', 2.9, 0.15), xd = market('KXZEC15M', 2.9, 0.80);
  for (const m of [xb, xc, xd]) m.close_time = xa.close_time;
  W.partial = { [xd.ticker]: 0.01 };
  await send('/_fasttick'); await wait(5000);
  const o13 = W.orders.slice(r13);
  ok(o13.some(o => o.ticker === xa.ticker) && o13.some(o => o.ticker === xc.ticker) && !o13.some(o => o.ticker === xb.ticker), 'real buys: top-2 YES + the NO; the cheapest YES is skipped', JSON.stringify(o13.map(o => o.ticker)));
  const pz = (pinned().PAPERS.late.live.pos || []).find(o => o.t === xd.ticker);
  ok(o13.filter(o => o.ticker === xd.ticker).length === 2 && o13.filter(o => o.ticker === xd.ticker)[1].count === '0.99' && pz && Math.abs(pz.n - 1) < 1e-9, 'a 0.01-contract sliver is kept and topped up with just the other 0.99 (not a whole extra contract: live 11/26 bought 1.6)', JSON.stringify({ pz, orders: o13.filter(o => o.ticker === xd.ticker).map(o => o.count) }));
  ok(msgs().some(m => /💵 REAL BUY \(12th-min · max 2 per side\) · 3 coins/.test(m)), 'the buy message names the rule real money follows', msgs().filter(m => /REAL BUY/.test(m)).slice(-1)[0]);
  // the rule stops proving itself → real money goes back to the plain 12th-minute rule
  await send('/_lateinelig cap'); await wait(100);
  for (const [m, r] of [[xa, 'yes'], [xb, 'no'], [xc, 'no'], [xd, 'yes']]) settle(m, r);
  await send('/_lateage'); await send('/_livelateclosed'); await send('/scan'); await wait(6000);
  await until(() => !pinned().PAPERS.late.ch || pinned().PAPERS.late.ch === 'm12');
  ok(msgs().some(m => /stopped proving itself.*back on the plain 12th-minute rule/.test(m)) && (pinned().PAPERS.late.ch || 'm12') === 'm12', 'back to the 12th-minute rule when the leader fades (money stays on)');
  await send('/set latelive 0'); await wait(200);

  console.log('\n14. Benching, cheaper bids, sell-early, free-money scanner, bigger bets once proven (Brad 11/25 evening)');
  for (const k of Object.keys(W.markets)) if (W.markets[k].status === 'open') delete W.markets[k];
  await send('/_livereset'); await send('/set latelive 0'); await wait(300); W.shards[0] = 15.66; W.shards[2] = 0;
  await send('/_bench BTC'); await wait(100);
  const bA = market('KXBTC15M', 2.9, 0.80), bB = market('KXETH15M', 2.9, 0.80), bC = market('KXSOL15M', 2.9, 0.80);
  for (const m of [bB, bC]) m.close_time = bA.close_time;
  await send('/_fasttick'); await wait(4000);
  const pA = L('m12').pos.find(o => o.t === bA.ticker), pB = L('m12').pos.find(o => o.t === bB.ticker);
  ok(pA && (pA.f & 128) && !(pA.f & 8) && pB && (pB.f & 8), 'a losing coin (BTC) is benched on its new trades; ETH is not', JSON.stringify({ pA, pB }));
  await send('/paper'); await wait(400);
  ok(/🪑 Benched now: BTC/.test(last()) && /🆓 Free-money scanner today/.test(last()) && /bid 2¢ under test/.test(last()) && /sell early if it flips test/.test(last()), '/paper shows benched coins, the scanner and both new tests', last());
  // cheaper bid: ETH's ask comes down to our bid → filled at the bid; BTC's never does → miss at 1 min left
  bB.yes_ask_dollars = '0.7900'; bB.yes_bid_dollars = '0.7700';
  bC.close_time = new Date(Date.now() + 1.5 * 60e3).toISOString(); bC.yes_bid_dollars = '0.4000'; bC.yes_ask_dollars = '0.4200'; // SOL flips: YES bid 40¢ with 1.5 min left
  bA.close_time = bB.close_time = bC.close_time;
  await send('/_fasttick'); await wait(4000);
  for (const m of [bA, bB, bC]) m.close_time = new Date(Date.now() + 0.9 * 60e3).toISOString();
  await send('/_fasttick'); await wait(4000);
  await send('/paper'); await wait(400);
  ok(/bid 2¢ under test: 0 trades[^\n]*· 2 open · 1 bids never filled/.test(last()), 'bid 2¢ under: ETH filled when its ask came down, SOL filled as it crashed (the catch), BTC missed', last());
  ok(/sell early if it flips test: [^\n]*· 1 sold early/.test(last()), 'sell early: SOL sold when its side fell to 40¢', last());
  const bn0 = pinned().PAPERS.late.f.bench.n; await send('/_lateelig news'); await wait(100);
  settle(bA, 'yes'); settle(bB, 'yes'); settle(bC, 'no');
  await send('/_lateage'); await send('/scan'); await wait(6000);
  await until(() => ((pinned().PAPERS.late.v.m12x || {}).xn || 0) >= 1);
  const P14 = pinned().PAPERS.late;
  ok(P14.v.m12b.n === 2 && P14.v.m12b.w === 1 && Math.abs(P14.v.m12b.sum + 0.6) < 1e-9 && P14.v.m12b.miss === 1 && P14.v.m12b.r.length === 0, 'bid test graded at the bid price: ETH +$0.20 at 79¢ (vs +$0.18 at 81¢), SOL −$0.80', JSON.stringify(P14.v.m12b));
  ok(P14.v.m12x.xn === 1 && Math.abs(P14.v.m12x.xs - 0.38) < 0.011, 'sell early: sold SOL at 40¢ (−$0.44) instead of losing $0.82 → saved $0.38', JSON.stringify(P14.v.m12x));
  ok(P14.f.bench.n - bn0 === 2, 'skip-losing-coins record took ETH and SOL, not benched BTC', JSON.stringify({ before: bn0, after: P14.f.bench }));
  ok(P14.bn && P14.bn.c.ETH && P14.bn.c.ETH[2] + P14.bn.c.ETH[0] >= 1 && Object.keys(P14.bn.t).length >= 1, 'coin and time-of-day records are kept and saved', JSON.stringify(P14.bn));
  ok(P14.ch === 'news' && msgs().some(m => /now follows "12th-min · no fresh news"[\s\S]*1 contract per \$10/.test(m)), 'a proven rule takes over and its bets grow (switch message says so)', msgs().filter(m => /SWITCH/.test(m)).slice(-1)[0]);
  // bigger bets once proven: 1 per $10, ×2/×3 on the surest signals
  await send('/set latelive 1'); await wait(300); const r14 = W.orders.length;
  const sz = market('KXETH15M', 2.9, 0.15); // NO leads at 86¢; the model is sure (ETH ~$1,680 vs a $60,000 strike)
  await send('/_fasttick'); await wait(4000);
  const zo = W.orders.slice(r14).find(o => o.ticker === sz.ticker), zf = (L('m12').pos.find(o => o.t === sz.ticker) || {}).f || 0;
  ok(zo && Number(zo.count) === 1 && (zf & 7) === 7, `proven rule sizing: 1 contract even on the surest signal (flags ${zf & 7}; no 2×/3× since 11/26), $15.66 / $10 = 1`, JSON.stringify(zo));
  // the free-money scanner: an upside-down ladder (the higher strike priced MORE likely) is a guaranteed gap
  const a0 = (pinned().PAPERS.late.arb || {}).n || 0;
  ladder('KXBTCD-26NOV2520', 40, [0.59, 0.70]);
  await send('/scan'); await wait(4000);
  await until(() => ((pinned().PAPERS.late.arb || {}).n || 0) > a0);
  const A14 = pinned().PAPERS.late.arb || {};
  ok(A14.n === a0 + 1 && Math.abs(A14.best - 0.05) < 0.006, 'scanner found the gap: YES 60¢ + NO 31¢ + 4¢ fees = 95¢ for a $1 minimum payout', JSON.stringify(A14));
  ok(W.orders.length === r14 + (zo ? (W.orders.slice(r14).length) : 0) && !W.orders.slice(r14).some(o => /KXBTCD-26NOV2520/.test(o.ticker)), 'the scanner only watches (no orders)');
  await send('/set latelive 0'); await wait(200);

  console.log('\n15. Real resting bids and real early sales (Brad 11/25 evening: "Do what\'s needed"), checks during safety pauses');
  for (const k of Object.keys(W.markets)) if (W.markets[k].status === 'open') delete W.markets[k];
  await send('/_livereset'); await send('/set latelive 0'); await wait(300); W.shards[0] = 15.66; W.shards[2] = 0;
  const soldEarly = async () => { await send('/paper'); await wait(400); const x = last().match(/(\d+) sold early/); return x ? +x[1] : -1; };
  const missN = async () => { await send('/paper'); await wait(400); const x = last().match(/(\d+) bids never filled/); return x ? +x[1] : -1; };
  // 15a: a safety pause no longer hides a flip or a bid's fate
  const pA15 = market('KXSOL15M', 2.9, 0.80), pB15 = market('KXXRP15M', 2.9, 0.80);
  await send('/_fasttick'); await wait(3500);
  const se0 = await soldEarly(), mi0 = await missN();
  W.shock = { coin: 'btc', pct: -0.02 }; // BTC drops 2%: every coin is paused
  pA15.close_time = new Date(Date.now() + 1.5 * 60e3).toISOString(); pA15.yes_bid_dollars = '0.4000'; pA15.yes_ask_dollars = '0.4200'; // SOL flips mid-pause
  await send('/_fasttick'); await wait(3500);
  ok(msgs().some(m => /🚧 .*trading paused — BTC sudden drop/.test(m)) && await soldEarly() === se0 + 1, 'during a safety pause the sell-early test still sees SOL flip', last());
  pB15.close_time = new Date(Date.now() + 0.9 * 60e3).toISOString();
  await send('/_fasttick'); await wait(3500);
  ok(await missN() === mi0 + 1, 'during a safety pause an unfilled bid is still closed out at 1 min left (XRP; SOL\'s crash filled its bid)', last());
  // 15d (pause messages): no "clear" until 3 calm minutes; a flicker stays one "paused"; a new pause after a "clear" is always said
  const pz0 = msgs().filter(m => /trading paused/.test(m)).length, cz0 = msgs().filter(m => /conditions clear again/.test(m)).length;
  W.shock = null; await send('/_fasttick'); await wait(3000);
  ok(msgs().filter(m => /conditions clear again/.test(m)).length === cz0, 'no "clear" message the moment the shock passes');
  W.shock = { coin: 'btc', pct: -0.02 }; await send('/_fasttick'); await wait(3000);
  ok(msgs().filter(m => /trading paused/.test(m)).length === pz0, 'it flickers back within 3 minutes: no second "paused" (Brad never heard "clear")');
  W.shock = null; await send('/_fasttick'); await wait(3000); await send('/_clearage'); await send('/_fasttick'); await wait(3000);
  ok(msgs().filter(m => /conditions clear again/.test(m)).length === cz0 + 1, '"clear" is said after 3 calm minutes', msgs().slice(-3).join(' || '));
  W.shock = { coin: 'btc', pct: -0.02 }; await send('/_fasttick'); await wait(3000);
  ok(msgs().filter(m => /trading paused/.test(m)).length === pz0 + 1, 'a new pause right after "clear" is always said (11/25 6:30 PM was skipped in silence)');
  W.shock = null; await send('/_fasttick'); await wait(2500); await send('/_clearage'); await send('/_fasttick'); await wait(2500);
  for (const m of [pA15, pB15]) delete W.markets[m.ticker];
  // 15b: "sell early if it flips" leads real money: real buys, then a real reduce-only sale when the side drops to 45¢ or less
  await send('/_lateelig m12x'); await send('/_champ m12x'); await send('/set latelive 1'); await wait(300);
  const r15 = W.orders.length, s0 = (W.sells || []).length;
  const xY = market('KXETH15M', 2.9, 0.80), xN = market('KXDOGE15M', 2.9, 0.15); xN.close_time = xY.close_time;
  await send('/_fasttick'); await wait(4500);
  const LVp = () => pinned().PAPERS.late.live.pos || [];
  await until(() => LVp().filter(o => o.x).length === 2);
  const pY = LVp().find(o => o.t === xY.ticker), pN = LVp().find(o => o.t === xN.ticker);
  ok(pY && pY.x === 1 && pN && pN.x === 1 && W.orders.slice(r15).filter(o => o.time_in_force === 'immediate_or_cancel' && !o.reduce_only).length === 2, 'real buys at the 12th minute, marked for the sell-early rule', JSON.stringify(LVp()));
  await send('/_fasttick'); await wait(3000);
  ok((W.sells || []).length === s0, 'no sale while each side still leads');
  for (const m of [xY, xN]) m.close_time = new Date(Date.now() + 1.5 * 60e3).toISOString();
  xY.yes_bid_dollars = '0.4000'; xY.yes_ask_dollars = '0.4200';          // ETH YES falls to a 40¢ bid
  xN.yes_bid_dollars = '0.5800'; xN.yes_ask_dollars = '0.6000';          // DOGE flips: NO's bid is 1 − 60¢ = 40¢
  await send('/_fasttick'); await wait(5000);
  const sl = W.orders.slice(r15).filter(o => o.reduce_only);
  ok(sl.length === 2 && sl.every(o => o.time_in_force === 'immediate_or_cancel') && sl.some(o => o.ticker === xY.ticker && o.side === 'ask' && o.price === '0.3900') && sl.some(o => o.ticker === xN.ticker && o.side === 'bid' && o.price === '0.6100'),
    'reduce-only IOC sales: ETH YES offered at 39¢+, DOGE NO sold by bidding YES at ≤61¢ (= NO at 39¢+)', JSON.stringify(sl));
  ok((W.sells || []).length === s0 + 2 && W.sells.slice(s0).every(x => Math.abs(x.got - 0.40) < 1e-9), 'both filled at the 40¢ bid', JSON.stringify(W.sells.slice(s0)));
  ok(!W.positions.some(p => p.ticker === xY.ticker || p.ticker === xN.ticker), 'both Kalshi positions are closed (nothing left, nothing opened)', JSON.stringify(W.positions.filter(p => /ETH15M|DOGE15M/.test(p.ticker))));
  const soldMsg = msgs().filter(m => /🔻 SOLD EARLY/.test(m));
  ok(soldMsg.length === 2 && /bought @ 81¢ → sold @ 40¢ with 1\.\d min left: −\$0\.\d\d \(riding it to a loss would be −\$0\.8\d\)/.test(soldMsg.join('\n')) && soldMsg.every(m => /📊 Today \d+W·\d+L/.test(m)), 'Telegram: each early sale, what it saved vs riding it to $0, today\'s tally', soldMsg.join(' || '));
  await until(() => LVp().filter(o => o.sn >= o.n).length === 2);
  const LV15 = pinned().PAPERS.late.live, want15 = LV15.pos.reduce((a, o) => a + o.sp - o.cost, 0), cost15 = LV15.pos.reduce((a, o) => a + o.cost, 0);
  ok(LV15.pos.every(o => o.sn === o.n && o.sp > 0) && LV15.xadj < 0 && (LV15.soldT || []).length === 2, 'sales saved (sold count, proceeds, the all-time adjustment, sold tickers)', JSON.stringify(LV15));
  const o15 = W.orders.length; await send('/_fasttick'); await wait(3000);
  ok(!W.orders.slice(o15).some(o => o.reduce_only), 'sold positions are not sold again');
  // graded once Kalshi has the result: the sale is the result (here both would have lost: the sale saved money)
  settle(xY, 'no'); settle(xN, 'yes');
  W.settlements.push({ ticker: xY.ticker, market_result: 'no', yes_count_fp: '0.00', no_count_fp: '0.00', yes_total_cost_dollars: '0', no_total_cost_dollars: '0', revenue: 0, fee_cost: '0', settled_time: new Date().toISOString() });
  const tally0 = msgs().filter(m => /🧾 RESULTS|🏆 WIN|💔 LOSS/.test(m)).length;
  await send('/_livelateclosed'); await send('/scan'); await wait(6000);
  await until(() => (pinned().PAPERS.late.live.pos || []).length === 0);
  const LVg = pinned().PAPERS.late.live;
  ok(LVg.n === 2 && LVg.w === 0 && Math.abs(LVg.sum - want15) < 0.011 && LVg.sum > -cost15 + 0.5, 'real record: the two sales (proceeds − cost), not two total losses', JSON.stringify({ LVg, want15, cost15 }));
  ok(Math.abs(LVg.xadj - want15) < 0.011, 'all-time profit adjustment equals the sale results', JSON.stringify(LVg.xadj));
  ok(msgs().filter(m => /🧾 RESULTS|🏆 WIN|💔 LOSS/.test(m)).length === tally0, 'Kalshi\'s empty settlement for a fully sold market is not reported as a result (the sale already was)');
  // 15c: "bid 2¢ under" leads real money: a real resting bid (expires by itself at 1 min left), filled → real position; unfilled → cancelled
  await send('/_livereset'); await send('/_lateelig m12b'); await send('/_champ m12b'); await send('/set latelive 1'); await wait(300); W.shards[0] = 15.66;
  const rb15 = W.orders.length;
  const bY = market('KXBNB15M', 2.9, 0.80), bM = market('KXHYPE15M', 2.9, 0.80); bM.close_time = bY.close_time;
  await send('/_fasttick'); await wait(4500);
  const bo = W.orders.slice(rb15);
  const gY = bo.find(o => o.ticker === bY.ticker), gM = bo.find(o => o.ticker === bM.ticker);
  ok(gY && gY.time_in_force === 'good_till_canceled' && gY.price === '0.7900' && !gY.post_only && Math.abs(gY.expiration_time * 1000 - (Date.parse(bY.close_time) - 60e3)) < 1500 && gM && gM.price === '0.7900',
    'real bids at 79¢ (2¢ under the 81¢ ask), expiring by themselves at 1 min left', JSON.stringify(bo));
  ok(!bo.some(o => o.time_in_force === 'immediate_or_cancel'), 'no ask-paying buy when the bid rule leads');
  const rid = Object.keys(W.resting).find(id => W.resting[id].ticker === bY.ticker);
  W.fillResting(rid, Number(gY.count)); bY.yes_ask_dollars = '0.7900'; bY.yes_bid_dollars = '0.7700'; // a seller comes down to us
  await send('/_fasttick'); await wait(4000);
  await until(() => (pinned().PAPERS.late.live.pos || []).some(o => o.t === bY.ticker));
  const fb = (pinned().PAPERS.late.live.pos || []).find(o => o.t === bY.ticker);
  ok(fb && Math.abs(fb.px - 0.79) < 1e-9 && fb.n === Number(gY.count) && fb.oid === rid, 'the filled bid is a real position at 79¢', JSON.stringify(fb));
  ok(msgs().some(m => /💵 REAL BUY \(12th-min · bid 2¢ under\) · 1 coin[\s\S]*@ 79¢ \(bid, not ask 💡\)/.test(m)), 'Telegram: real buy at the bid', msgs().filter(m => /REAL BUY/.test(m)).slice(-1)[0]);
  for (const m of [bY, bM]) m.close_time = new Date(Date.now() + 0.9 * 60e3).toISOString();
  const c0 = W.cancels.length;
  await send('/_fasttick'); await wait(4000);
  const mid = Object.keys(W.resting).find(id => W.resting[id].ticker === bM.ticker);
  ok(W.cancels.slice(c0).includes(mid) && !(pinned().PAPERS.late.live.pos || []).some(o => o.t === bM.ticker), 'HYPE: no seller came by 1 min left → bid cancelled, nothing bought', JSON.stringify(W.cancels.slice(c0)));
  ok(!JSON.stringify(pinned().PAPERS.late).includes('lbids'), 'resting late bids are not in the pinned save (memory only; Kalshi expires them)');
  await send('/set latelive 0'); await send('/_champ m12'); await wait(200);
  // 15e: a picky filter with 50+ windows but only 22 trades is not "proven" (11/25 10 PM: "all filters" was hours from taking real money at 3× size on 22 trades)
  for (const k of ['m12x', 'm12b', 'news', 'cap', 'm125', 'calm', 'mdl']) await send('/_lateinelig ' + k);
  await send('/_lateelig all 22'); await wait(200);
  const sw15 = msgs().filter(m => /SELF-LEARNING SWITCH/.test(m)).length;
  const ea15 = market('KXSOL15M', 2.9, 0.80);
  await send('/_fasttick'); await wait(3500);
  settle(ea15, 'yes'); await send('/_lateage'); await send('/scan'); await wait(6000);
  await until(() => !L('m12').pos.some(o => o.t === ea15.ticker));
  ok(L('m12').pos.every(o => o.t !== ea15.ticker) && msgs().filter(m => /SELF-LEARNING SWITCH/.test(m)).length === sw15 && pinned().PAPERS.late.ch !== 'all', '60 windows at +9¢ but only 22 trades: not proven, real money does not switch to it', String(pinned().PAPERS.late.ch));

  // 16 (11/26, Brad: "do what's best for profit"): real 15-min money sits out leaders under 60¢ and US mornings; paper still takes them; no 2×/3×
  console.log('\n16. Real money skips coin flips (<60¢) and US mornings (6–10 AM CT on US weekdays); paper tests still take them');
  for (const k of Object.keys(W.markets)) if (W.markets[k].status === 'open') delete W.markets[k];
  await send('/_livereset'); await send('/_champ m12'); await send('/set latelive 1'); await wait(300); W.shards[0] = 15.66;
  const r16 = W.orders.length, cf = market('KXSOL15M', 2.9, 0.56), ok16 = market('KXXRP15M', 2.9, 0.80); ok16.close_time = cf.close_time;
  await send('/_fasttick'); await wait(4500);
  const o16 = W.orders.slice(r16);
  ok(!o16.some(o => o.ticker === cf.ticker) && L('m12').pos.some(o => o.t === cf.ticker), 'SOL leader at 57¢: no real buy, the paper test still takes it', JSON.stringify(o16.map(o => [o.ticker, o.price])));
  ok(o16.some(o => o.ticker === ok16.ticker), 'XRP leader at 81¢: real buy as usual');
  for (const m of [cf, ok16]) delete W.markets[m.ticker];
  await send('/_ctclock 7 1'); await wait(100);
  const r16b = W.orders.length, am = market('KXDOGE15M', 2.9, 0.80);
  await send('/_fasttick'); await wait(4000);
  ok(!W.orders.slice(r16b).some(o => o.ticker === am.ticker) && L('m12').pos.some(o => o.t === am.ticker), '7 AM CT on a US weekday: no real buy, paper still takes it', JSON.stringify(W.orders.slice(r16b).map(o => o.ticker)));
  delete W.markets[am.ticker];
  await send('/_ctclock 7 0'); await wait(100);
  const r16c = W.orders.length, hol = market('KXBNB15M', 2.9, 0.80);
  await send('/_fasttick'); await wait(4000);
  ok(W.orders.slice(r16c).some(o => o.ticker === hol.ticker), '7 AM CT on a weekend or US holiday (no data, no stock open): real buy as usual');
  delete W.markets[hol.ticker];
  await send('/_ctclock 11 1'); await wait(100);
  const r16d = W.orders.length, noon = market('KXHYPE15M', 2.9, 0.80);
  await send('/_fasttick'); await wait(4000);
  ok(W.orders.slice(r16d).some(o => o.ticker === noon.ticker), '11 AM CT on a weekday: real buy as usual');
  delete W.markets[noon.ticker];
  await send('/_ctclock off'); await send('/set latelive 0'); await wait(200);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('TEST CRASH', e); process.exit(1); });
