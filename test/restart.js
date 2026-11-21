// Restart test: the bot boots with a pinned settings message from a previous run.
process.env.BOT_TEST = '1';
const { W, start } = require('./harness');
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x = '') => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, x); } };
const msgs = () => W.tg.filter(x => x.method === 'sendMessage' && !String(x.body.text).startsWith('⚙️ BOT SETTINGS')).map(x => x.body.text);
const last = () => msgs().slice(-1)[0] || '';

const today = (() => { // same day-key the bot uses (midnight Chicago, unix seconds)
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return String(Math.floor((Date.now() - (+p.hour * 3600 + +p.minute * 60 + +p.second) * 1000) / 1000));
})();
const closedAgo = Date.now() - 10 * 60e3, openClose = Date.now() + 30 * 60e3;
W.markets['KXBTCD-OLD-T60000'] = { ticker: 'KXBTCD-OLD-T60000', event_ticker: 'KXBTCD-OLD', status: 'settled', result: 'yes', close_time: new Date(closedAgo).toISOString() };
// an open market in a window we already alerted on: must NOT alert again after restart
W.markets['KXBTCD-SEEN-T60040'] = { ticker: 'KXBTCD-SEEN-T60040', event_ticker: 'KXBTCD-SEEN', status: 'open', close_time: new Date(openClose).toISOString(), floor_strike: 60040, strike_type: 'greater', yes_ask_dollars: '0.2600', yes_bid_dollars: '0.2400', no_ask_dollars: '0.7600', exchange_index: 2 };
W.pinned = '⚙️ BOT SETTINGS (do not unpin)\n' + JSON.stringify({
  MIN_EDGE: 0.05, SMALL_TRADE: 3, SMALL_DAY: 20, UNLOCK_PROFIT: 100, RELOCK_PROFIT: 50, SCALED_TRADE_PCT: 0.02, SCALED_DAY_PCT: 0.1, MIN_PRICE: 0.15, MAX_PRICE: 0.85,
  MIN_MINUTES: 8, MAX_MINUTES: 70, MODEL_WEIGHT: 0.5, VOL_MULT: 1, MAX_ALERTS_PER_RUN: 2, SCAN_EVERY_MIN: 1, ALERT_TTL_MIN: 4, SERIES: ['KXBTCD'], manualLock: true, paused: false, v: 4,
  SC: { n: 0, wins: 0, sumP: 0, brier: 0, pnl: 0, open: [{ t: 'KXBTCD-OLD-T60000', s: 'y', p: 0.6, a: 0.5, c: closedAgo }], ev: { 'KXBTCD-SEEN': openClose } },
  LED: { day: today, spent: 6.5, fast: 4, autoPnl: 0, streak: 0, fastOff: false, auto: [1, 2, 3, 4].map(i => ({ t: 'KXBTC15M-L' + i + '-00', s: 'y', n: 3, cost: 1.5, c: closedAgo })) },
  SETL: Date.now() - 60e3,
});

for (let i = 1; i <= 4; i++) W.markets['KXBTC15M-L' + i + '-00'] = { ticker: 'KXBTC15M-L' + i + '-00', event_ticker: 'KXBTC15M-L' + i, status: 'settled', result: 'no', close_time: new Date(closedAgo).toISOString() };
W.settlements = [
  { ticker: 'KXBTCD-OLD-T60000', settled_time: new Date(Date.now() - 30e3).toISOString(), market_result: 'yes', revenue: 1800, yes_total_cost: 210, no_total_cost: 0, fee_cost: '0.1234' },
  { ticker: 'KXBTCD-ANCIENT', settled_time: new Date(Date.now() - 3600e3).toISOString(), revenue: 0, yes_total_cost: 100, no_total_cost: 0 },
];
(async () => {
  const { post } = start({});
  await wait(800);
  const send = t => post({ message: { chat: { id: 42 }, text: t } });
  console.log('\nRestart persistence');
  await send('/settings'); await wait(300);
  const st = msgs().find(m => /Current settings/.test(m)) || ''; ok(/edge = 0.05/.test(st) && /trade = 3/.test(st) && /day = 20/.test(st) && /markets = KXBTCD$/m.test(st), 'custom settings restored', st);
  await send('/status'); await wait(500);
  ok(/Today: \$6\.50 of \$20\.00/.test(last()), "today's spending restored (fees + NO buys kept)", last());
  await send('/auto'); await send('/lock'); await wait(300);
  await send('/scan'); await wait(1500);
  ok(!msgs().some(m => /TRADE IDEA/.test(m) && /60,040/.test(m)), 'already-alerted window not re-alerted after restart');
  await send('/stats'); await wait(300);
  ok(/Settled: 1/.test(last()) && /actual: 100%/.test(last()) && /Paper profit: \+\$0\.48/.test(last()), 'scorecard graded the settled alert', last());
  ok(msgs().some(m => /✅ WON \+\$15\.78 · KXBTCD-OLD-T60000 settled YES/.test(m)), 'new settlement reported with profit');
  ok(!msgs().some(m => /KXBTCD-ANCIENT/.test(m)), 'old settlements not replayed after restart');
  ok(msgs().some(m => /🛑 Auto 15-min trading stopped for today: 4 losses in a row/.test(m)), 'auto 15-min circuit breaker trips after 4 straight losses');
  await send('/status'); await wait(500);
  ok(/Auto 15-min: STOPPED for today/.test(last()) && /result −\$6\.00/.test(last()), '/status shows stopped + day result', last());
  const blob = JSON.parse(W.pinned.slice(W.pinned.indexOf('{')));
  ok(blob.SC.n === 1 && blob.SC.open.length === 0 && blob.manualLock === true && blob.LED.fastOff === true, 'scorecard, lock and auto stop saved to pinned');
  ok(msgs().some(m => /📈 Graded: KXBTCD-OLD-T60000 YES @ 50¢ would have WON/.test(m)), 'graded alert reported');
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
