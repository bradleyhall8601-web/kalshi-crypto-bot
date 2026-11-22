// All-coin tests: SOL/XRP/DOGE/BNB/HYPE/NEAR/ZEC on 15-min, hourly and daily markets, price-source fallbacks,
// cross-coin shock rules, exposure cap, and self-learning from real results (incl. surviving a restart).
// Run: node test/coins.js   (a second copy of this file runs as the "restarted" bot)
process.env.BOT_TEST = '1';
const { W, start } = require('./harness');
const fs = require('fs'), zlib = require('zlib');
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x = '') => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, x); } };
const msgs = () => W.tg.filter(x => x.method === 'sendMessage' && !String(x.body.text).startsWith('⚙️ BOT SETTINGS')).map(x => x.body.text);
const last = () => msgs().slice(-1)[0] || '';
const N = x => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989422804014327 * Math.exp(-x * x / 2), p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x > 0 ? 1 - p : p; };
const rawP = (S, K, sig, mins) => { const s = sig * Math.sqrt(Math.max(mins - 2 / 3, 0.25)); return N((Math.log(S / K) - s * s / 2) / s); };
let seq = 0;
function market(series, coin, mins, strike, gap, opts = {}) {
  const ev = opts.ev || `${series}-T${++seq}`, ticker = `${ev}-T${strike}`;
  const close = opts.close || Date.now() + mins * 60e3;
  const p = rawP(W[coin], strike, W.vol, (close - Date.now()) / 60e3);
  const mid = Math.min(0.97, Math.max(0.03, p - gap)), half = 0.01;
  const m = { ticker, event_ticker: ev, close_time: new Date(close).toISOString(), floor_strike: strike, strike_type: /15M$/.test(series) ? 'greater_or_equal' : 'greater',
    yes_ask_dollars: (mid + half).toFixed(4), yes_bid_dollars: (mid - half).toFixed(4), no_ask_dollars: (1 - mid + half).toFixed(4), exchange_index: 2, status: 'open' };
  W.markets[ticker] = m; return m;
}
const clear = () => { for (const k of Object.keys(W.markets)) if (W.markets[k].status !== 'settled' || !W.markets[k].keep) delete W.markets[k]; };
const today = (() => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return String(Math.floor((Date.now() - (+p.hour * 3600 + +p.minute * 60 + +p.second) * 1000) / 1000)); })();
// next 5 PM New York time that is 2h..26h away
function next5pmET() {
  for (let h = 2; h < 27; h++) { const t = new Date(Math.ceil((Date.now() + h * 3600e3) / 3600e3) * 3600e3);
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: '2-digit', month: 'short', day: '2-digit' }).formatToParts(t).map(x => [x.type, x.value]));
    if (+p.hour === 17 && +p.minute === 0) return { t: t.getTime(), code: `${p.year}${p.month.toUpperCase()}${p.day}17` }; }
}
const RESTARTED = process.env.COINS_RESTART === '1';

if (!RESTARTED) {
  // previous results the bot "learned" from: DOGE 15-min lost 6 of 8 → should bench; NEAR hourly lost 5 of 6 → +1¢ bar
  const ago = Date.now() - 10 * 60e3, auto = [];
  const seed = (ser, res, i) => { const t = `${ser}-S${i}-00`; W.markets[t] = { ticker: t, event_ticker: `${ser}-S${i}`, status: 'settled', keep: true, result: res, close_time: new Date(ago).toISOString() }; auto.push({ t, s: 'y', n: 1, cost: 0.5, c: ago }); };
  ['no', 'no', 'no', 'yes', 'no', 'no', 'no', 'yes'].forEach((r, i) => seed('KXDOGE15M', r, i));
  ['no', 'yes', 'no', 'no', 'no', 'no'].forEach((r, i) => seed('KXNEARD', r, 100 + i));
  W.pinned = '⚙️ BOT SETTINGS (do not unpin)\n' + JSON.stringify({ v: 8, AUTO_FAST: 1, AUTO_HOURLY: 1, ALWAYS_IN: 0, SMALL_DAY: 0, FAST_DAY: 0, RESERVE: 1, TRADE_PCT: 0.25, MIN_EDGE: 0.04, MIN_PRICE: 0.15, MAX_PRICE: 0.85, MODEL_WEIGHT: 0.5, VOL_MULT: 1, MIN_MINUTES: 8, MAX_MINUTES: 70, FAST_STREAK: 8, DAILY: 1, MAX_OPEN_PCT: 0.6, LEARN: 1,
    LED: { day: today, spent: 0, fast: 0, autoPnl: 0, streak: 0, fastOff: false, auto, n: 0, nAuto: 0, w: 0, l: 0, pnl: 0, fees: 0, best: 0, worst: 0 }, SETL: Date.now() - 60e3,
    SC: { n: 0, wins: 0, sumP: 0, brier: 0, pnl: 0, open: [], ev: {} } }); // no SERIES saved → defaults to every coin
  W.shards = { 0: 20, 2: 0 };
} else {
  W.pinned = fs.readFileSync('/tmp/kbot_coins_pinned.txt', 'utf8'); W.shards = { 0: 20, 2: 0 };
}

