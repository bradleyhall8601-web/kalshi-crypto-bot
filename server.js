// Kalshi crypto prediction bot — standalone (no dependencies). Node 18+.
// Env: KALSHI_KEY_ID, KALSHI_PRIVATE_KEY, TELEGRAM_BOT_TOKEN, [TELEGRAM_CHAT_ID], [BOT_START_TS], [KALSHI_ENV=demo]
const http = require('http');
const crypto = require('crypto');

const env = process.env;
const KEY_ID = env.KALSHI_KEY_ID || '';
// accept the key pasted any way (spaces, \\n, one line) and rebuild a clean PEM
const PEM = (() => { const raw = String(env.KALSHI_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const m = raw.match(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----/);
  if (!m) return raw; const body = m[2].replace(/\s+/g, '');
  return `-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${m[1]}-----\n`; })();
let SIGN_KEY = null; try { if (PEM.includes('PRIVATE KEY')) SIGN_KEY = crypto.createPrivateKey(PEM); } catch (e) { console.log('KALSHI KEY INVALID:', e.message); }
const TG_TOKEN = env.TELEGRAM_BOT_TOKEN || '';
let OWNER = env.TELEGRAM_CHAT_ID || '';
const OWNER_CODE = env.OWNER_CODE || ''; // must be sent as '/start CODE' to claim the bot
const START_TS = Number(env.BOT_START_TS || Math.floor(Date.now() / 1000)); // profit counted from here
const PUBLIC_URL = env.RENDER_EXTERNAL_URL || env.PUBLIC_URL || '';
const BASE = env.KALSHI_ENV === 'demo' ? 'https://demo-api.kalshi.co' : 'https://api.elections.kalshi.com';
const PREFIX = '/trade-api/v2';

const CFG = {
  SERIES: (env.BOT_SERIES || 'KXBTCD,KXETHD,KXBTC15M,KXETH15M').split(',').map(s => s.trim()).filter(Boolean),
  SPOT: { KXBTCD: 'BTC-USD', KXBTC: 'BTC-USD', KXBTC15M: 'BTC-USD', KXETHD: 'ETH-USD', KXETH: 'ETH-USD', KXETH15M: 'ETH-USD', KXSOLD: 'SOL-USD', KXSOL15M: 'SOL-USD' },
  FAST_MIN_MINUTES: 2, FAST_MAX_MINUTES: 15, // 15-minute markets: trade while 2-15 min remain
  MIN_EDGE: Number(env.BOT_MIN_EDGE || 0.04), MAX_EDGE: 0.25, MAX_DISAGREE: 0.18,
  FAST_TTL_MIN: 1.5, // 15-min markets move in seconds: alerts expire fast
  AUTO_FAST: 1,       // auto-trade the 15-minute markets (no tap needed)
  AUTO_EDGE: 0.05,    // auto trades need a slightly bigger edge than tap alerts (no human double-check)
  FAST_DAY: 10,       // max $ per day on auto 15-min trades (inside the overall daily limit)
  FAST_MAX_LOSS: 6,   // stop auto 15-min trading for the day after losing this much
  FAST_STREAK: 4,     // ...or after this many losses in a row
  MIN_PRICE: 0.15, MAX_PRICE: 0.85,
  MIN_MINUTES: 8, MAX_MINUTES: 70,
  VOL_MULT: Number(env.BOT_VOL_MULT || 1.0), // honest volatility; inflating it makes long shots look cheap
  MODEL_WEIGHT: 0.5, // blend: 50% our model, 50% the market's own price (guards against model overconfidence)
  UNLOCK_PROFIT: 100, RELOCK_PROFIT: 50,
  SMALL_TRADE: 2, SMALL_DAY: 15, SCALED_TRADE_PCT: 0.02, SCALED_DAY_PCT: 0.10,
  MAX_ALERTS_PER_RUN: 2, ALERT_TTL_MIN: 4, MAX_SLIPPAGE: 0.02,
  SCAN_EVERY_MIN: 1, TZ: 'America/Chicago',
};

// ---------- live settings (changeable from Telegram, saved in a pinned message) ----------
const SETTINGS = {
  edge:     { key: 'MIN_EDGE', desc: 'min edge per contract in $ (0.06 = 6¢)', min: 0.01, max: 0.5 },
  trade:    { key: 'SMALL_TRADE', desc: 'max $ per trade (confirm mode)', min: 1, max: 1000 },
  day:      { key: 'SMALL_DAY', desc: 'max $ per day (confirm mode)', min: 1, max: 10000 },
  unlock:   { key: 'UNLOCK_PROFIT', desc: '$ profit before auto-trading', min: 0, max: 100000 },
  relock:   { key: 'RELOCK_PROFIT', desc: 'drop back to confirm below this $ profit', min: -100000, max: 100000 },
  autotrade:{ key: 'SCALED_TRADE_PCT', desc: 'auto mode: % of balance per trade (0.02 = 2%)', min: 0.001, max: 0.5 },
  autoday:  { key: 'SCALED_DAY_PCT', desc: 'auto mode: % of balance per day', min: 0.01, max: 1 },
  minprice: { key: 'MIN_PRICE', desc: 'skip contracts cheaper than this', min: 0.01, max: 0.99 },
  maxprice: { key: 'MAX_PRICE', desc: 'skip contracts pricier than this', min: 0.01, max: 0.99 },
  minmins:  { key: 'MIN_MINUTES', desc: 'only markets closing in at least N min', min: 1, max: 1440 },
  maxmins:  { key: 'MAX_MINUTES', desc: 'only markets closing within N min', min: 5, max: 1440 },
  trust:    { key: 'MODEL_WEIGHT', desc: 'how much to trust the model vs market price (0.5 = half/half)', min: 0.1, max: 1 },
  vol:      { key: 'VOL_MULT', desc: 'volatility multiplier (higher = more cautious)', min: 0.5, max: 3 },
  alerts:   { key: 'MAX_ALERTS_PER_RUN', desc: 'max alerts per scan', min: 1, max: 10 },
  every:    { key: 'SCAN_EVERY_MIN', desc: 'scan every N minutes', min: 1, max: 60 },
  ttl:      { key: 'ALERT_TTL_MIN', desc: 'minutes to tap Buy before alert expires', min: 1, max: 30 },
  auto15:   { key: 'AUTO_FAST', desc: 'auto-trade 15-min markets (1 = on, 0 = off)', min: 0, max: 1 },
  autoedge: { key: 'AUTO_EDGE', desc: 'min edge for auto 15-min trades (0.05 = 5¢)', min: 0.02, max: 0.5 },
  fastday:  { key: 'FAST_DAY', desc: 'max $ per day on auto 15-min trades', min: 0, max: 10000 },
  fastloss: { key: 'FAST_MAX_LOSS', desc: 'stop auto 15-min for the day after losing $ this much', min: 1, max: 10000 },
};
const COIN_SERIES = { BTC: ['KXBTCD', 'KXBTC15M'], ETH: ['KXETHD', 'KXETH15M'], SOL: ['KXSOLD', 'KXSOL15M'] };
const isFast = s => /15M$/.test(s);
const ttlFor = ticker => isFast(String(ticker).split('-')[0]) ? CFG.FAST_TTL_MIN : CFG.ALERT_TTL_MIN;
let pinnedId = null;
function settingsText() { return Object.entries(SETTINGS).map(([n, x]) => `${n} = ${CFG[x.key]}`).join('\n') + `\nmarkets = ${CFG.SERIES.join(', ')}`; }
let saveChain = Promise.resolve();
function saveSettings() { saveChain = saveChain.then(saveSettingsNow, saveSettingsNow); return saveChain; }
async function saveSettingsNow() {
  if (!OWNER) return;
  const blob = {}; for (const x of Object.values(SETTINGS)) blob[x.key] = CFG[x.key]; blob.SERIES = CFG.SERIES; blob.manualLock = S.manualLock; blob.paused = S.paused; blob.v = 5; blob.SC = S.sc; blob.LED = S.led; blob.SETL = S.setlTs;
  let text = '⚙️ BOT SETTINGS (do not unpin)\n' + JSON.stringify(blob);
  if (text.length > 4000) { S.sc.open = S.sc.open.slice(-8); blob.SC = S.sc; text = '⚙️ BOT SETTINGS (do not unpin)\n' + JSON.stringify(blob); }
  if (pinnedId) { const r = await tg('editMessageText', { chat_id: OWNER, message_id: pinnedId, text }); if (r.ok || /not modified/.test(r.error || '')) return; }
  const r = await tg('sendMessage', { chat_id: OWNER, text, disable_notification: true });
  if (r.ok) { pinnedId = r.result.message_id; await tg('pinChatMessage', { chat_id: OWNER, message_id: pinnedId, disable_notification: true }); }
}
async function loadSettings() {
  if (!OWNER) return;
  const r = await tg('getChat', { chat_id: OWNER });
  const pm = r.ok && r.result.pinned_message;
  if (!pm || !String(pm.text || '').startsWith('⚙️ BOT SETTINGS')) return;
  try {
    const blob = JSON.parse(pm.text.slice(pm.text.indexOf('{')));
    for (const x of Object.values(SETTINGS)) if (typeof blob[x.key] === 'number') CFG[x.key] = blob[x.key];
    if (Array.isArray(blob.SERIES) && blob.SERIES.length) CFG.SERIES = blob.SERIES;
    if (!(blob.v >= 5)) { CFG.AUTO_FAST = 1; setTimeout(saveSettings, 2000); } // switch on auto 15-min once
    if (!(blob.v >= 4)) { CFG.VOL_MULT = 1.0; CFG.MIN_EDGE = 0.04; CFG.MIN_PRICE = Math.max(CFG.MIN_PRICE, 0.15); if (typeof blob.MODEL_WEIGHT !== 'number') CFG.MODEL_WEIGHT = 0.5; setTimeout(saveSettings, 2000); }
    if (!(blob.v >= 3)) { CFG.SCAN_EVERY_MIN = 1; setTimeout(saveSettings, 2000); }
    if (!(blob.v >= 2)) { for (const x of ['KXBTC15M', 'KXETH15M']) if (!CFG.SERIES.includes(x)) CFG.SERIES.push(x); setTimeout(saveSettings, 2000); } // add 15-min markets once
    if (blob.SC && typeof blob.SC === 'object') S.sc = { ...S.sc, ...blob.SC, ev: blob.SC.ev || {} };
    if (blob.SETL > 0) S.setlTs = blob.SETL;
    if (blob.LED && typeof blob.LED.spent === 'number') S.led = { ...newLed(blob.LED.day), ...blob.LED };
    S.manualLock = !!blob.manualLock; S.paused = !!blob.paused; pinnedId = pm.message_id;
    log('settings loaded', JSON.stringify(blob));
  } catch (e) { log('settings parse error', e.message); }
}
let scanTimer = null;
function schedule() { if (scanTimer) clearInterval(scanTimer); if (env.BOT_TEST !== '1') scanTimer = setInterval(tick, CFG.SCAN_EVERY_MIN * 60e3); }

const newLed = day => ({ day, spent: 0, fast: 0, autoPnl: 0, streak: 0, fastOff: false, auto: [] });
const S = { candles: {}, led: newLed(''), sc: { n: 0, wins: 0, sumP: 0, brier: 0, pnl: 0, open: [], ev: {} }, seen: {}, busy: false, pending: {}, recentAlerts: {}, paused: false, manualLock: false, unlocked: false, lastScan: null, lastError: null };
const log = (...a) => console.log(new Date().toISOString(), ...a);
process.on('uncaughtException', e => log('uncaught', e.stack || e.message));
process.on('unhandledRejection', e => log('unhandled', (e && e.stack) || e));

// ---------- helpers ----------
async function req(url, { method = 'GET', headers = {}, body } = {}) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${url.split('?')[0].replace(/\/bot[^/]+/, '/bot***')} -> ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}
async function kalshi(method, path, body, tries = 0) {
  try { return await kalshiOnce(method, path, body); }
  catch (e) { if (/-> 429/.test(e.message) && tries < 4) { await new Promise(r => setTimeout(r, 1000 * (tries + 1))); return kalshi(method, path, body, tries + 1); } throw e; }
}
async function kalshiOnce(method, path, body) {
  const ts = Date.now().toString();
  const msg = Buffer.from(ts + method + PREFIX + path.split('?')[0]);
  const sig = (SIGN_KEY.asymmetricKeyType === 'ed25519'
    ? crypto.sign(null, msg, SIGN_KEY) // Ed25519 keys sign the message directly
    : crypto.sign('sha256', msg, { key: SIGN_KEY, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST })
  ).toString('base64');
  return req(BASE + PREFIX + path, { method, body, headers: { 'KALSHI-ACCESS-KEY': KEY_ID, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': sig } });
}
async function tg(method, payload) {
  try { return await req(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, { method: 'POST', body: payload }); }
  catch (e) { if (!/not modified/.test(e.message)) log('telegram error', e.message); return { ok: false, error: e.message }; }
}
const say = (text, extra = {}) => OWNER ? tg('sendMessage', { chat_id: OWNER, text, ...extra }) : null;
const num = v => (v === undefined || v === null || v === '') ? NaN : Number(v);
const d = (o, k) => {
  const a = num(o[k + '_dollars']); if (a === a) return a;
  const f = num(o[k + '_fixed']); if (f === f) return f;
  const v = o[k]; const b = num(v); if (!(b === b)) return NaN;
  return typeof v === 'string' && v.includes('.') ? b : b / 100; // "0.0068" = dollars, 68 = cents
};
const cnt = (o, k = 'count') => { const a = num(o[k + '_fp']); return a === a ? a : (num(o[k]) || 0); };
const feeTotal = (c, p) => Math.ceil(0.07 * c * p * (1 - p) * 100 - 1e-9) / 100;
const money = x => '$' + Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cents = x => { const v = Math.round(x * 1000) / 10; return (Number.isInteger(v) ? v : v.toFixed(1)) + '¢'; };
const timeCT = iso => new Intl.DateTimeFormat('en-US', { timeZone: CFG.TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) + ' CT';
function startOfTodayCT() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: CFG.TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const elapsed = (+p.hour * 3600 + +p.minute * 60 + +p.second) * 1000;
  return Math.floor((Date.now() - elapsed) / 1000);
}
async function pageAll(path, key) {
  let out = [], cursor = '';
  do {
    const r = await kalshi('GET', path + (path.includes('?') ? '&' : '?') + 'limit=1000' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    out = out.concat(r[key] || []); cursor = r.cursor || '';
  } while (cursor && out.length < 20000);
  return out;
}

// ---------- account (everything rebuilt from Kalshi, so restarts lose nothing) ----------
let acctCache = null;
async function account(fresh = false) {
  // history (settlements, fills, positions) is cached briefly; the wallet balance is ALWAYS fetched fresh
  if (!fresh && acctCache && Date.now() - acctCache.t < 20000) {
    const b = await kalshi('GET', '/portfolio/balance');
    const shards = {}; for (const x of b.balance_breakdown || []) shards[x.exchange_index] = Number(x.balance) || 0;
    return { ...acctCache.v, cash: d(b, 'balance'), shards };
  }
  const v = await accountRaw(); acctCache = { t: Date.now(), v }; return v;
}
async function accountRaw() {
  const b = await kalshi('GET', '/portfolio/balance');
  const cash = d(b, 'balance');
  // realized profit = settled payouts minus what those positions cost, since START_TS
  const settles = await pageAll(`/portfolio/settlements?min_ts=${START_TS}`, 'settlements');
  let profit = 0;
  const pnlOf = s => d(s, 'revenue') - (d(s, 'yes_total_cost') || 0) - (d(s, 'no_total_cost') || 0) - (d(s, 'fee_cost') || 0);
  for (const s of settles) profit += pnlOf(s);
  // report every newly settled trade
  const stime = s => Date.parse(s.settled_time || s.created_time || 0) || 0;
  if (!(S.setlTs > 0)) S.setlTs = Math.max(Date.now(), ...settles.map(stime)); // first boot: don't replay history
  const fresh = settles.filter(x => stime(x) > S.setlTs).sort((x, y) => stime(x) - stime(y));
  for (const x of fresh) {
    const pl = pnlOf(x), res = String(x.market_result || x.result || '').toUpperCase();
    await say(`${pl >= 0 ? '✅ WON' : '❌ LOST'} ${pl >= 0 ? '+' : '−'}${money(Math.abs(pl))} · ${x.ticker || x.market_ticker}${res ? ` settled ${res}` : ''}\nPaid out ${money(d(x, 'revenue') || 0)} · Profit since start ${money(profit)}`);
  }
  if (fresh.length) { S.setlTs = stime(fresh[fresh.length - 1]); saveSettings().catch(() => {}); }
  // today's spend = buys filled since midnight CT
  const fills = await pageAll(`/portfolio/fills?min_ts=${startOfTodayCT()}`, 'fills');
  if (fills.length && !S.loggedFill) { S.loggedFill = 1; log('FILLSAMPLE', JSON.stringify(fills[0])); }
  let fillSpent = 0;
  for (const f of fills) {
    // a NO buy can show up as a YES sell in Kalshi's new single-leg format; count both as money spent
    const isBuy = (f.action || 'buy') === 'buy' || (f.action === 'sell' && f.side === 'yes' && f.is_opening !== false && f.purpose !== 'close');
    if (!isBuy) continue;
    const buyNo = f.side === 'no' || f.action === 'sell';
    const px = buyNo ? (d(f, 'no_price') === d(f, 'no_price') ? d(f, 'no_price') : 1 - d(f, 'yes_price')) : d(f, 'yes_price');
    const fee = d(f, 'fee_cost');
    if (px === px) fillSpent += cnt(f) * px + (fee === fee ? fee : feeTotal(cnt(f), px));
  }
  const today = String(startOfTodayCT());
  if (S.led.day !== today) S.led = { ...newLed(today), auto: S.led.auto || [] };
  const spent = Math.max(fillSpent, S.led.spent); // never under-count
  // events we already hold
  const pos = await kalshi('GET', '/portfolio/positions?count_filter=position&limit=1000');
  const held = new Set((pos.market_positions || []).filter(p => cnt(p, 'position') !== 0).map(p => p.ticker.split('-').slice(0, -1).join('-')));

  if (!S.unlocked && !S.manualLock && profit >= CFG.UNLOCK_PROFIT) { S.unlocked = true; await say(`🔓 Profit hit ${money(profit)}. Auto-trading ON (${CFG.SCALED_TRADE_PCT*100}% of balance per trade, ${CFG.SCALED_DAY_PCT*100}% per day). /lock to stop.`); }
  else if (S.unlocked && profit < CFG.RELOCK_PROFIT) { S.unlocked = false; await say(`🔒 Profit fell to ${money(profit)}. Back to confirm mode (${money(CFG.SMALL_TRADE)}/trade, ${money(CFG.SMALL_DAY)}/day).`); }
  const tradeCap = S.unlocked ? Math.max(CFG.SMALL_TRADE, cash * CFG.SCALED_TRADE_PCT) : CFG.SMALL_TRADE;
  const dayCap = S.unlocked ? Math.max(CFG.SMALL_DAY, cash * CFG.SCALED_DAY_PCT) : CFG.SMALL_DAY;
  // per-shard cash so we know what's really spendable
  const shards = {}; for (const x of b.balance_breakdown || []) shards[x.exchange_index] = Number(x.balance) || 0;
  return { cash, shards, profit, spent, held, tradeCap, dayCap, settledCount: settles.length };
}

// Kalshi splits cash across exchange shards. Bots must fund the market's shard before ordering.
async function ensureShardFunds(idx, needed) {
  const shardCash = b => { const r = {}; for (const x of b.balance_breakdown || []) r[x.exchange_index] = Number(x.balance) || 0; return r; };
  let cash = shardCash(await kalshi('GET', '/portfolio/balance'));
  if ((cash[idx] || 0) >= needed) return;
  const short = Math.round((needed - (cash[idx] || 0) + 0.10) * 100) / 100;
  const [src, srcCash] = Object.entries(cash).filter(([k]) => Number(k) !== idx).sort((a, b) => b[1] - a[1])[0] || [];
  if (src === undefined || srcCash < short) throw new Error(`Not enough cash: need ${money(needed)} on shard ${idx}, total available is ${money(Object.values(cash).reduce((a, b) => a + b, 0))}`);
  await kalshi('POST', '/portfolio/intra_exchange_instance_transfer', {
    source: 'event_contract', destination: 'event_contract', amount: Math.ceil(short * 10000), // centicents
    source_exchange_shard: Number(src), destination_exchange_shard: idx, client_transfer_id: crypto.randomUUID(),
  });
  log('TRANSFER', money(short), 'shard', src, '->', idx);
  say(`🔁 Moved ${money(short)} of your Kalshi cash from shard ${src} to shard ${idx} to fund this trade (still your money).`);
  for (let i = 0; i < 12; i++) { // transfer is async; wait until it lands
    await new Promise(r => setTimeout(r, 500));
    cash = shardCash(await kalshi('GET', '/portfolio/balance'));
    if ((cash[idx] || 0) >= needed) return;
  }
  throw new Error('Transfer between Kalshi shards did not arrive in time — try again');
}

// Kalshi V2 orders: one YES leg. Buy YES = bid at p. Buy NO at p = ask (sell YES) at 1-p.
// highest price worth paying: up to 1¢ above the ask, but only while the edge after fees stays >= need
function bestLimit(p, ask, need) {
  const feePer = q => 0.07 * q * (1 - q) + 0.005;
  let limit = Math.min(0.99, Math.round((ask + 0.01) * 1000) / 1000);
  while (limit > ask && limit + feePer(limit) > p - need) limit = Math.round((limit - 0.001) * 1000) / 1000;
  return ask + feePer(ask) > p - need ? null : limit;
}
async function placeBuy({ ticker, side, count, price }) {
  const m = (await kalshi('GET', `/markets/${ticker}`)).market || {};
  const idx = Number.isInteger(m.exchange_index) ? m.exchange_index : 0;
  await ensureShardFunds(idx, count * price + feeTotal(count, price) + 0.02);
  const yesPrice = side === 'yes' ? price : 1 - price;
  const body = {
    ticker, side: side === 'yes' ? 'bid' : 'ask',
    count: String(count) + '.00', price: yesPrice.toFixed(4),
    time_in_force: 'immediate_or_cancel', self_trade_prevention_type: 'taker_at_cross',
    client_order_id: 'kbot-' + crypto.randomUUID(), exchange_index: idx,
  };
  const o = await kalshi('POST', '/portfolio/events/orders', body);
  log('ORDER', JSON.stringify(body), '->', JSON.stringify(o));
  acctCache = null;
  const filled = num(o.fill_count) || 0;
  const avgYes = num(o.average_fill_price);
  const px = avgYes === avgYes ? (side === 'yes' ? avgYes : 1 - avgYes) : price;
  const fees = num(o.average_fee_paid) === num(o.average_fee_paid) ? num(o.average_fee_paid) * filled : feeTotal(filled, px);
  const total = filled * px + fees;
  const today = String(startOfTodayCT()); if (S.led.day !== today) S.led = { ...newLed(today), auto: S.led.auto || [] };
  S.led.spent += total; await saveSettings().catch(() => {});
  return { filled, total, fees, px };
}

// ---------- model ----------
function normCdf(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const k = 0.3989422804014327 * Math.exp(-x * x / 2); const p = k * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x > 0 ? 1 - p : p; }
function probAbove(Sp, K, sig, T) { if (!(K > 0)) return NaN; const s = sig * Math.sqrt(Math.max(T, 0.5)); return normCdf((Math.log(Sp / K) - 0.5 * s * s) / s); }
const sd = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
// Live read of BTC and ETH before every trade: price, momentum, volatility regime, data freshness.
// Kalshi settles on CF Benchmarks' index, which blends several exchanges — so we do too.
async function exchangePrices(product) {
  const coin = product.split('-')[0], H = { 'User-Agent': 'kalshi-bot' };
  const kr = { BTC: 'XBTUSD', ETH: 'ETHUSD' }[coin], bs = coin.toLowerCase() + 'usd';
  const tries = await Promise.allSettled([
    req(`https://api.exchange.coinbase.com/products/${product}/ticker`, { headers: H }).then(t => ({ src: 'coinbase', px: Number(t.price), at: Date.parse(t.time) })),
    req(`https://api.kraken.com/0/public/Ticker?pair=${kr}`, { headers: H }).then(t => { const k = Object.values(t.result || {})[0]; return { src: 'kraken', px: Number(k && k.c && k.c[0]), at: Date.now() }; }),
    req(`https://www.bitstamp.net/api/v2/ticker/${bs}/`, { headers: H }).then(t => ({ src: 'bitstamp', px: Number(t.last), at: Number(t.timestamp) * 1000 })),
  ]);
  return tries.filter(x => x.status === 'fulfilled' && x.value.px > 0).map(x => x.value);
}

// Live read of one coin: fair price across exchanges, momentum, volatility regime, data freshness.
async function coinState(product) {
  const H = { 'User-Agent': 'kalshi-bot' };
  const [prices, c] = await Promise.all([
    exchangePrices(product),
    (S.candles[product] && Date.now() - S.candles[product].t < 30e3) ? S.candles[product].v
      : req(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=60`, { headers: H }).then(v => { S.candles[product] = { t: Date.now(), v }; return v; }),
  ]);
  const candles = c.slice().reverse(); // oldest -> newest: [time, low, high, open, close, vol]
  const r = []; for (let i = 1; i < candles.length; i++) r.push(Math.log(candles[i][4] / candles[i - 1][4]));
  const pxs = prices.map(x => x.px).sort((a, b) => a - b);
  const spot = pxs.length ? pxs[Math.floor(pxs.length / 2)] : NaN; // median across exchanges
  const sig1h = sd(r.slice(-60)), sig5h = sd(r.slice(-300)), sig15 = sd(r.slice(-15));
  const sig = Math.sqrt((sig1h * sig1h + sig5h * sig5h) / 2) * CFG.VOL_MULT; // blend, not max (max overstates swings)
  const nowS = Date.now() / 1000;
  // price N minutes ago, looked up by timestamp (candles can lag a couple of minutes)
  const pxAgo = n => { const target = nowS - n * 60; let best = candles[0]; for (const k of candles) if (k[0] <= target) best = k; return best[4]; };
  const ret = n => Math.log(spot / pxAgo(n));
  const freshest = Math.max(...prices.map(x => x.at || 0));
  const st = {
    product, spot, sig, sig15, sig5h, sources: prices.map(x => x.src),
    r5: ret(5), r15: ret(15),
    ageSec: Math.max(0, Math.round((Date.now() - freshest) / 1000)),
    candleLagSec: Math.round(nowS - candles[candles.length - 1][0]),
    spreadPct: pxs.length > 1 ? (pxs[pxs.length - 1] - pxs[0]) / spot : 0,
  };
  st.z5 = st.r5 / (sig * Math.sqrt(5)); st.z15 = st.r15 / (sig * Math.sqrt(15));
  st.problems = [];
  if (!(spot > 0) || r.length < 100) st.problems.push('price data missing');
  if (prices.length < 2) st.problems.push(`only ${prices.length} exchange price${prices.length === 1 ? '' : 's'} available`);
  if (st.ageSec > 30) st.problems.push(`live price ${st.ageSec}s old`);
  if (st.candleLagSec > 600) st.problems.push(`price history ${Math.round(st.candleLagSec / 60)} min behind`);
  if (st.spreadPct > 0.002) st.problems.push(`exchanges disagree ${(st.spreadPct * 100).toFixed(2)}%`);
  if (Math.abs(st.z5) > 3) st.problems.push(`sudden ${st.r5 > 0 ? 'spike' : 'drop'} ${(st.r5 * 100).toFixed(2)}% in 5 min`);
  if (sig15 > 2.5 * sig5h) st.problems.push('volatility spiking');
  return st;
}
async function marketConditions() {
  const [btc, eth] = await Promise.all([coinState('BTC-USD'), coinState('ETH-USD')]);
  const out = { 'BTC-USD': btc, 'ETH-USD': eth };
  // crypto moves together: a shock in either coin blocks both
  for (const [k, o] of [['BTC-USD', eth], ['ETH-USD', btc]]) {
    const shock = o.problems.filter(x => /sudden|spiking/.test(x));
    if (shock.length) out[k].problems.push(`${o.product.split('-')[0]} ${shock[0]}`);
  }
  return out;
}
const pct = x => Math.abs(x) < 5e-5 ? '0.00%' : (x > 0 ? '+' : '−') + Math.abs(x * 100).toFixed(2) + '%';
function condLine(st, other) {
  const regime = st.sig15 > 1.5 * st.sig5h ? 'choppy' : st.sig15 < 0.6 * st.sig5h ? 'quiet' : 'normal';
  return `${st.product.split('-')[0]} 5m ${pct(st.r5)} · 15m ${pct(st.r15)} · vol ${regime} · ${other.product.split('-')[0]} ${other.problems.length ? '⚠️' : 'calm'} · price from ${st.sources.length} exchanges, ${st.ageSec}s old`;
}

// Full analysis of one Kalshi market given live conditions. Returns per-side verdicts.
function evaluate(m, st, now = Date.now()) {
  const mins = (new Date(m.close_time).getTime() - now) / 60000;
  const T = Math.max(mins - 2 / 3, 0.25); // Kalshi settles on a 60-second average, which cuts the last minute's variance
  const { spot, sig } = st;
  const fl = num(m.floor_strike), cp = num(m.cap_strike), sty = String(m.strike_type);
  let pY;
  if (sty.startsWith('greater')) pY = probAbove(spot, fl, sig, T);
  else if (sty.startsWith('less')) pY = 1 - probAbove(spot, cp, sig, T);
  else if (sty === 'between') pY = probAbove(spot, fl, sig, T) - probAbove(spot, cp, sig, T);
  else return [];
  if (!(pY >= 0 && pY <= 1)) return [];
  const yAsk = d(m, 'yes_ask'), nAsk = d(m, 'no_ask');
  let yBid = d(m, 'yes_bid'); if (!(yBid > 0)) yBid = nAsk > 0 ? 1 - nAsk : yAsk;
  const mid = (yAsk + yBid) / 2, spread = yAsk - yBid;
  if (!(mid > 0 && mid < 1)) return [];
  const W = CFG.MODEL_WEIGHT, out = [];
  for (const s of [{ side: 'yes', raw: pY, mkt: mid, ask: yAsk }, { side: 'no', raw: 1 - pY, mkt: 1 - mid, ask: nAsk }]) {
    s.mins = mins; s.spread = spread; s.spot = spot; s.sig = sig;
    s.p = W * s.raw + (1 - W) * s.mkt;
    s.edge = s.p - s.ask - (0.07 * s.ask * (1 - s.ask) + 0.005);
    // which way does this bet need the price to move?
    const up = sty.startsWith('greater') ? s.side === 'yes' : sty.startsWith('less') ? s.side === 'no' : null;
    s.reasons = [...st.problems];
    if (!(s.ask >= CFG.MIN_PRICE && s.ask <= CFG.MAX_PRICE)) s.reasons.push(`price ${cents(s.ask)} outside ${cents(CFG.MIN_PRICE)}–${cents(CFG.MAX_PRICE)}`);
    if (spread > 0.06) s.reasons.push(`thin market (spread ${cents(spread)})`);
    if (up !== null && Math.abs(st.z15) > 2 && (st.z15 > 0) !== up) s.reasons.push(`strong ${st.z15 > 0 ? 'up' : 'down'}trend against this bet`);
    if (s.edge < CFG.MIN_EDGE) s.reasons.push(`edge ${(s.edge * 100).toFixed(1)}¢ below ${(CFG.MIN_EDGE * 100).toFixed(0)}¢`);
    if (s.edge > CFG.MAX_EDGE) s.reasons.push('edge too big to trust (bad data?)');
    if (Math.abs(s.raw - s.mkt) > CFG.MAX_DISAGREE) s.reasons.push(`model and market disagree by ${Math.round(Math.abs(s.raw - s.mkt) * 100)} pts — market likely knows something`);
    s.ok = s.reasons.length === 0;
    out.push(s);
  }
  return out;
}

// ---------- scan ----------
async function scan(fast) {
  if (!KEY_ID || !SIGN_KEY || !OWNER) return;
  if (S.paused) return;
  const now = Date.now();
  for (const [k, v] of Object.entries(S.recentAlerts)) if (now - v > 3 * 3600e3) delete S.recentAlerts[k];
  for (const [k, v] of Object.entries(S.pending)) if (now - v.created > 3600e3) delete S.pending[k];

  const a = await account();
  let remaining = a.dayCap - a.spent;
  if (env.BOT_DEBUG === '1') log('BUDGET', JSON.stringify({ dayCap: a.dayCap, spent: a.spent, cash: a.cash }));
  if (remaining < 0.5) return;

  const cond = await marketConditions(), cands = [];
  for (const series of CFG.SERIES.filter(x => isFast(x) === !!fast)) {
    const product = CFG.SPOT[series]; if (!product || !cond[product]) continue;
    const lo = isFast(series) ? CFG.FAST_MIN_MINUTES : CFG.MIN_MINUTES, hi = isFast(series) ? CFG.FAST_MAX_MINUTES : CFG.MAX_MINUTES;
    const markets = await pageAll(`/markets?series_ticker=${series}&status=open`, 'markets');
    if (!S.seen[series]) { S.seen[series] = 1; log('SERIES', series, 'open markets:', markets.length); }
    S.blk = S.blk || {};
    const blocked = cond[product].problems.length > 0, coinName = product.split('-')[0];
    const prev = S.blk[product];
    if (blocked && !(prev && prev.on)) {             // just became blocked: tell (at most every 15 min)
      const tell = !prev || Date.now() - prev.t > 15 * 60e3;
      if (tell) await say(`🚧 ${coinName} trading paused — ${cond[product].problems.join('; ')}. I'll tell you when it clears.`);
      S.blk[product] = { on: true, t: tell ? Date.now() : prev.t, told: tell };
    } else if (!blocked && prev && prev.on) {        // just cleared
      if (prev.told) await say(`✅ ${coinName} conditions clear again — trading resumed.`);
      S.blk[product] = { on: false, t: prev.t };
    }
    if (cond[product].problems.length) { if (env.BOT_DEBUG === '1') log('COND', product, cond[product].problems.join('; '));
      if (!S.condWarn || Date.now() - S.condWarn > 15 * 60e3) { S.condWarn = Date.now(); log('CONDITIONS BLOCK', product, cond[product].problems.join('; ')); } continue; }
    for (const m of markets) {
      const mins = (new Date(m.close_time).getTime() - now) / 60000;
      if (!(mins >= lo && mins <= hi)) continue;
      if (a.held.has(m.event_ticker) || S.sc.ev[m.event_ticker]) continue; // ONE alert per market window, ever — next one only when a new window opens
      for (const v of evaluate(m, cond[product], now)) if (env.BOT_DEBUG === '1') log('EVAL', m.ticker, v.side, JSON.stringify({ raw: v.raw, mkt: v.mkt, p: v.p, ask: v.ask, edge: v.edge, reasons: v.reasons }));
      for (const v of evaluate(m, cond[product], now)) if (v.ok) cands.push({ m, product, ...v, cond: condLine(cond[product], cond[product === 'BTC-USD' ? 'ETH-USD' : 'BTC-USD']) });
    }
  }
  for (const [k, v] of Object.entries(S.sc.ev)) if (v < Date.now() - 60e3) delete S.sc.ev[k];
  cands.sort((x, y) => y.edge - x.edge);
  const openBefore = S.sc.open.length;
  const used = new Set(); let sent = 0;
  for (const c of cands) {
    if (sent >= CFG.MAX_ALERTS_PER_RUN) break;
    if (used.has(c.m.event_ticker)) continue;
    const fastSeries = isFast(c.m.event_ticker.split('-')[0]);
    const autoFast = fastSeries && CFG.AUTO_FAST === 1 && !S.led.fastOff;
    const auto = S.unlocked || autoFast;
    let limit = null;
    if (autoFast && !S.unlocked) {
      if (c.edge < CFG.AUTO_EDGE) continue;                       // auto needs the bigger edge
      limit = bestLimit(c.p, c.ask, CFG.AUTO_EDGE / 2); if (limit === null) continue;
    }
    // size within: per-trade cap, today's remaining budget, AND the cash actually in the wallet (fees + slippage included)
    const worst = limit || Math.min(c.ask + CFG.MAX_SLIPPAGE, 0.99);
    const fastLeft = autoFast && !S.unlocked ? CFG.FAST_DAY - (S.led.fast || 0) : Infinity;
    const budget = Math.min(a.tradeCap, remaining, a.cash - 0.02, fastLeft);
    let count = Math.floor(budget / worst);
    while (count > 0 && count * worst + feeTotal(count, worst) > budget) count--;
    if (env.BOT_DEBUG === '1') log('SIZE', c.m.ticker, JSON.stringify({ cap: a.tradeCap, remaining, cash: a.cash, worst, count }));
    if (count < 1) { if (a.cash < 1 && !S.lowCashWarned) { S.lowCashWarned = Date.now(); await say(`💸 Wallet is low (${money(a.cash)}). Trade ideas paused until you add funds on Kalshi.`); } continue; }
    S.sc.open.push({ t: c.m.ticker, s: c.side[0], p: Math.round(c.p * 1000) / 1000, a: c.ask, c: Date.parse(c.m.close_time) }); if (S.sc.open.length > 25) S.sc.open.shift();
    used.add(c.m.event_ticker); S.recentAlerts[c.m.ticker] = Date.now(); S.sc.ev[c.m.event_ticker] = Date.parse(c.m.close_time); sent++;
    const fee = feeTotal(count, c.ask), cost = count * c.ask + fee;
    const coin = c.product.split('-')[0];
    const st = String(c.m.strike_type);
    const strike = isFast(c.m.event_ticker.split('-')[0]) ? `UP from ${money(num(c.m.floor_strike))} (15-min) — YES = up, NO = down` : st === 'between' ? `${money(num(c.m.floor_strike))}–${money(num(c.m.cap_strike))}` : st.startsWith('less') ? `below ${money(num(c.m.cap_strike))}` : `${money(num(c.m.floor_strike))} or above`;
    const info = `${coin} ${isFast(c.m.event_ticker.split('-')[0]) ? strike : (c.m.yes_sub_title || strike)} at ${timeCT(c.m.close_time)} (closes in ${Math.round(c.mins)} min)\n\n` +
      `👉 BUY ${c.side.toUpperCase()}: ${count} @ ${cents(c.ask)} = ${money(cost)} (incl. ${money(fee)} fee)\n` +
      `Win: +${money(count - cost)} · Lose: −${money(cost)}\n` +
      `Win chance: bot ${(c.p * 100).toFixed(0)}% (model ${(c.raw * 100).toFixed(0)}%, market ${(c.mkt * 100).toFixed(0)}%) vs price ${(c.ask * 100).toFixed(0)}¢ → edge ${(c.edge * 100).toFixed(1)}¢\n` +
      `💰 Wallet ${money(a.cash)} → ${money(a.cash - cost)} after · Today ${money(a.spent)}/${money(a.dayCap)} · Profit ${money(a.profit)}\n📊 ${c.cond} · ${coin} ${money(c.spot)}`;
    if (auto) {
      const unmark = () => { delete S.sc.ev[c.m.event_ticker]; S.sc.open = S.sc.open.filter(o => o.t !== c.m.ticker); }; // nothing bought: window stays open for a later try
      try {
        const r = await placeBuy({ ticker: c.m.ticker, side: c.side, count, price: limit || c.ask });
        remaining -= r.total; a.cash -= r.total; acctCache = null;
        if (r.filled > 0) {
          if (fastSeries) { S.led.fast = (S.led.fast || 0) + r.total; S.led.auto.push({ t: c.m.ticker, s: c.side[0], n: r.filled, cost: Math.round(r.total * 100) / 100, c: Date.parse(c.m.close_time) }); if (S.led.auto.length > 30) S.led.auto.shift(); }
          await saveSettings().catch(() => {});
          await say(`🤖 AUTO${fastSeries ? ' 15-MIN' : ''} BOUGHT ${r.filled}/${count} ${c.side.toUpperCase()} @ ${cents(r.px)} for ${money(r.total)} (fees ${money(r.fees)})\n` +
            `Auto 15-min today: spent ${money(S.led.fast || 0)}/${money(CFG.FAST_DAY)} · result ${S.led.autoPnl >= 0 ? '+' : '−'}${money(Math.abs(S.led.autoPnl || 0))}\n\n` + info);
        } else {
          unmark(); log('auto not filled', c.m.ticker);
          S.nf = S.nf || {}; if (!S.nf[c.m.event_ticker]) { S.nf[c.m.event_ticker] = 1; await say(`⏳ AUTO order not filled (price moved before it executed). No money spent — will retry this window if the edge returns.\n\n` + info); }
        }
      } catch (e) { unmark(); log('auto order failed', e.message); await say(`⚠️ AUTO order failed: ${e.message.replace(/^.*?-> /, '').slice(0, 200)}\n\n` + info); }
    } else {
      const id = crypto.randomBytes(4).toString('hex');
      S.pending[id] = { ticker: c.m.ticker, side: c.side, price: c.ask, count, created: Date.now() };
      let okData = `b|${c.m.ticker}|${c.side[0]}|${Math.round(c.ask * 1000)}|${count}`, noData = `x|${c.m.ticker}`;
      if (Buffer.byteLength(okData) > 64) { okData = `ok|${id}`; noData = `no|${id}`; }
      await saveSettings().catch(() => {}); // records this window as alerted before the message goes out
      await say(`🔔 TRADE IDEA — tap within ${ttlFor(c.m.ticker) < 2 ? ttlFor(c.m.ticker) * 60 + ' sec' : ttlFor(c.m.ticker) + ' min'}\n\n` + info, {
        reply_markup: { inline_keyboard: [[{ text: `✅ Buy ${money(cost)}`, callback_data: okData }, { text: '❌ Skip', callback_data: noData }]] },
      });
    }
  }
}

async function applySetting(name, raw) {
  name = String(name || '').toLowerCase();
  if (name === 'coins') {
    const list = String(raw || '').toUpperCase().split(',').flatMap(c => COIN_SERIES[c.trim()] || []);
    if (!list.length) return 'Usage: /set coins btc,eth,sol';
    CFG.SERIES = list; await saveSettings(); return '✅ coins = ' + String(raw).toUpperCase();
  }
  const x = SETTINGS[name]; let v = Number(String(raw ?? '').replace(/[$%¢]/g, ''));
  if (['edge', 'autoedge', 'minprice', 'maxprice', 'autotrade', 'autoday'].includes(name) && v >= 1 && v <= 100) v = v / 100; // /set edge 8 = 8¢
  if (!x || !(v === v)) return 'Usage: /set <name> <value>\nExample: /set trade 3\nSee /help for names.';
  if (v < x.min || v > x.max) return `❌ ${name} must be between ${x.min} and ${x.max}.`;
  const old = CFG[x.key]; CFG[x.key] = v;
  if (name === 'every') schedule();
  await saveSettings();
  return `✅ ${name}: ${old} → ${v} (live now)`;
}

// ---------- /claude: talk to Claude from Telegram ----------
const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY || '';
const CLAUDE_MODEL = env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const GH_TOKEN = env.GITHUB_TOKEN || '';
const GH_REPO = env.GITHUB_REPO || '';
const VERSION = (env.RENDER_GIT_COMMIT || 'local').slice(0, 7);
const chatHistory = [];
const proposals = {};

async function gh(method, path, body) {
  return req('https://api.github.com/repos/' + GH_REPO + path, { method, body, headers: { Authorization: 'Bearer ' + GH_TOKEN, 'User-Agent': 'kalshi-bot', Accept: 'application/vnd.github+json' } });
}
async function getSource() { const f = await gh('GET', '/contents/server.js'); return { code: Buffer.from(f.content, 'base64').toString('utf8'), sha: f.sha }; }

const CLAUDE_TOOLS = [
  { name: 'set_setting', description: 'Change a live bot setting immediately. Names: ' + Object.entries(SETTINGS).map(([n, x]) => `${n} (${x.desc}, ${x.min}-${x.max})`).join('; ') + '; coins (comma list of btc,eth,sol).',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'] } },
  { name: 'control', description: 'pause, resume, lock (stay in confirm mode), auto (allow auto-trading at unlock profit), scan (scan now)',
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['pause', 'resume', 'lock', 'auto', 'scan'] } }, required: ['action'] } },
  { name: 'get_status', description: 'Live account numbers: cash, profit, today spend, caps, mode, open alerts.', input_schema: { type: 'object', properties: {} } },
  { name: 'propose_code_change', description: 'Propose an edit to the bot source (server.js, shown in the system prompt). Each edit replaces an exact unique snippet. Brad must tap Approve before it deploys. Use only when a setting cannot do the job.',
    input_schema: { type: 'object', properties: { summary: { type: 'string', description: 'plain-English one-paragraph summary of what changes and why' },
      edits: { type: 'array', items: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' } }, required: ['old', 'new'] } } }, required: ['summary', 'edits'] } },
];

async function runTool(name, input) {
  if (name === 'set_setting') return applySetting(input.name, input.value);
  if (name === 'control') {
    const a = input.action;
    if (a === 'pause') S.paused = true; else if (a === 'resume') S.paused = false;
    else if (a === 'lock') { S.unlocked = false; S.manualLock = true; } else if (a === 'auto') S.manualLock = false;
    else if (a === 'scan') { await tick(); return S.lastError ? 'scan error: ' + S.lastError : 'scan done'; }
    await saveSettings(); return 'done: ' + a;
  }
  if (name === 'get_status') { const a = await account(); return JSON.stringify({ mode: S.paused ? 'paused' : S.unlocked ? 'auto' : 'confirm', cash: a.cash, profit: a.profit, spentToday: a.spent, dayCap: a.dayCap, tradeCap: a.tradeCap, settledMarkets: a.settledCount, openAlerts: Object.keys(S.pending).length, lastScan: S.lastScan, lastError: S.lastError, version: VERSION }); }
  if (name === 'propose_code_change') {
    if (!GH_TOKEN || !GH_REPO) return 'Code changes are not enabled (GITHUB_TOKEN / GITHUB_REPO missing). Tell Brad.';
    const { code, sha } = await getSource();
    let next = code;
    for (const e of input.edits || []) {
      const n = next.split(e.old).length - 1;
      if (n !== 1) return `Edit failed: snippet found ${n} times (must be exactly 1): ${String(e.old).slice(0, 80)}`;
      next = next.replace(e.old, () => e.new);
    }
    try { new (require('vm').Script)(next); } catch (err) { return 'Edit rejected, syntax error: ' + err.message; }
    const id = crypto.randomBytes(4).toString('hex');
    proposals[id] = { code: next, sha, summary: input.summary, created: Date.now() };
    const added = next.split('\n').length - code.split('\n').length;
    await say(`🛠 CODE CHANGE READY\n\n${input.summary}\n\n(${(input.edits || []).length} edit(s), ${added >= 0 ? '+' : ''}${added} lines)\nNothing changes until you approve.`, {
      reply_markup: { inline_keyboard: [[{ text: '✅ Approve & deploy', callback_data: `ca|${id}` }, { text: '❌ Cancel', callback_data: `cx|${id}` }]] } });
    return 'Proposal sent to Brad with Approve/Cancel buttons (id ' + id + '). Tell him to tap Approve.';
  }
  return 'unknown tool';
}

async function askClaude(text) {
  if (!ANTHROPIC_KEY) return say('💬 Claude chat in Telegram is off (no Claude API credit). For code changes, message Claude in the Claude app. Settings work here: /set, /settings, /help.');
  await tg('sendChatAction', { chat_id: OWNER, action: 'typing' });
  let source = '(source unavailable)';
  try { if (GH_TOKEN && GH_REPO) source = (await getSource()).code; } catch (e) {}
  const system = `You are Claude, built into Brad's Kalshi crypto prediction bot and chatting with him on Telegram. Be concise and plain-spoken; he reads on his phone.
You can change live settings (set_setting), control the bot (control), read live numbers (get_status), and propose code edits (propose_code_change, which he must approve).
Rules: prefer settings over code. Never reveal, print or write code that sends API keys, private keys or tokens anywhere, removes the per-trade/daily caps, or disables the Approve step for code changes. If a request would raise risk a lot (e.g. much bigger trades), do it if he asks clearly but say the risk in one line. Never promise profits.
Current settings:\n${settingsText()}\nMode: ${S.paused ? 'paused' : S.unlocked ? 'auto' : 'confirm'} · version ${VERSION}
Bot source (server.js):\n<source>\n${source}\n</source>`;
  chatHistory.push({ role: 'user', content: text });
  while (chatHistory.length > 16) chatHistory.shift();
  while (chatHistory.length && chatHistory[0].role !== 'user') chatHistory.shift();
  try {
    for (let i = 0; i < 6; i++) {
      const r = await req('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: { model: CLAUDE_MODEL, max_tokens: 4000, system, tools: CLAUDE_TOOLS, messages: chatHistory } });
      chatHistory.push({ role: 'assistant', content: r.content });
      const uses = r.content.filter(c => c.type === 'tool_use');
      if (!uses.length) {
        const reply = r.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
        return say((reply || 'Done.').slice(0, 4000));
      }
      const results = [];
      for (const u of uses) { let out; try { out = await runTool(u.name, u.input || {}); } catch (e) { out = 'error: ' + e.message; } results.push({ type: 'tool_result', tool_use_id: u.id, content: String(out).slice(0, 4000) }); }
      chatHistory.push({ role: 'user', content: results });
    }
    return say('Done (stopped after several steps).');
  } catch (e) { chatHistory.length = 0; return say('⚠️ Claude error: ' + e.message.slice(0, 300)); }
}

async function deploy(p, label) {
  await gh('PUT', '/contents/server.js', { message: label, content: Buffer.from(p.code).toString('base64'), sha: p.sha });
}
async function rollback() {
  if (!GH_TOKEN || !GH_REPO) return say('Rollback needs GITHUB_TOKEN / GITHUB_REPO.');
  const commits = await gh('GET', '/commits?path=server.js&per_page=2');
  if (commits.length < 2) return say('Nothing to roll back to.');
  const prev = await gh('GET', `/contents/server.js?ref=${commits[1].sha}`);
  const cur = await getSource();
  const id = crypto.randomBytes(4).toString('hex');
  proposals[id] = { code: Buffer.from(prev.content, 'base64').toString('utf8'), sha: cur.sha, summary: 'Roll back to: ' + commits[1].commit.message, created: Date.now() };
  return say(`↩️ Roll back to the previous version?\n"${commits[1].commit.message.slice(0, 200)}"`, { reply_markup: { inline_keyboard: [[{ text: '✅ Roll back', callback_data: `ca|${id}` }, { text: '❌ Cancel', callback_data: `cx|${id}` }]] } });
}

// ---------- telegram ----------
async function onUpdate(u) {
  if (u.callback_query) {
    const q = u.callback_query, chat = String(q.message?.chat?.id), mid = q.message?.message_id;
    if (chat !== OWNER) return;
    const [act, id] = String(q.data).split('|');
    if (act === 'ca' || act === 'cx') {
      const pr = proposals[id]; delete proposals[id];
      const ans = (t, line) => Promise.all([tg('answerCallbackQuery', { callback_query_id: q.id, text: t }), tg('editMessageText', { chat_id: chat, message_id: mid, text: (q.message.text || '') + '\n\n' + line })]);
      if (!pr) return ans('Expired', '⏹ No longer active.');
      if (act === 'cx') return ans('Cancelled', '❌ Cancelled. Nothing changed.');
      try { await deploy(pr, 'Telegram: ' + pr.summary.slice(0, 120)); return ans('Deploying', '🚀 Approved. Deploying now — I\'ll say 🟢 when the new version is live (about 2 min).'); }
      catch (e) { return ans('Failed', '⚠️ Deploy failed: ' + e.message.slice(0, 200)); }
    }
    const parts = String(q.data).split('|');
    let p = S.pending[id];
    if (act === 'o' || act === 'b' || act === 'x') p = { ticker: parts[1], side: parts[2] === 'y' ? 'yes' : 'no', price: Number(parts[3]) / (act === 'b' ? 1000 : 100), count: Number(parts[4]), created: (q.message?.date || 0) * 1000 };
    const done = async (toast, line) => { await tg('answerCallbackQuery', { callback_query_id: q.id, text: toast }); await tg('editMessageText', { chat_id: chat, message_id: mid, text: (q.message.text || '') + '\n\n' + line }); };
    if (!p) return done('Expired', '⏹ No longer active.');
    delete S.pending[id];
    if (act === 'no' || act === 'x') return done('Skipped', '❌ Skipped.');
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Placing order…' });
    if (Date.now() - p.created > ttlFor(p.ticker) * 60e3 + 5000) return done('Expired', '⌛ Too late — price may have moved.');
    const a = await account(true);
    const m = (await kalshi('GET', `/markets/${p.ticker}`)).market || {};
    const ask = d(m, p.side + '_ask');
    if (!(ask > 0 && ask < 1)) return done('Market closed', '⏹ Market no longer tradable. Not bought.');
    // re-analyze BTC + ETH and this market right now, at TODAY'S price (not the alert's)
    const series = p.ticker.split('-')[0], product = CFG.SPOT[series];
    const cond = await marketConditions();
    const v = evaluate(m, cond[product]).find(x => x.side === p.side);
    if (!v) return done('Not bought', '🛑 Live re-check failed: market data unavailable. Not bought.');
    const feePer = q => 0.07 * q * (1 - q) + 0.005;
    const fairMax = v.p - CFG.MIN_EDGE / 2; // highest price that still leaves a real edge after fees
    if (ask + feePer(ask) > fairMax) {
      const moved = Math.abs(ask - p.price) >= 0.005 ? `Price moved to ${cents(ask)} (was ${cents(p.price)}) — ` : '';
      return done('No edge left', `⚠️ ${moved}no edge left at today's price (bot's fair value ~${cents(v.p)}). Not bought.`);
    }
    const other = v.reasons.filter(r => !/^edge .* below|^price .* outside/.test(r));
    if (other.length) return done('Not bought — conditions changed', `🛑 Live re-check failed: ${other.join('; ')}. Not bought.`);
    // limit: up to 1¢ above the live ask, but never past the price where the edge disappears
    let limit = Math.min(0.99, ask + 0.01);
    while (limit > ask && limit + feePer(limit) > fairMax) limit = Math.round((limit - 0.001) * 1000) / 1000;
    // worst-case cost (price can tick up to the limit) must fit the per-trade cap, today's budget and the wallet
    const worstCost = n => n * limit + feeTotal(n, limit);
    const room = Math.min(a.tradeCap, a.dayCap - a.spent, a.cash - 0.02);
    let count = p.count;
    while (count > 0 && worstCost(count) > room + 0.001) count--;
    if (count < 1) {
      if (a.dayCap - a.spent < worstCost(1)) return done('Daily limit hit', `🛑 Daily limit reached: spent ${money(a.spent)} of ${money(a.dayCap)} today.`);
      return done('Not enough cash', `🛑 Not enough cash: 1 contract needs up to ${money(worstCost(1))} incl. fees, wallet has ${money(a.cash)}.`);
    }
    const r = await placeBuy({ ticker: p.ticker, side: p.side, count, price: limit }); acctCache = null;
    return done(r.filled ? 'Bought!' : 'Not filled', r.filled
      ? `✅ BOUGHT ${r.filled}/${count} @ ${cents(r.px)} for ${money(r.total)} (fees ${money(r.fees)}) · wallet ≈ ${money(a.cash - r.total)}`
      : '⚠️ Not filled — nobody was selling at that price. No money spent.');
  }
  const msg = u.message; if (!msg || typeof msg.text !== 'string') return;
  const chat = String(msg.chat.id), t = msg.text.trim().toLowerCase();
  if (!OWNER) {
    if (!OWNER_CODE || msg.text.trim().split(/\s+/)[1] !== OWNER_CODE) { log('rejected claim attempt from chat', chat); return tg('sendMessage', { chat_id: chat, text: 'Private bot.' }); }
    OWNER = chat; log(`OWNER_CHAT_ID=${chat}`); await say(`✅ You're connected as the owner. I'll send trade ideas here.\nSend /help for commands.`); await saveSettings(); return; }
  if (chat !== OWNER) return tg('sendMessage', { chat_id: chat, text: 'Private bot.' });
  if (t.startsWith('/pause')) { S.paused = true; await saveSettings(); return say('⏸ Paused.'); }
  if (t.startsWith('/resume')) { S.paused = false; await saveSettings(); return say('▶️ Running.'); }
  if (t.startsWith('/lock')) { S.unlocked = false; S.manualLock = true; await saveSettings(); return say(`🔒 Confirm mode locked. /auto to allow auto-trading at +$${CFG.UNLOCK_PROFIT} again.`); }
  if (/^\/auto(@\w+)?$/.test(t)) { S.manualLock = false; await saveSettings(); return say(`Auto-trading will turn on at +$${CFG.UNLOCK_PROFIT} profit.`); }
  if (t.startsWith('/auto15')) {
    const on = !/off|0|stop/.test(t);
    CFG.AUTO_FAST = on ? 1 : 0; if (on) { S.led.fastOff = false; S.led.streak = 0; } await saveSettings();
    return say(on ? `🤖 Auto 15-min trading ON: up to ${money(CFG.SMALL_TRADE)}/trade, ${money(CFG.FAST_DAY)}/day, stops after ${money(CFG.FAST_MAX_LOSS)} loss or ${CFG.FAST_STREAK} losses in a row.` : '⏸ Auto 15-min trading OFF. 15-min ideas come as tap alerts.');
  }
  if (t.startsWith('/scan')) { await say('🔎 Scanning now…'); await tick(); return say(S.lastError ? '⚠️ ' + S.lastError : '✅ Scan done. No alert = no good trade right now.'); }
  if (t.startsWith('/stats')) {
    const c = S.sc, n = c.n;
    if (!n) return say(`📈 Scorecard: no alerts settled yet (${c.open.length} waiting). Each alert is scored after its market closes, whether or not you bought it.`);
    return say(`📈 Scorecard (every alert, 1 contract each)\nSettled: ${n} · waiting: ${c.open.length}\nBot predicted wins: ${(c.sumP / n * 100).toFixed(0)}% · actual: ${(c.wins / n * 100).toFixed(0)}%\nPaper profit: ${c.pnl >= 0 ? '+' : '−'}${money(Math.abs(c.pnl))} (${(c.pnl / n * 100).toFixed(1)}¢ per alert)\nAccuracy score (Brier, lower is better): ${(c.brier / n).toFixed(3)}\n${n < 50 ? 'Under 50 results is mostly luck — judge it after 50+.' : ''}`);
  }
  if (t.startsWith('/settings')) return say('⚙️ Current settings\n' + settingsText() + '\n\nChange one: /set trade 3\nCoins: /set coins btc,eth,sol');
  if (t.startsWith('/help')) return say('Commands\n/claude <anything> – talk to Claude (or just type)\n/status – money & mode\n/stats – is the bot predicting well?\n/settings – see all settings\n/set <name> <value> – change one live\n/scan – scan right now\n/pause /resume\n/lock – stay in confirm mode\n/auto – allow auto-trading\n/auto15 on|off – auto-trade 15-min markets\n/rollback – undo the last code change\n\nSettings you can change:\n' + Object.entries(SETTINGS).map(([n, x]) => `${n} – ${x.desc}`).join('\n') + '\ncoins – btc,eth,sol');
  if (t.startsWith('/set')) { const [, name, raw] = t.split(/\s+/); return say(await applySetting(name, raw)); }
  if (t.startsWith('/rollback')) return rollback();
  if (t.startsWith('/claude') || !t.startsWith('/')) {
    const q = msg.text.replace(/^\/claude(@\w+)?\s*/i, '').trim();
    if (!q) return say('Ask me anything or tell me what to change, e.g.\n/claude only trade ETH and raise trades to $3\n\n(You can also just type without /claude.)');
    return askClaude(q);
  }
  try {
    const a = await account();
    return say(`📊 Status\nMode: ${S.paused ? 'PAUSED' : S.unlocked ? 'AUTO' : 'CONFIRM (you tap to buy)'}\nAuto 15-min: ${CFG.AUTO_FAST !== 1 ? 'OFF' : S.led.fastOff ? 'STOPPED for today (loss limit)' : 'ON'} · today ${money(S.led.fast || 0)}/${money(CFG.FAST_DAY)} · result ${(S.led.autoPnl || 0) >= 0 ? '+' : '−'}${money(Math.abs(S.led.autoPnl || 0))}\nCash: ${money(a.cash)}\nProfit since start: ${money(a.profit)} (auto at ${money(CFG.UNLOCK_PROFIT)})\nToday: ${money(a.spent)} of ${money(a.dayCap)} · max ${money(a.tradeCap)}/trade\nLast scan: ${S.lastScan ? timeCT(S.lastScan) : 'not yet'}${S.lastError ? '\nLast error: ' + S.lastError : ''}\n\n/help for all commands`);
  } catch (e) { return say('⚠️ Can\'t reach Kalshi: ' + e.message.slice(0, 200)); }
}

// ---------- server ----------
const HOOK_SECRET = crypto.createHash('sha256').update('wh:' + TG_TOKEN + KEY_ID).digest('hex');
const HOOK = '/tg/' + crypto.createHash('sha256').update(TG_TOKEN || 'x').digest('hex').slice(0, 24);
http.createServer((rq, rs) => {
  if (rq.method === 'POST' && rq.url === HOOK) {
    if (rq.headers['x-telegram-bot-api-secret-token'] !== HOOK_SECRET) { rs.statusCode = 403; return rs.end(); }
    let b = ''; rq.on('data', c => { b += c; if (b.length > 1e6) rq.destroy(); }); rq.on('end', () => { rs.end('ok'); let u; try { u = JSON.parse(b); } catch (e) { return; }
      onUpdate(u).catch(async e => {
        log('update err', e.message);
        const q = u.callback_query;
        if (q) { await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Error — see message' }); await tg('editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text: (q.message.text || '') + '\n\n⚠️ Order failed: ' + e.message.replace(/^.*?-> /, '').slice(0, 300) }); }
        else if (OWNER) await say('⚠️ Error: ' + e.message.slice(0, 300));
      }); });
    return;
  }
  rs.setHeader('Content-Type', 'text/plain'); rs.end('ok'); // reveal nothing publicly
}).listen(env.PORT || 10000, async () => {
  log('listening', env.PORT || 10000);
  if (TG_TOKEN && PUBLIC_URL) { const r = await tg('setWebhook', { url: PUBLIC_URL + HOOK, secret_token: HOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true }); log('webhook', JSON.stringify(r)); }
  if (TG_TOKEN) await tg('setMyCommands', { commands: [
    { command: 'claude', description: 'Talk to Claude / ask for changes' }, { command: 'status', description: 'Money, profit & mode' },
    { command: 'stats', description: 'Prediction scorecard' }, { command: 'settings', description: 'See all settings' }, { command: 'set', description: 'Change a setting: /set trade 3' },
    { command: 'scan', description: 'Scan for trades now' }, { command: 'pause', description: 'Stop trading' }, { command: 'resume', description: 'Start again' },
    { command: 'lock', description: 'Stay in confirm mode' }, { command: 'auto', description: 'Allow auto-trading' }, { command: 'auto15', description: 'Auto 15-min trading on/off' }, { command: 'rollback', description: 'Undo last code change' },
    { command: 'help', description: 'All commands' }] });
  await loadSettings(); schedule();
  try { const me = await tg('getMe', {}); log('SELFCHECK telegram', me.ok ? 'OK @' + me.result.username : 'FAILED'); } catch (e) { log('SELFCHECK telegram FAILED', e.message); }
  try { const b = await kalshi('GET', '/portfolio/balance'); log('SELFCHECK kalshi OK balance', JSON.stringify(b)); }
  catch (e) {
    log('SELFCHECK kalshi FAILED', e.message);
    if (/INCORRECT_API_KEY_SIGNATURE/.test(e.message) && env.KEY_REPAIR === '1') await repairKey();
  }
  if (env.TRANSFER_SELFTEST === '1') { // moves 1¢ between your own shards to prove the key may transfer
    try {
      const r = await kalshi('POST', '/portfolio/intra_exchange_instance_transfer', { source: 'event_contract', destination: 'event_contract', amount: 100, source_exchange_shard: 0, destination_exchange_shard: 2, client_transfer_id: crypto.randomUUID() });
      log('TRANSFERTEST OK', JSON.stringify(r));
    } catch (e) { log('TRANSFERTEST FAILED', e.message); }
  }
  if (env.ORDER_SELFTEST === '1') { // $0 test: 1-contract YES bid at 1¢, immediate-or-cancel, cannot fill at a fair price
    try {
      const ms = await kalshi('GET', '/markets?series_ticker=KXBTC15M&status=open&limit=5');
      const m = (ms.markets || [])[0];
      const o = await kalshi('POST', '/portfolio/events/orders', { ticker: m.ticker, side: 'bid', count: '1.00', price: '0.0100', time_in_force: 'immediate_or_cancel', self_trade_prevention_type: 'taker_at_cross', client_order_id: 'kbot-selftest-' + Date.now() });
      log('ORDERTEST OK', m.ticker, JSON.stringify(o));
    } catch (e) { log('ORDERTEST FAILED', e.message); }
  }
  if (OWNER) say(`🟢 Bot running (version ${VERSION}). Send /help anytime.`);
});

// one-time helper: a key copied by hand can have look-alike characters (l/I/1, O/0). Try those swaps.
async function repairKey() {
  const m = PEM.match(/-----BEGIN PRIVATE KEY-----\n([\s\S]*?)\n-----END/); if (!m) return;
  const body = m[1].replace(/\s+/g, ''), groups = { l: 'lI1', I: 'Il1', '1': '1lI', O: 'O0', '0': '0O' };
  const fixedPrefix = 21; // 'MC4CAQAwBQYDK2VwBCIEI' is the standard Ed25519 header
  const spots = []; for (let i = fixedPrefix; i < body.length; i++) if (groups[body[i]]) spots.push(i);
  log('KEYREPAIR trying swaps at positions', spots.join(','));
  const total = spots.reduce((n, i) => n * groups[body[i]].length, 1);
  if (total > 400) return log('KEYREPAIR too many combos', total);
  const original = SIGN_KEY;
  for (let k = 1; k < total; k++) {
    let x = k, arr = body.split('');
    for (const i of spots) { const g = groups[body[i]]; arr[i] = g[x % g.length]; x = Math.floor(x / g.length); }
    try {
      SIGN_KEY = crypto.createPrivateKey(`-----BEGIN PRIVATE KEY-----\n${arr.join('')}\n-----END PRIVATE KEY-----\n`);
      await kalshi('GET', '/portfolio/balance');
      const changed = spots.filter(i => arr[i] !== body[i]).map(i => `pos${i}:${body[i]}->${arr[i]}`).join(' ');
      return log('KEYREPAIR FOUND', changed);
    } catch (e) { await new Promise(r => setTimeout(r, 250)); }
  }
  SIGN_KEY = original; log('KEYREPAIR no match');
}

async function gradeAutoTrades() {
  let changed = false;
  for (const o of (S.led.auto || []).filter(x => !x.done && Date.now() > x.c + 3 * 60e3)) {
    let m; try { m = (await kalshi('GET', `/markets/${o.t}`)).market || {}; } catch (e) { continue; }
    const res = String(m.result || '').toLowerCase(); if (res !== 'yes' && res !== 'no') continue;
    const win = (o.s === 'y' ? 'yes' : 'no') === res;
    const pnl = (win ? o.n : 0) - o.cost;
    o.done = 1; o.pnl = Math.round(pnl * 100) / 100; changed = true;
    S.led.autoPnl = Math.round(((S.led.autoPnl || 0) + pnl) * 100) / 100;
    S.led.streak = win ? 0 : (S.led.streak || 0) + 1;
    if (!S.led.fastOff && (S.led.autoPnl <= -CFG.FAST_MAX_LOSS || S.led.streak >= CFG.FAST_STREAK)) {
      S.led.fastOff = true;
      await say(`🛑 Auto 15-min trading stopped for today: ${S.led.streak >= CFG.FAST_STREAK ? `${S.led.streak} losses in a row` : `down ${money(-S.led.autoPnl)}`}. It restarts tomorrow (or send /auto15 on).`);
    }
  }
  if (changed) await saveSettings();
}

async function scoreAlerts() {
  await gradeAutoTrades();
  const due = S.sc.open.filter(o => Date.now() > o.c + 3 * 60e3);
  let changed = false;
  for (const o of due) {
    let m; try { m = (await kalshi('GET', `/markets/${o.t}`)).market || {}; } catch (e) { continue; }
    const res = String(m.result || '').toLowerCase();
    if (res !== 'yes' && res !== 'no') { if (Date.now() > o.c + 6 * 3600e3) { S.sc.open = S.sc.open.filter(x => x !== o); changed = true; } continue; }
    const win = (o.s === 'y' ? 'yes' : 'no') === res ? 1 : 0;
    S.sc.n++; S.sc.wins += win; S.sc.sumP += o.p; S.sc.brier += (o.p - win) ** 2;
    S.sc.pnl += win - o.a - 0.07 * o.a * (1 - o.a); // per 1 contract, after fee
    await say(`📈 Graded: ${o.t} ${o.s === 'y' ? 'YES' : 'NO'} @ ${cents(o.a)} would have ${win ? 'WON' : 'LOST'} (bot gave it ${Math.round(o.p * 100)}%). Scorecard: ${S.sc.wins}/${S.sc.n} right · paper ${S.sc.pnl >= 0 ? '+' : '−'}${money(Math.abs(S.sc.pnl))}/contract`);
    S.sc.open = S.sc.open.filter(x => x !== o); changed = true;
  }
  if (changed) await saveSettings();
}

async function tick(fast = false) {
  if (S.busy) return; S.busy = true;
  try { await scan(fast); if (!fast) { await scan(true); await scoreAlerts(); } S.lastScan = new Date().toISOString(); S.lastError = null; S.errCount = 0; }
  catch (e) {
    S.lastError = e.message.slice(0, 200); S.errCount = (S.errCount || 0) + 1; log('scan error', e.message);
    if (S.errCount >= 3 && Date.now() - (S.lastErrAlert || 0) > 30 * 60e3) { S.lastErrAlert = Date.now(); say('⚠️ Scanning keeps failing: ' + S.lastError); }
  }
  finally { S.busy = false; }
}
if (env.BOT_TEST !== '1') { // tests drive scans manually
  setInterval(() => tick(true), 10e3); // 15-min markets checked every 10 seconds
  setTimeout(tick, 15000);
}
// keep the free Render instance awake
if (PUBLIC_URL) setInterval(() => fetch(PUBLIC_URL + '/').catch(() => {}), 4 * 60e3);
