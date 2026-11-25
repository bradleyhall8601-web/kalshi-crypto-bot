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

  console.log('\n6. Rebuilds the trades the save bug dropped (v14)');
  const before = { m10: L('m10').pos.length, m12: L('m12').pos.length };
  await send('/_laterecover'); await wait(5500);
  const R = pinned().PAPERS.late.v;
  ok(R.m10.pos.length - before.m10 === 17 && R.m12.pos.length - before.m12 === 19, '17 + 19 lost trades restored as positions to grade', JSON.stringify({ before, m10: R.m10.pos.length, m12: R.m12.pos.length }));
  ok(R.m12.pos.some(o => o.t === 'KXBTC15M-26NOV231900-00' && o.side === 'yes' && o.px === 0.97 && o.c === Date.parse('2026-11-24T00:00:00Z')), 'tickers, sides, prices and close times match the logs');
  ok(R.m10.pos.some(o => o.t === 'KXSOL15M-26NOV231830-30' && o.side === 'no' && o.px === 0.54 && o.c === Date.parse('2026-11-23T23:30:00Z')), 'ticker suffix matches the window minute');
  await send('/_laterecover'); await wait(5500);
  ok(pinned().PAPERS.late.v.m12.pos.length === R.m12.pos.length, 'running it twice adds nothing');
  ok(/rebuilt from the bot's logs/.test(msgs().join('\n')), 'Brad is told about the restore');
  ok(W.pinned.length <= 4096, `still fits Telegram's limit (${W.pinned.length} chars)`);

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
  ok(!real.some(o => o.ticker === l10.ticker), '10th-minute (failed test) never uses real money');
  ok(/💵 REAL BUY \(12th-minute\)/.test(msgs().join('\n')), 'Brad gets a REAL BUY message');
  ok(L('m12').pos.some(o => o.t === lb.ticker), 'paper record still kept alongside');
  await send('/_fasttick'); await wait(2500);
  ok(W.orders.slice(r0).filter(o => o.ticker === lb.ticker).length === 1, 'one real buy per coin per window');
  settle(lb, 'yes'); settle(le, 'no'); await send('/_lateclosed'); await send('/_livelateclosed'); await wait(100);
  await send('/scan'); await wait(5000);
  const lm = msgs().filter(m => /REAL money:/.test(m)).slice(-1)[0] || '';
  ok(/✅ BTC 15-min YES @ 81¢ \+\$0\.17/.test(lm) && /❌ ETH 15-min YES @ 81¢ −\$0\.83/.test(lm), 'real results graded with the real fill price and fee', lm);
  ok(/STOPPED itself: down \$0\.66/.test(lm), 'turns itself off after the loss limit', lm);
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

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('TEST CRASH', e); process.exit(1); });