(async () => {
  const { post } = start({}); await wait(800);
  const send = t => post({ message: { chat: { id: 42 }, text: t } });
  const orders = () => W.orders.map(o => o.ticker);

  if (RESTARTED) {
    console.log('\nRestart keeps what self-learning decided');
    await send('/learn'); await wait(400);
    ok(/⏸ DOGE 15-min: .*benched till/.test(last()) && /⚠️ NEAR hourly: .*\+1¢ bar/.test(last()), 'benched/tightened markets survive a restart', last());
    const m = market('KXDOGE15M', 'doge', 9, 0.3098, -0.17); const o0 = W.orders.length;
    await send('/_fasttick'); await wait(2500);
    ok(W.orders.length === o0, 'benched DOGE 15-min still sits out after restart');
    console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }

  console.log('\n1. Every coin is on by default');
  await send('/settings'); await wait(300);
  ok(['KXBTCD', 'KXETH15M', 'KXNEARH', 'KXZECH', 'KXSOLD', 'KXSOL15M', 'KXXRP15M', 'KXDOGED', 'KXBNB15M', 'KXHYPED', 'KXHYPE15M', 'KXNEAR15M', 'KXZECD', 'KXZEC15M'].every(x => last().includes(x)), 'BTC, ETH, SOL, XRP, DOGE, BNB, HYPE, NEAR, ZEC hourly/daily + 15-min all selected', last().split('markets = ')[1]);

  console.log('\n2. Self-learning from real results');
  await send('/scan'); await wait(4000);
  ok(msgs().some(m => /🧠 SELF-LEARNING · DOGE 15-min benched 6h — last 8: 2W·6L −\$2\.00/.test(m)), 'losing DOGE 15-min benched 6h, reported in Telegram', msgs().filter(m => /🧠/.test(m)).join(' | '));
  ok(msgs().some(m => /🧠 SELF-LEARNING · NEAR hourly losing \(last 6: 1W·5L −\$2\.00\) → now needs \+1¢ extra edge/.test(m)), 'losing NEAR hourly needs +1¢ more edge');
  ok(!msgs().some(m => /🛑 Auto trading stopped/.test(m)), 'one losing market type does not stop the whole bot');
  await send('/learn'); await wait(300);
  ok(/⏸ DOGE 15-min/.test(last()) && /⚠️ NEAR hourly/.test(last()), '/learn shows per-market results', last());

  console.log('\n3. Smaller coins trade automatically (15-min)');
  clear(); let o0 = W.orders.length;
  const sol = market('KXSOL15M', 'sol', 9, 139.93, -0.17), xrp = market('KXXRP15M', 'xrp', 9, 2.0989, -0.17), doge = market('KXDOGE15M', 'doge', 9, 0.3098, -0.17);
  await send('/_fasttick'); await wait(4000);
  ok(orders().slice(o0).includes(sol.ticker) && orders().slice(o0).includes(xrp.ticker), 'SOL and XRP 15-min auto-bought (no tap)', orders().slice(o0).join(','));
  ok(msgs().some(m => /🟢🤖 AUTO BUY · SOL 15-min/.test(m)) && msgs().some(m => /🟢🤖 AUTO BUY · XRP 15-min/.test(m)), 'receipts name the coin');
  ok(!orders().slice(o0).includes(doge.ticker), 'benched DOGE 15-min skipped by self-learning');
  ok(!msgs().some(m => /TRADE IDEA/.test(m)), 'everything is auto — no tap alerts');

  console.log('\n4. Coins missing from big exchanges: fallbacks');
  clear(); W.unlisted = { hype: ['coinbase', 'bitstamp', 'gemini'], zec: ['coinbase', 'bitstamp', 'gemini', 'kraken'] }; W.urls = []; o0 = W.orders.length;
  const hype = market('KXHYPE15M', 'hype', 9, 37.98, -0.17), zec = market('KXZEC15M', 'zec', 9, 51.97, -0.17), btc = market('KXBTC15M', 'btc', 9, 59970, -0.17);
  await send('/_fasttick'); await wait(4000);
  ok(orders().slice(o0).includes(hype.ticker), 'HYPE trades on Kraken + Hyperliquid prices with Hyperliquid candles', orders().slice(o0).join(','));
  ok(!orders().slice(o0).includes(zec.ticker) && msgs().some(m => /🚧 ZEC trading paused — only 1 live exchange price/.test(m)), 'ZEC with a single price source is paused and reported');
  ok(orders().slice(o0).includes(btc.ticker), 'BTC keeps trading while ZEC is paused');
  const cb1 = W.urls.filter(u => /coinbase.*HYPE/.test(u)).length; W.urls = [];
  await send('/_fasttick'); await wait(2500);
  ok(cb1 >= 1 && W.urls.filter(u => /coinbase.*HYPE/.test(u)).length === 0, 'exchanges that do not list a coin are not asked again', cb1);
  W.unlisted = {};
  clear(); W.hlSkew = 1.007; o0 = W.orders.length; // Hyperliquid's perp price runs 0.7% above 4 spot exchanges
  const h2 = market('KXHYPE15M', 'hype', 9, 37.98, -0.17);
  await send('/_fasttick'); await wait(3000);
  ok(orders().slice(o0).includes(h2.ticker), 'one odd price source is left out instead of pausing the coin', orders().slice(o0).join(','));
  W.hlSkew = 1; W.krakenSkew = 1.01; W.geminiSkew = 1.01; clear(); o0 = W.orders.length; // a real 2-vs-2 split → stay paused
  const s9 = market('KXXRP15M', 'xrp', 9, 2.0989, -0.17);
  await send('/_fasttick'); await wait(3000);
  ok(!orders().slice(o0).includes(s9.ticker), 'exchanges split down the middle → coin stays paused');
  W.krakenSkew = 1; W.geminiSkew = 1; clear(); await send('/_fasttick'); await wait(1500);

  console.log('\n5. Shock rules across coins');
  clear(); W.shock = { coin: 'btc', pct: -0.02 }; o0 = W.orders.length;
  const s1 = market('KXSOL15M', 'sol', 9, 139.93, -0.17);
  await send('/_fasttick'); await wait(2500);
  await send('/why'); await wait(300);
  ok(!orders().slice(o0).includes(s1.ticker) && /SOL: ⏸ blocked — .*BTC sudden drop/.test(last()), 'a BTC crash pauses SOL too', last());
  clear(); W.shock = { coin: 'sol', pct: -0.03 }; o0 = W.orders.length;
  const b1 = market('KXBTC15M', 'btc', 9, 59970, -0.17), s2 = market('KXSOL15M', 'sol', 9, 139.93, -0.17);
  await send('/_fasttick'); await wait(3000);
  ok(orders().slice(o0).includes(b1.ticker) && !orders().slice(o0).includes(s2.ticker), 'a SOL-only crash pauses SOL, not BTC', orders().slice(o0).join(','));
  W.shock = null; await send('/_fasttick'); await wait(1500);

  console.log('\n6. Daily markets (5 PM ET)');
  clear(); await wait(21000); o0 = W.orders.length; // let Kalshi's position list (cached 20s) show the closed positions gone
  const nx = next5pmET(), mins = (nx.t - Date.now()) / 60e3;
  const dly = market('KXBTCD', 'btc', mins, 59900, -0.17, { ev: `KXBTCD-${nx.code}`, close: nx.t });
  const far = market('KXBTCD', 'btc', 300, 59900, -0.12, { close: Math.floor((Date.now() + 300 * 60e3) / 3600e3) * 3600e3 + 1800e3 }); // ~5h out at :30 → not a daily, not within the hour
  await send('/scan'); await wait(5000);
  ok(orders().slice(o0).includes(dly.ticker) && msgs().some(m => /🟢🤖 AUTO BUY · BTC daily/.test(m)), `daily 5 PM ET market auto-traded (${Math.round(mins)} min out)`, orders().slice(o0).join(','));
  ok(!orders().slice(o0).includes(far.ticker), 'far-off non-daily hourly market ignored');

  console.log('\n7. Money guard: never too much tied up at once');
  clear(); await send('/set maxopen 0.1'); await wait(200); o0 = W.orders.length;
  market('KXETH15M', 'eth', 9, 1679.2, -0.17);
  await send('/_fasttick'); await wait(2500);
  ok(W.orders.length === o0, 'no new trade when open positions already exceed the cap');
  await send('/set maxopen 0.6'); await wait(200);

  console.log('\n8. Coverage + saved state');
  await send('/coins'); await wait(3000);
  ok(/🪙 COVERAGE/.test(last()) && /SOL: /.test(last()) && /ZEC: /.test(last()) && /💱/.test(last()), '/coins lists every coin with markets and price feeds', last());
  const pin = W.pinned; let blob = null;
  try { const zi = pin.indexOf('\nZ:'); blob = zi >= 0 ? JSON.parse(zlib.inflateRawSync(Buffer.from(pin.slice(zi + 3), 'base64')).toString()) : JSON.parse(pin.slice(pin.indexOf('{'))); } catch (e) {}
  ok(pin.length <= 4096 && blob && blob.LANES && blob.LANES['DOGE|m15'] && blob.LANES['DOGE|m15'].bench > Date.now(), 'self-learning saved in the pinned message (fits Telegram limit)', pin.length);
  fs.writeFileSync('/tmp/kbot_coins_pinned.txt', pin);
  const r = require('child_process').spawnSync(process.execPath, [__filename], { env: { ...process.env, COINS_RESTART: '1' }, encoding: 'utf8', timeout: 60e3 });
  process.stdout.write((r.stdout || '').split('\n').filter(l => /✅|❌|Restart/.test(l)).join('\n') + '\n');
  ok(r.status === 0, 'restarted bot passes its checks', (r.stderr || '').slice(-300));
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('TEST CRASH', e); process.exit(1); });
