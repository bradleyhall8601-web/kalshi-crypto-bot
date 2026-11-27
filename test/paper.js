// Paper trading: no real orders, honest fills, graded on Kalshi results, auto go-live when proven. Run: node test/paper.js
process.env.BOT_TEST = '1';
const { W, start } = require('./harness');
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x = '') => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, x); } };
const msgs = () => W.tg.filter(x => x.method === 'sendMessage' && !String(x.body.text).startsWith('⚙️ BOT SETTINGS')).map(x => x.body.text);
const last = () => msgs().slice(-1)[0] || '';
const N = x => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989422804014327 * Math.exp(-x * x / 2), p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x > 0 ? 1 - p : p; };
const rawP = (S, K, sig, mins) => { const s = sig * Math.sqrt(Math.max(mins - 2 / 3, 0.25)); return N((Math.log(S / K) - s * s / 2) / s); };
let seq = 0;
function market(series, coin, mins, strike, gap) {
  const ev = `${series}-P${++seq}`, ticker = `${ev}-T${strike}`, close = Date.now() + mins * 60e3;
  const p = rawP(W[coin], strike, W.vol, mins), mid = Math.round(Math.min(0.9, Math.max(0.1, p - gap)) * 100) / 100;
  const m = { ticker, event_ticker: ev, close_time: new Date(close).toISOString(), floor_strike: strike, strike_type: 'greater_or_equal',
    yes_ask_dollars: (mid + 0.01).toFixed(4), yes_bid_dollars: (mid - 0.01).toFixed(4), no_ask_dollars: (1 - mid + 0.01).toFixed(4), exchange_index: 2, status: 'open' };
  W.markets[ticker] = m; return m;
}
const today = (() => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return String(Math.floor((Date.now() - (+p.hour * 3600 + +p.minute * 60 + +p.second) * 1000) / 1000)); })();
// 49 graded paper trades averaging +3¢, one more already closed and about to be graded as a win
const ago = Date.now() - 10 * 60e3, tk = 'KXBTC15M-OLD1-00';
W.markets[tk] = { ticker: tk, event_ticker: 'KXBTC15M-OLD1', status: 'settled', result: 'no', close_time: new Date(ago).toISOString(), keep: true };
W.pinned = '⚙️ BOT SETTINGS (do not unpin)\n' + JSON.stringify({ v: 11, PAPER: 1, MAKER: 1, AUTO_FAST: 1, AUTO_HOURLY: 1, ALWAYS_IN: 0, RESERVE: 1,
  PAPERS: { r: Array.from({ length: 49 }, (_, i) => i % 2 ? 0.55 : -0.49), tot: { n: 149, sum: 4, w: 80 }, pos: [{ t: tk, ev: 'KXBTC15M-OLD1', side: 'no', px: 0.45, c: ago, p: 0.5, pb: 500, mk: 450, kind: 'bid' }], bids: {}, since: ago },
  LED: { day: today, spent: 0, fast: 0, autoPnl: 0, streak: 0, fastOff: false, auto: [], n: 0, nAuto: 0, w: 0, l: 0, pnl: 0, fees: 0, best: 0, worst: 0 }, SETL: Date.now() - 60e3,
  SC: { n: 0, wins: 0, sumP: 0, brier: 0, pnl: 0, open: [], ev: {} } });
W.shards = { 0: 0.66, 2: 0 }; // tiny real wallet: paper must not care

(async () => {
  const { post } = start({}); await wait(800);
  const send = t => post({ message: { chat: { id: 42 }, text: t } });
  const o0 = W.orders.length;

  console.log('\n1. Paper mode spends nothing');
  const big = market('KXBTC15M', 'btc', 9, 59970, -0.17), small = market('KXETH15M', 'eth', 9, 1679.9, -0.08);
  await send('/_fasttick'); await wait(3000);
  ok(W.orders.length === o0, 'no real orders at all (taker-size or bid-size edges)', W.orders.slice(o0).map(o => o.ticker).join(','));
  await send('/paper'); await wait(300);
  ok(/PAPER TRADING ON/.test(last()) && /2 open · 1 bids waiting/.test(last()), 'big edge = paper buy at the ask, small edge = paper bid (+1 older open)', last());
  await send('/status'); await wait(400);
  ok(/Mode: 📄 PAPER/.test(last()), '/status shows paper mode');

  console.log('\n2. Paper bids fill only when a seller comes down to the bid');
  await send('/_fasttick'); await wait(2500);
  await send('/paper'); await wait(300);
  ok(/1 bids waiting/.test(last()), 'no seller yet → still waiting (no free fills)', last());
  const mid = Number(small.yes_ask_dollars) - 0.01; // our NO bid sits at the NO mid; push the NO ask down to it
  Object.assign(small, { no_ask_dollars: (1 - mid).toFixed(4), yes_bid_dollars: mid.toFixed(4) });
  await send('/_fasttick'); await wait(2500);
  await send('/paper'); await wait(300);
  ok(/3 open · 0 bids waiting/.test(last()), 'seller came down to our price → paper fill', last());
  ok(W.orders.length === o0, 'still no real orders');

  console.log('\n3. Graded on real results; proven record switches real trading back on');
  await send('/scan'); await wait(5000);
  ok(msgs().some(m => /📄 PAPER RESULTS/.test(m) && /✅ BTC 15-min/.test(m) && /\+\$0\.55/.test(m)), 'paper result graded from Kalshi settlement', msgs().filter(m => /PAPER/.test(m)).join(' | '));
  ok(msgs().some(m => /✅ PAPER RECORD PROVEN: 150 trades averaging \+3\.\d¢ per contract \(last 50: \+3\.\d¢\)/.test(m)), '150 trades at +3¢ (last 50 too) → goes live automatically', msgs().filter(m => /PROVEN/.test(m)).join(' | '));
  await send('/status'); await wait(400);
  ok(!/Mode: 📄 PAPER/.test(last()), 'real mode after proof', last().split('\n')[1]);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('TEST CRASH', e); process.exit(1); });
