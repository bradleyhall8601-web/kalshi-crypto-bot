// End-to-end tests for the Kalshi bot. Run: node test/run.js
process.env.BOT_TEST = '1';
const { W, start } = require('./harness');
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const failures = [];
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log('  ✅', name); } else { fail++; failures.push(name); console.log('  ❌', name, extra); } };
const msgs = () => W.tg.filter(x => x.method === 'sendMessage' && !String(x.body.text).startsWith('⚙️ BOT SETTINGS')).map(x => x.body);
const lastMsg = () => msgs().slice(-1)[0] || {};
const edits = () => W.tg.filter(x => x.method === 'editMessageText' && x.body.message_id !== W.pinnedId && !String(x.body.text).startsWith('⚙️')).map(x => x.body.text);
const alerts = () => msgs().filter(m => /TRADE IDEA/.test(m.text));
const N = x => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989422804014327 * Math.exp(-x * x / 2), p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x > 0 ? 1 - p : p; };
const rawP = (S, K, sig, mins) => { const s = sig * Math.sqrt(Math.max(mins - 2 / 3, 0.25)); return N((Math.log(S / K) - s * s / 2) / s); };
let tkSeq = 0;
// a market whose price is set relative to the model: yes mid = model - gap
function market(series, coin, mins, strike, gap, opts = {}) {
  const ev = `${series}-T${++tkSeq}`;
  const ticker = `${ev}-T${strike}`;
  const p = rawP(W[coin], strike, W.vol, mins);
  const mid = Math.min(0.97, Math.max(0.03, p - gap)), half = opts.spread ? opts.spread / 2 : 0.01;
  const m = { ticker, event_ticker: ev, close_time: new Date(Date.now() + mins * 60e3).toISOString(), floor_strike: strike, strike_type: 'greater',
    yes_ask_dollars: (mid + half).toFixed(4), yes_bid_dollars: (mid - half).toFixed(4), no_ask_dollars: (1 - mid + half).toFixed(4), exchange_index: 2, status: 'open', ...opts.m };
  W.markets[ticker] = m; return m;
}
const clearMarkets = () => { for (const k of Object.keys(W.markets)) W.markets[k].status = 'settled'; };
const send = (post, text) => post({ message: { chat: { id: 42 }, text } });
const tap = (post, data, ageSec = 5) => post({ callback_query: { id: 'q' + Math.random(), data, message: { chat: { id: 42 }, message_id: 777, date: Math.floor(Date.now() / 1000) - ageSec, text: 'alert' } } });
const btn = (a, i = 0) => a.reply_markup.inline_keyboard[0][i].callback_data;

