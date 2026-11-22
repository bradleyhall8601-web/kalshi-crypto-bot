// Limit-bid (maker) engine: post at the bid instead of paying the ask, manage, cancel, book fills.
// Plus half-Kelly sizing and the small-account reserve. Run: node test/maker.js
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
  const ev = `${series}-M${++seq}`, ticker = `${ev}-T${strike}`, close = Date.now() + mins * 60e3;
  const p = rawP(W[coin], strike, W.vol, mins), mid = Math.round(Math.min(0.9, Math.max(0.1, p - gap)) * 100) / 100, half = 0.01;
  const m = { ticker, event_ticker: ev, close_time: new Date(close).toISOString(), floor_strike: strike, strike_type: 'greater_or_equal',
    yes_ask_dollars: (mid + half).toFixed(4), yes_bid_dollars: (mid - half).toFixed(4), no_ask_dollars: (1 - mid + half).toFixed(4), exchange_index: 2, status: 'open' };
  W.markets[ticker] = m; return m;
}
const clear = () => { for (const k of Object.keys(W.markets)) delete W.markets[k]; };
const bids = () => W.orders.filter(o => o.time_in_force === 'good_till_canceled');
W.shards = { 0: 20, 2: 0 };

(async () => {
  const { post } = start({}); await wait(800);
  const send = t => post({ message: { chat: { id: 42 }, text: t } });
  await send('/set maker 1'); await send('/set kelly 0.5'); await send('/set tradepct 0.06'); await wait(300);

  console.log('\n1. Small edge → a resting limit bid (not a taker buy)');
  const m1 = market('KXBTC15M', 'btc', 9, 59990, -0.08);
  await send('/_fasttick'); await wait(3000);
  const b1 = bids().find(o => o.ticker === m1.ticker);
  ok(!!b1 && b1.post_only === true && b1.expiration_time > Date.now() / 1000, 'post-only GTC bid with an expiry', JSON.stringify(W.orders.slice(-1)[0]));
  ok(!W.orders.some(o => o.ticker === m1.ticker && o.time_in_force === 'immediate_or_cancel'), 'did not pay the ask');
  const yesAsk = Number(m1.yes_ask_dollars), yesBid = Number(m1.yes_bid_dollars);
  ok(b1 && (b1.side === 'bid' ? Number(b1.price) < yesAsk : Number(b1.price) > yesBid), 'bid never crosses the spread', b1 && (b1.side + ' ' + b1.price + ' book ' + yesBid + '/' + yesAsk));
  ok(b1 && Number(b1.count) <= 2, 'half-Kelly sizing on a ~$20 account: small (≤2 contracts)', b1 && b1.count);
  await send('/bids'); await wait(300);
  ok(/Resting limit bids/.test(last()) && /BTC 15-min/.test(last()), '/bids lists it', last());

  console.log('\n2. One bid per window, no duplicates');
  const n0 = W.orders.length; await send('/_fasttick'); await wait(2500);
  ok(W.orders.length === n0, 'no second order while one rests', W.orders.slice(n0).map(o => o.ticker).join(','));

  console.log('\n3. A seller fills it → receipt + ledger');
  const rid = Object.keys(W.resting).find(k => W.resting[k].ticker === m1.ticker && W.resting[k].remaining > 0);
  W.fillResting(rid, Number(b1.count));
  await send('/_fasttick'); await wait(2500);
  ok(msgs().some(t => /🟢🤖 LIMIT BUY FILLED · BTC 15-min/.test(t) && /bid, not ask/.test(t)), 'fill reported in Telegram', msgs().slice(-2).join(' | '));
  await send('/status'); await wait(400);
  ok(/limit bids ON \(0 resting\)/.test(last()), 'filled bid no longer resting', last());
  ok(/today \$0\.[1-9]|today \$1/.test(last()), 'spend recorded in the ledger', last());

  console.log('\n4. Edge disappears → bid cancelled');
  clear(); const m2 = market('KXETH15M', 'eth', 9, 1679.9, -0.08);
  await send('/_fasttick'); await wait(2500);
  const r2 = Object.values(W.resting).find(r => r.ticker === m2.ticker && r.remaining > 0);
  ok(!!r2, 'bid posted on ETH');
  const eth0 = W.eth; W.eth = eth0 * 1.0015; // ETH jumps up: the NO bid has no edge any more
  await send('/_fasttick'); await wait(2500); W.eth = eth0;
  ok(r2 && W.cancels.includes(r2.id), 'cancelled when the edge is gone', JSON.stringify(W.cancels));

  console.log('\n5. Window about to close → bid cancelled');
  clear(); const m3 = market('KXBTC15M', 'btc', 1.62, 59998, -0.08);
  await send('/_fasttick'); await wait(2500);
  const r3 = Object.values(W.resting).find(r => r.ticker === m3.ticker && r.remaining > 0);
  ok(!!r3, 'bid posted close to the end');
  await wait(6000); await send('/_fasttick'); await wait(2000);
  ok(r3 && W.cancels.includes(r3.id), 'cancelled before the final 90 seconds', JSON.stringify(W.cancels));

  console.log('\n6. Pause cancels every resting bid');
  clear(); const m4 = market('KXETH15M', 'eth', 9, 1679.9, -0.08);
  await send('/_fasttick'); await wait(2500);
  const r4 = Object.values(W.resting).find(r => r.ticker === m4.ticker && r.remaining > 0);
  await send('/pause'); await wait(300); await send('/_fasttick'); await wait(2000);
  ok(r4 && W.cancels.includes(r4.id), 'paused → bid cancelled');
  await send('/resume'); await wait(300);

  console.log('\n7. Big edge still buys right away (taker), no bid on top');
  clear(); const o7 = W.orders.length, m5 = market('KXBTC15M', 'btc', 9, 59970, -0.17);
  await send('/_fasttick'); await wait(3000);
  const mine = W.orders.slice(o7).filter(o => o.ticker === m5.ticker);
  ok(mine.length >= 1 && mine.every(o => o.time_in_force === 'immediate_or_cancel'), 'taker buy for a large edge, no extra bid', mine.map(o => o.time_in_force).join(','));

  console.log('\n7b. Coins move together: max 2 same-direction bets per closing time');
  clear(); await send('/set samedir 2'); await wait(200);
  const close = 9; const before = W.orders.length;
  const cs = [['KXBTC15M', 'btc', 59990], ['KXETH15M', 'eth', 1679.9]].map(([s, c, k]) => market(s, c, close, k, -0.08)); cs[1].close_time = cs[0].close_time;
  await send('/_fasttick'); await wait(3000);
  const after1 = W.orders.slice(before).filter(o => cs.some(m => m.ticker === o.ticker)).length;
  // a third coin, same direction, same closing time
  const m3b = market('KXBTC15M', 'btc', close, 59991, -0.08); // another window, same direction, same closing time
  delete W.markets[m3b.ticker]; m3b.event_ticker = 'KXBTC15M-SAMEDIR'; m3b.ticker = 'KXBTC15M-SAMEDIR-T59991'; m3b.close_time = cs[0].close_time; W.markets[m3b.ticker] = m3b;
  await send('/_fasttick'); await wait(3000);
  ok(after1 === 2 && !W.orders.some(o => o.ticker === m3b.ticker), 'third DOWN bet at the same closing time is skipped', after1 + ' / ' + W.orders.slice(before).map(o => o.ticker).join(','));
  await send('/set samedir 50'); await wait(200);
  for (const o of Object.values(W.resting)) o.remaining = 0;

  console.log('\n8. Small account: reserve scales down so it can still trade');
  clear(); await wait(21000); // account cache
  W.shards = { 0: 1.33, 2: 0 }; W.positions = [];
  await send('/set reservescale 0'); await wait(200);
  const o8 = W.orders.length; market('KXDOGE15M', 'doge', 9, 0.30995, -0.08);
  await send('/_fasttick'); await wait(2500);
  ok(W.orders.length === o8, 'fixed $1 reserve: $1.33 wallet cannot bid');
  await send('/set reservescale 1'); await wait(200); await wait(21000);
  await send('/_fasttick'); await wait(2500);
  ok(W.orders.length > o8, 'scaled reserve (10% of account): bids again with $1.33', W.orders.length - o8);
  const pin = W.pinned || ''; ok(/"REST":\{/.test(pin) || /\nZ:/.test(pin), 'resting bids saved in the pinned settings (survive a restart)');
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('TEST CRASH', e); process.exit(1); });