(async () => {
  const { post, HOOK } = start({});
  await wait(800);

  console.log('\n1. Startup');
  ok(W.tg.some(x => x.method === 'setWebhook' && x.body.secret_token && x.body.drop_pending_updates), 'webhook registered with secret');
  ok(W.tg.some(x => x.method === 'setMyCommands' && x.body.commands.some(c => c.command === 'stats')), 'command menu set');
  ok(msgs().some(m => /Bot running/.test(m.text)), 'startup message sent');

  console.log('\n2. Security');
  let r = await post({ message: { chat: { id: 42 }, text: '/status' } }, {});
  ok(r.status === 403, 'webhook without secret rejected (403)');
  r = await post({}, {}, '/');
  ok(r.status === 200 && (await r.text()) === 'ok', 'public page reveals nothing');
  await post({ message: { chat: { id: 999 }, text: '/status' } }); await wait(200);
  ok(W.tg.some(x => x.method === 'sendMessage' && String(x.body.chat_id) === '999' && x.body.text === 'Private bot.'), 'stranger gets "Private bot."');
  await post({ callback_query: { id: 'z', data: 'b|X|y|500|1', message: { chat: { id: 999 }, message_id: 1, date: 0 } } }); await wait(200);
  ok(W.orders.length === 0, 'stranger cannot press Buy');

  console.log('\n3. Commands');
  await send(post, '/help'); await wait(200); ok(/\/stats/.test(lastMsg().text) && /\/set/.test(lastMsg().text), '/help lists commands');
  await send(post, '/settings'); await wait(200); ok(/edge = 0.04/.test(lastMsg().text) && /markets = KXBTCD/.test(lastMsg().text), '/settings shows values');
  await send(post, '/set trade 3'); await wait(200); ok(/trade: 2 → 3/.test(lastMsg().text), '/set trade 3 works');
  await send(post, '/set trade 99999'); await wait(200); ok(/must be between/.test(lastMsg().text), '/set rejects out-of-range');
  await send(post, '/set edge 6'); await wait(200); ok(/edge: 0.04 → 0.06/.test(lastMsg().text), '/set edge 6 means 6¢');
  await send(post, '/set edge 4'); await send(post, '/set trade 2'); await wait(200);
  await send(post, '/set nonsense 5'); await wait(200); ok(/Usage/.test(lastMsg().text), 'unknown setting explained');
  await send(post, '/set coins eth'); await wait(200); ok(/coins = ETH/.test(lastMsg().text), '/set coins eth');
  await send(post, '/set coins btc,eth'); await wait(200);
  await send(post, '/status'); await wait(300); ok(/Cash: \$7\.76/.test(lastMsg().text) && /CONFIRM/.test(lastMsg().text), '/status shows live wallet and mode');
  await send(post, '/stats'); await wait(200); ok(/no alerts settled yet/.test(lastMsg().text), '/stats with no data');
  await send(post, 'hello'); await wait(200); ok(/Claude chat in Telegram is off/.test(lastMsg().text), 'plain text explains Claude chat is off');
  await send(post, '/rollback'); await wait(200); ok(/needs GITHUB_TOKEN/.test(lastMsg().text), '/rollback explains missing token');
  await send(post, '/pause'); await wait(200);
  market('KXBTCD', 'btc', 40, 60040, 0.16); const before = alerts().length;
  await send(post, '/scan'); await wait(500); ok(alerts().length === before, 'paused bot sends no alerts');
  await send(post, '/resume'); await wait(200);
  ok(JSON.parse(W.pinned.slice(W.pinned.indexOf('{'))).paused === false, 'pause state saved in pinned settings');

  console.log('\n4. Alert: analysis, fees, wallet');
  await send(post, '/scan'); await wait(800);
  let a = alerts().slice(-1)[0];
  ok(a && /BTC \$60,040\.00 or above/.test(a.text), 'alert sent for good hourly trade');
  ok(a && /incl\. \$0\.\d\d fee/.test(a.text), 'alert shows the fee');
  ok(a && /💰 Wallet \$7\.76 → \$\d/.test(a.text), 'alert shows wallet before/after');
  ok(a && /📊 BTC 5m .* · price from 3 exchanges/.test(a.text), 'alert shows live BTC/ETH conditions');
  ok(a && Buffer.byteLength(btn(a)) <= 64, 'button data within Telegram 64-byte limit');
  const costShown = Number((a.text.match(/= \$(\d+\.\d\d)/) || [])[1]);
  ok(costShown <= 2.0, 'alert cost within $2 cap', costShown);

  console.log('\n5. No duplicates');
  const nA = alerts().length;
  await send(post, '/scan'); await wait(600); await send(post, '/scan'); await wait(600);
  ok(alerts().length === nA, 'same market window never alerted twice');

  console.log('\n6. Buy: shard transfer, order format, receipt');
  W.shards = { 0: 7.44, 2: 0.32 };
  await tap(post, btn(a)); await wait(2500);
  const order = W.orders.slice(-1)[0] || {};
  ok(W.transfers.length === 1 && W.transfers[0].source_exchange_shard === 0 && W.transfers[0].destination_exchange_shard === 2, 'moved cash from shard 0 to the market shard 2');
  ok(order.side === 'bid' && order.exchange_index === 2 && order.time_in_force === 'immediate_or_cancel', 'YES buy sent as V2 bid on correct shard');
  ok(/✅ BOUGHT \d+\/\d+ @ [\d.]+¢ for \$\d\.\d\d \(fees \$0\.\d\d\)/.test(edits().slice(-1)[0] || ''), 'receipt shows price, total and fees', edits().slice(-1)[0]);
  const worst = Number(order.count) * Number(order.price) + Math.ceil(0.07 * Number(order.count) * Number(order.price) * (1 - Number(order.price)) * 100) / 100;
  ok(worst <= 2.001, 'worst-case cost incl. fees ≤ $2 cap', worst);

  console.log('\n7. Spending counts fees and NO buys (daily limit)');
  await send(post, '/status'); await wait(400);
  const spentTxt = (lastMsg().text.match(/Today: \$(\d+\.\d\d)/) || [])[1];
  const fillCost = W.fills.reduce((s, f) => s + Number(f.count_fp) * Number(f.yes_price_dollars) + Number(f.fee_cost), 0);
  ok(Math.abs(Number(spentTxt) - fillCost) < 0.015, 'today\'s spend includes fees', `${spentTxt} vs ${fillCost.toFixed(2)}`);
  // a NO buy
  const mNo = market('KXETHD', 'eth', 40, 1679.5, -0.16); // market overprices YES → NO is the good side
  await send(post, '/scan'); await wait(800);
  const aNo = alerts().slice(-1)[0];
  ok(aNo && /BUY NO/.test(aNo.text), 'NO-side alert generated');
  await tap(post, btn(aNo)); await wait(2000);
  const oNo = W.orders.slice(-1)[0];
  ok(oNo && oNo.side === 'ask' && Number(oNo.price) >= 1 - (Number(mNo.no_ask_dollars) + 0.0101) && Number(oNo.price) <= 1 - Number(mNo.no_ask_dollars) + 1e-9, 'NO buy sent as ask at 1 − limit (limit ≤ live NO ask + 1¢)', oNo && oNo.price);
  W.fills = W.fills.map(f => ({ ...f, fee_cost: undefined })); // even if Kalshi omitted fees, ledger keeps the true spend
  await send(post, '/status'); await wait(400);
  const spent2 = Number((lastMsg().text.match(/Today: \$(\d+\.\d\d)/) || [])[1]);
  ok(spent2 >= fillCost + 1.0, 'NO buy counted toward today\'s spend', spent2);

  console.log('\n8. Wallet and daily-limit protection at Buy');
  const mW = market('KXBTCD', 'btc', 40, 60045, 0.16);
  W.shards = { 0: 0.10, 2: 0.10 }; // $0.20: less than one contract + fee
  await send(post, '/scan'); await wait(800);
  ok(!alerts().some(x => x.text.includes('60,045')), 'no alert when wallet cannot afford 1 contract');
  ok(msgs().some(m => /Wallet is low/.test(m.text)), 'low-wallet warning sent once');
  W.shards = { 0: 7.0, 2: 0.0 };
  await tap(post, `b|${mW.ticker}|y|${Math.round(Number(mW.yes_ask_dollars) * 1000)}|5`); await wait(2000);
  // daily limit: force spend near cap via settings
  await send(post, '/set day 1'); await wait(200);
  const mD = market('KXBTCD', 'btc', 40, 60042, 0.16);
  await tap(post, `b|${mD.ticker}|y|${Math.round(Number(mD.yes_ask_dollars) * 1000)}|5`); await wait(1500);
  ok(/Daily limit reached/.test(edits().slice(-1)[0] || ''), 'Buy blocked at daily limit');
  await send(post, '/set day 15'); await wait(200);
  W.shards = { 0: 0.05, 2: 0.05 };
  const mC = market('KXBTCD', 'btc', 40, 60043, 0.16);
  await tap(post, `b|${mC.ticker}|y|${Math.round(Number(mC.yes_ask_dollars) * 1000)}|5`); await wait(1500);
  ok(/Not enough cash/.test(edits().slice(-1)[0] || ''), 'Buy blocked when wallet too small', edits().slice(-1)[0]);
  W.shards = { 0: 7.0, 2: 0.0 };

  console.log('\n9. Buy-time live re-checks');
  const mP = market('KXBTCD', 'btc', 40, 60044, 0.16);
  const pTap = `b|${mP.ticker}|y|${Math.round(Number(mP.yes_ask_dollars) * 1000)}|3`;
  mP.yes_ask_dollars = (Number(mP.yes_ask_dollars) + 0.05).toFixed(4);
  await tap(post, pTap); await wait(1200); ok(/Price moved to .* no edge left/.test(edits().slice(-1)[0] || ''), 'price jump that kills the edge blocks Buy', edits().slice(-1)[0]);
  mP.yes_ask_dollars = (Number(mP.yes_ask_dollars) - 0.05).toFixed(4);
  await tap(post, pTap, 300); await wait(800); ok(/Too late/.test(edits().slice(-1)[0] || ''), 'expired alert blocks Buy');
  W.shock = { coin: 'eth', pct: 0.02 };
  await tap(post, pTap); await wait(1500); ok(/Live re-check failed: .*ETH sudden spike/.test(edits().slice(-1)[0] || ''), 'ETH shock blocks a BTC Buy', edits().slice(-1)[0]);
  W.shock = null;
  W.stale.coinbase = true; W.stale.bitstamp = true;
  W.down.kraken = true;
  await tap(post, pTap); await wait(1500); ok(/Live re-check failed/.test(edits().slice(-1)[0] || ''), 'stale/missing prices block Buy', edits().slice(-1)[0]);
  W.stale = {}; W.down = {};
  await tap(post, `x|${mP.ticker}`); await wait(500); ok(/Skipped/.test(edits().slice(-1)[0] || ''), 'Skip button works');
  W.orderFill = 'none';
  const mF = market('KXBTCD', 'btc', 40, 60046, 0.16);
  await tap(post, `b|${mF.ticker}|y|${Math.round(Number(mF.yes_ask_dollars) * 1000)}|2`); await wait(2000);
  ok(/Not filled .* No money spent/.test(edits().slice(-1)[0] || ''), 'unfilled order reported clearly');
  W.orderFill = 'full';
  W.transferFails = true; W.shards = { 0: 7.0, 2: 0 };
  const mT = market('KXBTCD', 'btc', 40, 60047, 0.16);
  await tap(post, `b|${mT.ticker}|y|${Math.round(Number(mT.yes_ask_dollars) * 1000)}|2`); await wait(2000);
  ok(/Order failed: .*write::transfer/.test(edits().slice(-1)[0] || ''), 'transfer failure shown on the alert', edits().slice(-1)[0]);
  W.transferFails = false;

  const mG = market('KXBTCD', 'btc', 40, 60048, 0.17); // bigger edge
  const gTap = `b|${mG.ticker}|y|${Math.round(Number(mG.yes_ask_dollars) * 1000)}|3`;
  mG.yes_ask_dollars = (Number(mG.yes_ask_dollars) + 0.02).toFixed(4);
  const oc = W.orders.length; W.shards = { 0: 7, 2: 0 };
  await tap(post, gTap); await wait(2500);
  ok(W.orders.length === oc + 1 && /✅ BOUGHT/.test(edits().slice(-1)[0] || ''), 'small move that keeps the edge still buys at the live price', edits().slice(-1)[0]);
  const lim = Number(W.orders.slice(-1)[0].price);
  ok(lim <= Number(mG.yes_ask_dollars) + 0.0101, 'limit never more than 1¢ above live ask', lim);

  console.log('\n10. Market-condition blocks at scan');
  clearMarkets();
  const cases = [
    ['sudden BTC drop', () => { W.shock = { coin: 'btc', pct: -0.02 }; }],
    ['exchanges disagree', () => { W.krakenSkew = 1.01; }],
    ['only one exchange', () => { W.down.kraken = true; W.down.bitstamp = true; }],
    ['model vs market gap > 18 pts', () => {}, 0.25],
    ['thin market', () => {}, 0.16, { spread: 0.10 }],
    ['long shot under 15¢', () => {}, 0.16, { m: { yes_ask_dollars: '0.0800', yes_bid_dollars: '0.0600', no_ask_dollars: '0.9400' } }],
  ];
  for (const [name, setup, gap = 0.16, opts = {}] of cases) {
    setup(); const n0 = alerts().length;
    market('KXBTCD', 'btc', 40, 60030 + Math.floor(Math.random() * 20), gap, opts);
    await send(post, '/scan'); await wait(700);
    ok(alerts().length === n0, `blocked: ${name}`);
    W.shock = null; W.krakenSkew = 1; W.down = {}; clearMarkets();
  }

  console.log('\n11. Auto 15-minute trading');
  W.shards = { 0: 7, 2: 0 };
  const m15 = market('KXBTC15M', 'btc', 9, 59980, -0.17, { m: { strike_type: 'greater_or_equal' } });
  let o0 = W.orders.length;
  await send(post, '/scan'); await wait(2500);
  ok(W.orders.length === o0 + 1 && msgs().some(m => /AUTO 15-MIN BOUGHT \d+\/\d+ NO @ [\d.]+¢ for \$\d\.\d\d \(fees \$0\.\d\d\)/.test(m.text)), 'auto buys a 15-min market with no tap, receipt in Telegram');
  ok(!alerts().some(x => x.text.includes('59,980')), 'no tap alert for an auto-traded 15-min market');
  ok(msgs().some(m => /🔁 Moved \$\d\.\d\d .* shard 0 to shard 2/.test(m.text)), 'cash move between shards reported');
  const o15 = W.orders.slice(-1)[0];
  ok(Number(o15.count) * (1 - Number(o15.price)) + 0.02 <= 2.01, 'auto 15-min trade within $2 cap incl. fees');
  await send(post, '/scan'); await wait(800); await send(post, '/scan'); await wait(800);
  ok(W.orders.length === o0 + 1, 'one auto trade per 15-min window');
  W.orderFill = 'none';
  market('KXETH15M', 'eth', 8, 1679.8, -0.17, { m: { strike_type: 'greater_or_equal' } });
  o0 = W.orders.length;
  await send(post, '/scan'); await wait(1500); await send(post, '/scan'); await wait(1500);
  ok(W.orders.length === o0 + 2, 'unfilled auto order retried while the window is open');
  ok(msgs().filter(m => /AUTO order not filled/.test(m.text)).length === 1, '"not filled" reported once, not spammed');
  W.orderFill = 'full'; clearMarkets();
  await send(post, '/set fastday 0'); await wait(200);
  market('KXBTC15M', 'btc', 9, 59985, -0.17, { m: { strike_type: 'greater_or_equal' } }); o0 = W.orders.length;
  await send(post, '/scan'); await wait(1500);
  ok(W.orders.length === o0, 'auto 15-min stops at its daily budget');
  await send(post, '/set fastday 10'); await wait(200); clearMarkets();
  await send(post, '/status'); await wait(400);
  ok(/Auto 15-min: ON · today \$\d\.\d\d\/\$10\.00/.test(lastMsg().text), '/status shows auto 15-min state and spend', lastMsg().text);
  await send(post, '/auto15 off'); await wait(200); ok(/Auto 15-min trading OFF/.test(lastMsg().text), '/auto15 off');
  market('KXBTC15M', 'btc', 9, 59990, -0.17, { m: { strike_type: 'greater_or_equal' } }); o0 = W.orders.length;
  await send(post, '/scan'); await wait(1200);
  const a15 = alerts().slice(-1)[0];
  ok(W.orders.length === o0 && a15 && /UP from \$59,990\.00 \(15-min\)/.test(a15.text) && /tap within 90 sec/.test(a15.text), 'with auto off, 15-min comes as a 90-second tap alert');
  await tap(post, btn(a15), 120); await wait(800); ok(/Too late/.test(edits().slice(-1)[0] || ''), '15-min tap alert expires after 90s');
  await send(post, '/auto15 on'); await wait(200); ok(/Auto 15-min trading ON/.test(lastMsg().text), '/auto15 on');
  clearMarkets();

  console.log('\n11c. 15-min scanning never waits for the hourly scan');
  clearMarkets(); W.shards = { 0: 7, 2: 0 };
  W.delay = { KXBTCD: 4000, KXETHD: 4000 };       // hourly market fetch is slow
  market('KXBTC15M', 'btc', 9, 59975, -0.17, { m: { strike_type: 'greater_or_equal' } });
  let of0 = W.orders.length;
  send(post, '/scan');                              // slow scan starts (takes 8s+)
  await wait(500);
  const tFast = Date.now(); await send(post, '/_fasttick'); await wait(1500);
  ok(W.orders.length === of0 + 1 && Date.now() - tFast < 4000, '15-min trade placed while the hourly scan was still running');
  W.delay = {}; await wait(8000); clearMarkets();

  console.log('\n11d. /why live diagnostics');
  market('KXBTC15M', 'btc', 9, 59972, 0.03, { m: { strike_type: 'greater_or_equal' } });   // small edge: should explain
  await send(post, '/_fasttick'); await wait(1200);
  await send(post, '/why'); await wait(400);
  ok(/15-min scans in last 5 min/.test(lastMsg().text) && /BTC .* · \d+\.\d min left/.test(lastMsg().text) && /Not trading: edge/.test(lastMsg().text), '/why explains the live 15-min verdict', lastMsg().text);
  clearMarkets();

  console.log('\n11a. Normal moves do not pause trading');
  W.shock = { coin: 'eth', pct: 0.004 }; // 0.4% in 5 min: normal crypto noise
  const mq = market('KXBTCD', 'btc', 40, 60036, 0.16); const nq = alerts().length, mq0 = msgs().length;
  await send(post, '/scan'); await wait(900);
  ok(!msgs().slice(mq0).some(m => /trading paused/.test(m.text)) && alerts().length === nq + 1, '0.4% ETH move does not pause trading');
  W.shock = null; clearMarkets();

  console.log('\n11b. Condition reports');
  W.shock = { coin: 'btc', pct: -0.02 };
  market('KXBTCD', 'btc', 40, 60033, 0.16);
  await send(post, '/scan'); await wait(900);
  ok(msgs().some(m => /🚧 BTC trading paused — sudden drop/.test(m.text)), 'blocked conditions reported');
  ok(!msgs().some(m => /BTC ETH|ETH BTC/.test(m.text)), 'no garbled cross-coin text');
  await send(post, '/scan'); await wait(900);
  ok(msgs().filter(m => /🚧 BTC trading paused/.test(m.text)).length === 1, 'block reported once, not every scan');
  W.shock = null;
  await send(post, '/scan'); await wait(900);
  ok(msgs().some(m => /✅ BTC conditions clear again/.test(m.text)), 'all-clear reported');
  clearMarkets();

  console.log('\n12. Scorecard');
  const mS = market('KXETHD', 'eth', 30, 1678, 0.16);
  await send(post, '/scan'); await wait(800);
  const blob = () => JSON.parse(W.pinned.slice(W.pinned.indexOf('{')));
  ok(blob().SC.open.some(o => o.t === mS.ticker), 'alert recorded in scorecard (saved in pinned)');
  ok(blob().SC.ev[mS.event_ticker], 'alerted window saved (no dups after restart)');
  mS.close_time = new Date(Date.now() - 10 * 60e3).toISOString(); mS.result = 'yes';
  const o = blob().SC.open.find(x => x.t === mS.ticker); o.c = Date.now() - 10 * 60e3;
  W.pinned = '⚙️ BOT SETTINGS (do not unpin)\n' + JSON.stringify({ ...blob(), SC: { ...blob().SC, open: blob().SC.open.map(x => x.t === mS.ticker ? o : x) } });
  console.log('   (restart to load edited scorecard)');

  console.log('\n13. 429 retry');
  W.fail429 = 2; await send(post, '/status'); await wait(4000);
  ok(/Cash:/.test(lastMsg().text), 'rate-limited Kalshi calls retried and succeed');

  console.log('\n14. Auto mode');
  W.settlements = [{ revenue: 20000, yes_total_cost: 5000, no_total_cost: 0, fee_cost: '0.5000' }]; // +$149.50 profit (fee_cost given as dollar text)
  clearMarkets(); W.shards = { 0: 50, 2: 0 };
  const mA = market('KXBTCD', 'btc', 40, 60041, 0.16);
  const ordersBefore = W.orders.length;
  await wait(21000); // account history refreshes every 20s
  await send(post, '/scan'); await wait(2500);
  ok(msgs().some(m => /Profit hit \$149\.50/.test(m.text)), 'auto-trading unlocks at +$100 (fees parsed as dollars)');
  ok(W.orders.length === ordersBefore + 1 && msgs().some(m => /🤖 AUTO BOUGHT/.test(m.text)), 'auto mode places the trade itself');
  W.markets[mA.ticker].status = 'settled';
  market('KXETHD', 'eth', 40, 1677, 0.16); W.transferFails = true; W.shards = { 0: 50, 2: 0 };
  await send(post, '/scan'); await wait(2500);
  ok(msgs().some(m => /AUTO order failed/.test(m.text)), 'auto failure reported, scan keeps going');
  W.transferFails = false;
  await send(post, '/lock'); await wait(300); ok(/Confirm mode locked/.test(lastMsg().text), '/lock returns to confirm mode');

  ok((W.settingsSends || 0) <= 1, 'settings message posted at most once (no duplicate pins)', W.settingsSends);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) console.log('FAILED:', failures.join(' | '));
  require('fs').writeFileSync('/tmp/kbot_pinned.txt', W.pinned);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
