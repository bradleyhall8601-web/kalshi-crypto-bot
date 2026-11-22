// Kalshi crypto prediction bot — standalone (no dependencies). Node 18+.
// Env: KALSHI_KEY_ID, KALSHI_PRIVATE_KEY, TELEGRAM_BOT_TOKEN, [TELEGRAM_CHAT_ID], [BOT_START_TS], [KALSHI_ENV=demo]
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const research = require('./research');
const news = require('./news');

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

// every coin Kalshi lists crypto price markets for: hourly/daily (KX<coin>D) and 15-minute (KX<coin>15M)
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE', 'NEAR', 'ZEC'];
const HOURLY_ALT = { NEAR: 'KXNEARH', ZEC: 'KXZECH' }; // Kalshi runs these coins' hourly markets under an "H" series
const ALL_SERIES = COINS.flatMap(c => [`KX${c}D`, ...(HOURLY_ALT[c] ? [HOURLY_ALT[c]] : []), `KX${c}15M`]);
const CFG = {
  SERIES: (env.BOT_SERIES || ALL_SERIES.join(',')).split(',').map(s => s.trim()).filter(Boolean),
  SPOT: Object.fromEntries(COINS.flatMap(c => [[`KX${c}D`, `${c}-USD`], [`KX${c}H`, `${c}-USD`], [`KX${c}`, `${c}-USD`], [`KX${c}15M`, `${c}-USD`]])),
  FAST_MIN_MINUTES: 1.5, FAST_MAX_MINUTES: 15, // 15-minute markets: trade while 1.5-15 min remain
  MIN_EDGE: Number(env.BOT_MIN_EDGE || 0.04), MAX_EDGE: 0.25, MAX_DISAGREE: 0.18,
  SHOCK_PCT: 0.006, // a 5-min move must be > 0.6% (and > 4x normal) to count as a shock
  FAST_TTL_MIN: 1.5, // 15-min markets move in seconds: alerts expire fast
  AUTO_FAST: 1,       // auto-trade the 15-minute markets (no tap needed)
  AUTO_EDGE: 0.05,    // auto trades need a slightly bigger edge than tap alerts (no human double-check)
  FAST_DAY: 0,        // max $ per day on auto 15-min trades (0 = no limit)
  FAST_MAX_LOSS: 0,   // stop auto trading for the day after losing this much (0 = 40% of the day's starting wallet)
  FAST_STREAK: 8,     // ...or after this many losses in a row (many markets now, so 4 in a row is ordinary bad luck)
  AUTO_GRACE: 0.03,   // auto may pay up to 3¢ above the live ask (only while the edge survives)
  AUTO_TRIES: 3,      // re-read the live book and retry this many times within ~3 seconds
  MIN_PRICE: 0.15, MAX_PRICE: 0.85,
  MIN_MINUTES: 8, MAX_MINUTES: 70,
  VOL_MULT: Number(env.BOT_VOL_MULT || 1.0), // honest volatility; inflating it makes long shots look cheap
  MODEL_WEIGHT: 0.5, // blend: 50% our model, 50% the market's own price (guards against model overconfidence)
  UNLOCK_PROFIT: 100, RELOCK_PROFIT: 50,
  SMALL_TRADE: 2, SMALL_DAY: 0, SCALED_TRADE_PCT: 0.02, SCALED_DAY_PCT: 0.10, // SMALL_DAY 0 = no daily limit
  TRADE_PCT: 0.25,   // never put more than 25% of the wallet into one trade
  RESERVE: 1.00,     // always keep this much cash untouched so the account never hits $0
  AUTO_HOURLY: 1,    // auto-trade hourly markets too
  ALWAYS_IN: 1,      // hold a position in every market window (BTC/ETH hourly + 15-min) when the better side is not negative after fees
  ALWAYS_EDGE: 0,    // min edge (¢) for always-in entries (0 = break-even or better)
  ALWAYS_PCT: 0.10,  // always-in entries use 10% of wallet
  DAILY: 1,          // also trade the daily 5 PM ET markets (up to 24h ahead)
  DAILY_MIN_EQUITY: 20, // ...but only once the account has $20+ (a daily bet locks money for up to a day; small wallets need 15-min turnover)
  MAX_OPEN_PCT: 0.60, // never have more than 60% of the money tied up in open positions at once
  LEARN: 1,
  CAL: 1,
  MAKER: env.BOT_TEST === '1' ? 0 : 1, // post limit bids (pay the bid, ~¼ fee) instead of paying the ask
  MAKER_EDGE: 0.02,  // a resting bid needs this much calibrated edge after the maker fee
  MAKER_TTL_MIN: 5,  // re-check / re-post a resting bid at least this often
  KELLY: env.BOT_TEST === '1' ? 0 : 0.5,
  RESERVE_SCALE: env.BOT_TEST === '1' ? 0 : 1, // reserve = the smaller of $RESERVE and 10% of the account (min 25¢), so a small account can still trade // size by half-Kelly on the calibrated edge (capped by tradepct)            // self-calibration: shrink the model toward the market by how much its past disagreements came true          // self-learning: each market type (coin x 15-min/hourly/daily) tightens or benches itself from its own real results
  MAX_ALERTS_PER_RUN: 2, ALERT_TTL_MIN: 4, MAX_SLIPPAGE: 0.02,
  SCAN_EVERY_MIN: 1, TZ: 'America/Chicago',
};

// ---------- live settings (changeable from Telegram, saved in a pinned message) ----------
const SETTINGS = {
  edge:     { key: 'MIN_EDGE', desc: 'min edge per contract in $ (0.06 = 6¢)', min: 0.01, max: 0.5 },
  trade:    { key: 'SMALL_TRADE', desc: 'max $ per trade (confirm mode)', min: 1, max: 1000 },
  day:      { key: 'SMALL_DAY', desc: 'max $ per day (0 = no limit)', min: 0, max: 10000 },
  tradepct: { key: 'TRADE_PCT', desc: 'max share of wallet per trade (0.25 = 25%)', min: 0.01, max: 1 },
  reserve:  { key: 'RESERVE', desc: '$ always kept in the wallet (never traded)', min: 0, max: 100000 },
  always:   { key: 'ALWAYS_IN', desc: 'always hold one position per market window (1 = on, 0 = off)', min: 0, max: 1 },
  alwaysedge: { key: 'ALWAYS_EDGE', desc: 'always-in: min edge in ¢ (0 = break-even; negative = force)', min: -10, max: 20 },
  alwayspct: { key: 'ALWAYS_PCT', desc: 'always-in: share of wallet per entry (0.10 = 10%)', min: 0.01, max: 0.5 },
  auto1h:   { key: 'AUTO_HOURLY', desc: 'auto-trade hourly markets (1 = on, 0 = off)', min: 0, max: 1 },
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
  fastday:  { key: 'FAST_DAY', desc: 'max $ per day on auto 15-min trades (0 = no limit)', min: 0, max: 10000 },
  grace:    { key: 'AUTO_GRACE', desc: 'auto: max ¢ above live ask to get filled (0.03 = 3¢)', min: 0, max: 0.1 },
  streak:   { key: 'FAST_STREAK', desc: 'stop auto for the day after N losses in a row', min: 2, max: 100 },
  dailymin: { key: 'DAILY_MIN_EQUITY', desc: 'only trade daily markets with at least this much money ($)', min: 0, max: 100000 },
  daily:    { key: 'DAILY', desc: 'trade daily 5 PM ET markets (1 = on, 0 = off)', min: 0, max: 1 },
  maxopen:  { key: 'MAX_OPEN_PCT', desc: 'max share of money in open positions (0.6 = 60%)', min: 0.1, max: 1 },
  maker:    { key: 'MAKER', desc: 'limit bids instead of paying the ask (1 = on, 0 = off)', min: 0, max: 1 },
  makeredge:{ key: 'MAKER_EDGE', desc: 'edge needed for a limit bid (0.02 = 2¢)', min: 0, max: 0.2 },
  reservescale: { key: 'RESERVE_SCALE', desc: 'reserve shrinks with a small account (1 = on: min of $reserve and 10%)', min: 0, max: 1 },
  kelly:    { key: 'KELLY', desc: 'bet size as a share of the Kelly amount (0.5 = half; 0 = off)', min: 0, max: 1 },
  calib:    { key: 'CAL', desc: 'self-calibration from real results (1 = on, 0 = off)', min: 0, max: 1 },
  learn:    { key: 'LEARN', desc: 'self-learning from real results (1 = on, 0 = off)', min: 0, max: 1 },
  fastloss: { key: 'FAST_MAX_LOSS', desc: 'stop auto for the day after losing $ (0 = 40% of start-of-day wallet)', min: 0, max: 10000 },
};
const coinOf = t => (String(t).match(new RegExp(`^KX(${COINS.join('|')})`)) || [])[1] || '';
const COIN_SERIES = Object.fromEntries(COINS.map(c => [c, ALL_SERIES.filter(x => coinOf(x) === c)]));
const isFast = s => /15M$/.test(s);
const ttlFor = ticker => isFast(String(ticker).split('-')[0]) ? CFG.FAST_TTL_MIN : CFG.ALERT_TTL_MIN;
let pinnedId = null;
function settingsText() { return Object.entries(SETTINGS).map(([n, x]) => `${n} = ${CFG[x.key]}`).join('\n') + `\nmarkets = ${CFG.SERIES.join(', ')}`; }
let saveChain = Promise.resolve();
function saveSettings() { saveChain = saveChain.then(saveSettingsNow, saveSettingsNow); return saveChain; }
async function saveSettingsNow() {
  if (!OWNER) return;
  const blob = {}; for (const x of Object.values(SETTINGS)) blob[x.key] = CFG[x.key]; blob.SERIES = CFG.SERIES; blob.manualLock = S.manualLock; blob.paused = S.paused; blob.v = 10; blob.REST = S.rest; blob.LANES = S.lanes; blob.CALFIT = S.cal; blob.SC = S.sc; blob.LED = S.led; blob.SETL = S.setlTs; blob.LRN = S.learn;
  let text = '⚙️ BOT SETTINGS (do not unpin)\n' + JSON.stringify(blob);
  if (text.length > 4000) { S.sc.open = S.sc.open.slice(-8); blob.SC = S.sc; text = '⚙️ BOT SETTINGS (do not unpin)\n' + JSON.stringify(blob); }
  if (text.length > 4000) text = '⚙️ BOT SETTINGS (do not unpin)\nZ:' + zlib.deflateRawSync(Buffer.from(JSON.stringify(blob)), { level: 9 }).toString('base64'); // many coins: compress to fit Telegram's 4096 limit
  if (text.length > 4090) { S.led.auto = (S.led.auto || []).filter(x => !x.done).slice(-20); blob.LED = S.led; text = '⚙️ BOT SETTINGS (do not unpin)\nZ:' + zlib.deflateRawSync(Buffer.from(JSON.stringify(blob)), { level: 9 }).toString('base64'); }
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
    const zi = pm.text.indexOf('\nZ:');
    const blob = zi >= 0 ? JSON.parse(zlib.inflateRawSync(Buffer.from(pm.text.slice(zi + 3).trim(), 'base64')).toString()) : JSON.parse(pm.text.slice(pm.text.indexOf('{')));
    for (const x of Object.values(SETTINGS)) if (typeof blob[x.key] === 'number') CFG[x.key] = blob[x.key];
    if (Array.isArray(blob.SERIES) && blob.SERIES.length) CFG.SERIES = blob.SERIES;
    if (!(blob.v >= 10) && env.BOT_TEST !== '1') { CFG.TRADE_PCT = 0.06; CFG.DAILY_MIN_EQUITY = 50; CFG.MAKER = 1; CFG.KELLY = 0.5; setTimeout(saveSettings, 2000); } // grow-and-last sizing + limit bids
    if (blob.REST && typeof blob.REST === 'object') S.rest = blob.REST;
    if (!(blob.v >= 9)) { for (const x of Object.values(HOURLY_ALT)) if (!CFG.SERIES.includes(x) && CFG.SERIES.some(y => coinOf(y) === coinOf(x))) CFG.SERIES.push(x); setTimeout(saveSettings, 2000); } // NEAR/ZEC hourly live under KX..H
    if (!(blob.v >= 8)) { for (const x of ALL_SERIES) if (!CFG.SERIES.includes(x)) CFG.SERIES.push(x); CFG.FAST_STREAK = Math.max(CFG.FAST_STREAK || 0, 8); CFG.DAILY = 1; CFG.MAX_OPEN_PCT = 0.6; CFG.LEARN = 1; setTimeout(saveSettings, 2000); } // all coins + daily + self-learning
    if (!(blob.v >= 7)) { CFG.ALWAYS_IN = 1; CFG.ALWAYS_EDGE = 0; CFG.ALWAYS_PCT = 0.10; setTimeout(saveSettings, 2000); }
    if (!(blob.v >= 6)) { CFG.SMALL_DAY = 0; CFG.FAST_DAY = 0; CFG.FAST_MAX_LOSS = 0; CFG.AUTO_HOURLY = 1; CFG.TRADE_PCT = 0.25; CFG.RESERVE = 1; setTimeout(saveSettings, 2000); } // continuous auto, wallet protection
    if (!(blob.v >= 5)) { CFG.AUTO_FAST = 1; setTimeout(saveSettings, 2000); } // switch on auto 15-min once
    if (!(blob.v >= 4)) { CFG.VOL_MULT = 1.0; CFG.MIN_EDGE = 0.04; CFG.MIN_PRICE = Math.max(CFG.MIN_PRICE, 0.15); if (typeof blob.MODEL_WEIGHT !== 'number') CFG.MODEL_WEIGHT = 0.5; setTimeout(saveSettings, 2000); }
    if (!(blob.v >= 3)) { CFG.SCAN_EVERY_MIN = 1; setTimeout(saveSettings, 2000); }
    if (!(blob.v >= 2)) { for (const x of ['KXBTC15M', 'KXETH15M']) if (!CFG.SERIES.includes(x)) CFG.SERIES.push(x); setTimeout(saveSettings, 2000); } // add 15-min markets once
    if (blob.SC && typeof blob.SC === 'object') S.sc = { ...S.sc, ...blob.SC, ev: blob.SC.ev || {} };
    if (blob.SETL > 0) S.setlTs = blob.SETL;
    if (blob.LRN && typeof blob.LRN === 'object') S.learn = blob.LRN;
    if (blob.LANES && typeof blob.LANES === 'object') S.lanes = blob.LANES;
    if (blob.CALFIT && typeof blob.CALFIT === "object") S.cal = blob.CALFIT;
    if (blob.LED && typeof blob.LED.spent === 'number') S.led = { ...newLed(blob.LED.day), ...blob.LED };
    if (S.led.fastOff) { S.led.fastOff = false; S.led.safe = true; setTimeout(() => { saveSettings(); say('🛡 Loss stop switched to SAFE MODE: trading again now — 1 contract at a time, only 5¢+ edges, no always-in. Back to normal size at midnight CT.'); }, 3000); }
    S.manualLock = !!blob.manualLock; S.paused = !!blob.paused; pinnedId = pm.message_id;
    log('settings loaded', JSON.stringify(blob));
  } catch (e) { log('settings parse error', e.message); }
}
let scanTimer = null;
function schedule() { if (scanTimer) clearInterval(scanTimer); if (env.BOT_TEST !== '1') scanTimer = setInterval(() => tick(false), CFG.SCAN_EVERY_MIN * 60e3); }

const newLed = day => ({ day, spent: 0, fast: 0, autoPnl: 0, streak: 0, fastOff: false, auto: [], n: 0, nAuto: 0, w: 0, l: 0, pnl: 0, fees: 0, best: 0, worst: 0 });
// human label from a Kalshi ticker, e.g. KXBTC15M-26NOV211830-30 -> "BTC 15-min · 5:30 PM CT"
function label(ticker) {
  const [ser, ev, k] = String(ticker).split('-');
  const coin = coinOf(ser) || ser;
  const tm = (ev || '').match(/^\d{2}[A-Z]{3}\d{2}(\d{2})(\d{2})?$/);
  const kind = /15M$/.test(ser) ? '15-min' : /[DH]$/.test(ser) ? (tm && tm[1] === '17' && !tm[2] ? 'daily' : 'hourly') : '';
  let when = '';
  if (tm) { let h = (Number(tm[1]) + 23) % 24; const mm = tm[2] || '00'; when = `${h % 12 || 12}:${mm} ${h < 12 ? 'AM' : 'PM'} CT`; } // ticker time is ET
  const strike = k && /^T[\d.]+$/.test(k) ? ` ≥ ${money(Math.ceil(Number(k.slice(1))))}` : '';
  return `${coin} ${kind}${strike}${when ? ' · ' + when : ''}`.replace(/\s+/g, ' ').trim();
}
function dayReport(L, title) {
  const settled = L.w + L.l;
  return `📒 ${title}\n` +
    `🧾 Trades: ${L.n} (🤖 auto ${L.nAuto} · 👆 tap ${L.n - L.nAuto})\n` +
    `🏆 Wins ${L.w} · 💔 Losses ${L.l}${settled ? ` · ${Math.round(L.w / settled * 100)}% hit` : ''}\n` +
    `${L.pnl >= 0 ? '📈' : '📉'} P&L ${L.pnl >= 0 ? '+' : ''}${money(L.pnl)} · 💸 fees ${money(L.fees)}\n` +
    (settled ? `🥇 best ${L.best >= 0 ? '+' : ''}${money(L.best)} · 🥶 worst ${money(L.worst)}\n` : '') +
    `📝 Scorecard ${S.sc.wins}/${S.sc.n} alerts right` + (acctCache ? `\n💰 Wallet ${money(acctCache.v.cash)}` : '');
}
async function rollDay(today) {
  if (S.led.day === today) return;
  if (S.led.day && (S.led.n || S.led.w || S.led.l)) await say(dayReport(S.led, 'DAILY REPORT (yesterday)'));
  S.led = { ...newLed(today), auto: S.led.auto || [] };
}
const S = { bootAt: Date.now(), win: {}, // per market window: best verdict seen, traded or not
   learn: {}, lanes: {}, rest: {}, newsSeen: new Set(), newsLog: [], newsPauseUntil: 0, newsPauseWhy: '', lastCond: {}, stats: { fast: [], slow: [], skipped: {}, last15: {} }, candles: {}, led: newLed(''), sc: { n: 0, wins: 0, sumP: 0, brier: 0, pnl: 0, open: [], ev: {} }, seen: {}, busy: false, pending: {}, recentAlerts: {}, paused: false, manualLock: false, unlocked: false, lastScan: null, lastError: null };
const log = (...a) => console.log(new Date().toISOString(), ...a);
process.on('uncaughtException', e => log('uncaught', e.stack || e.message));
process.on('unhandledRejection', e => log('unhandled', (e && e.stack) || e));

// ---------- helpers ----------
async function req(url, { method = 'GET', headers = {}, body, raw = false } = {}) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${url.split('?')[0].replace(/\/bot[^/]+/, '/bot***')} -> ${r.status}: ${t.slice(0, 300)}`);
  if (raw) return t;
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
// every Telegram report is also written to the server log (one line), so a log review sees exactly what Brad saw
const say = (text, extra = {}) => { if (!OWNER) return null; log('TG', String(text).replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 600)); return tg('sendMessage', { chat_id: OWNER, text, ...extra }); };
const num = v => (v === undefined || v === null || v === '') ? NaN : Number(v);
const d = (o, k) => {
  const a = num(o[k + '_dollars']); if (a === a) return a;
  const f = num(o[k + '_fixed']); if (f === f) return f;
  const v = o[k]; const b = num(v); if (!(b === b)) return NaN;
  return typeof v === 'string' && v.includes('.') ? b : b / 100; // "0.0068" = dollars, 68 = cents
};
const cnt = (o, k = 'count') => { const a = num(o[k + '_fp']); return a === a ? a : (num(o[k]) || 0); };
const feeTotal = (c, p) => Math.ceil(0.07 * c * p * (1 - p) * 100 - 1e-9) / 100;
const money = x => !isFinite(x) ? 'no limit' : (Number(x) < -0.004 ? '−$' : '$') + Math.abs(Number(x)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  const cached = acctCache; // the 15-min and hourly scans run side by side: keep our own reference across the await
  if (!fresh && cached && Date.now() - cached.t < 20000) {
    const b = await kalshi('GET', '/portfolio/balance');
    const shards = {}; for (const x of b.balance_breakdown || []) shards[x.exchange_index] = Number(x.balance) || 0;
    const cash = d(b, 'balance');
    const tradeCap = S.unlocked ? Math.max(CFG.SMALL_TRADE, cash * CFG.SCALED_TRADE_PCT) : Math.min(CFG.SMALL_TRADE, Math.max(0.5, cash * CFG.TRADE_PCT));
    return { ...cached.v, cash, shards, tradeCap };
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
    const pl = pnlOf(x), res = String(x.market_result || x.result || '').toUpperCase(), tk = x.ticker || x.market_ticker;
    await rollDay(String(startOfTodayCT()));
    if (pl >= 0) S.led.w++; else S.led.l++;
    S.led.pnl = Math.round((S.led.pnl + pl) * 100) / 100; S.led.best = Math.max(S.led.best, pl); S.led.worst = Math.min(S.led.worst, pl);
    await say(`${pl >= 0 ? '🏆 WIN' : '💔 LOSS'} ${pl >= 0 ? '+' : ''}${money(pl)} · ${label(tk)}${res ? ` → ${res}` : ''}\n` +
      `📊 Today ${S.led.w}W·${S.led.l}L ${S.led.pnl >= 0 ? '+' : ''}${money(S.led.pnl)} · all-time ${profit >= 0 ? '+' : ''}${money(profit)}`);
  }
  if (fresh.length) { S.setlTs = stime(fresh[fresh.length - 1]); saveSettings().catch(() => {}); }
  // today's spend = buys filled since midnight CT
  const fills = await pageAll(`/portfolio/fills?min_ts=${startOfTodayCT()}`, 'fills');
  if (fills.length && !S.loggedFill) { S.loggedFill = 1; log('FILLSAMPLE', JSON.stringify(fills[0])); }
  let fillSpent = 0;
  for (const f of fills) {
    // a NO buy can show up as a YES sell in Kalshi's new single-leg format; count both as money spent
    // the bot only ever buys; the outcome it now holds is outcome_side (new format) or side
    const held = f.outcome_side || (f.action === 'sell' ? (f.side === 'yes' ? 'no' : 'yes') : f.side);
    const buyNo = held === 'no';
    const px = buyNo ? (d(f, 'no_price') === d(f, 'no_price') ? d(f, 'no_price') : 1 - d(f, 'yes_price')) : d(f, 'yes_price');
    const fee = d(f, 'fee_cost');
    if (px === px) fillSpent += cnt(f) * px + (fee === fee ? fee : feeTotal(cnt(f), px));
  }
  const today = String(startOfTodayCT());
  await rollDay(today);
  if (!(S.led.startCash > 0)) S.led.startCash = cash;
  const spent = Math.max(fillSpent, S.led.spent); // never under-count
  // events we already hold
  const pos = await kalshi('GET', '/portfolio/positions?count_filter=position&limit=1000');
  const live = (pos.market_positions || []).filter(p => cnt(p, 'position') !== 0);
  const held = new Set(live.map(p => p.ticker.split('-').slice(0, -1).join('-')));
  const exps = live.map(p => d(p, 'market_exposure')).filter(x => x === x);
  const exposure = !live.length ? 0 : exps.length ? exps.reduce((a, x) => a + Math.abs(x), 0) : null; // $ tied up in open positions (Kalshi's own number)

  if (!S.unlocked && !S.manualLock && profit >= CFG.UNLOCK_PROFIT) { S.unlocked = true; await say(`🔓 Profit hit ${money(profit)}. Auto-trading ON (${CFG.SCALED_TRADE_PCT*100}% of balance per trade, ${CFG.SCALED_DAY_PCT*100}% per day). /lock to stop.`); }
  else if (S.unlocked && profit < CFG.RELOCK_PROFIT) { S.unlocked = false; await say(`🔒 Profit fell to ${money(profit)}. Back to confirm mode (${money(CFG.SMALL_TRADE)}/trade, ${money(CFG.SMALL_DAY)}/day).`); }
  // per trade: the $ cap, but never more than TRADE_PCT of the wallet (so a losing streak can't empty it)
  const tradeCap = S.unlocked ? Math.max(CFG.SMALL_TRADE, cash * CFG.SCALED_TRADE_PCT) : Math.min(CFG.SMALL_TRADE, Math.max(0.5, cash * CFG.TRADE_PCT));
  const dayCap = CFG.SMALL_DAY > 0 ? (S.unlocked ? Math.max(CFG.SMALL_DAY, cash * CFG.SCALED_DAY_PCT) : CFG.SMALL_DAY) : Infinity;
  // per-shard cash so we know what's really spendable
  const shards = {}; for (const x of b.balance_breakdown || []) shards[x.exchange_index] = Number(x.balance) || 0;
  return { cash, shards, profit, spent, held, exposure, tradeCap, dayCap, settledCount: settles.length };
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
// Live order book: the market list can lag seconds behind on fast 15-min markets, so price from the book itself.
async function withLiveQuote(m) {
  const r = await kalshi('GET', `/markets/${m.ticker}/orderbook?depth=20`);
  const ob = r.orderbook_fp || {}, lv = a => (a || []).map(x => [Number(x[0]), Number(x[1])]).filter(x => x[0] > 0 && x[1] > 0);
  const yes = lv(ob.yes_dollars), no = lv(ob.no_dollars);
  const yBid = yes.length ? Math.max(...yes.map(x => x[0])) : NaN, nBid = no.length ? Math.max(...no.map(x => x[0])) : NaN;
  const live = { ...m, _book: { yes, no }, _live: true,
    yes_ask_dollars: nBid > 0 ? (1 - nBid).toFixed(4) : null, no_ask_dollars: yBid > 0 ? (1 - yBid).toFixed(4) : null,
    yes_bid_dollars: yBid > 0 ? yBid.toFixed(4) : null };
  return live;
}
// contracts available to BUY on a side at or below a price (YES asks come from NO bids, and vice versa)
function bookDepth(m, side, limit) {
  if (!m._book) return Infinity;
  const opp = side === 'yes' ? m._book.no : m._book.yes;
  return opp.filter(([px]) => 1 - px <= limit + 1e-9).reduce((a, x) => a + x[1], 0);
}
// highest price worth paying: up to 1¢ above the ask, but only while the edge after fees stays >= need
// Kalshi only accepts whole-cent order prices, so limits are whole cents.
const ceilCent = x => Math.ceil(x * 100 - 1e-9) / 100;
function bestLimit(p, ask, need, grace = 0.01) {
  const feePer = q => 0.07 * q * (1 - q) + 0.005;
  const floor = ceilCent(ask);                                   // lowest valid price that can still fill
  if (floor > 0.99 || floor + feePer(floor) > p - need) return null;
  let limit = Math.max(floor, Math.min(0.99, Math.floor((ask + grace) * 100 + 1e-9) / 100)); // never more than ask + grace
  while (limit > floor && limit + feePer(limit) > p - need) limit = Math.round((limit - 0.01) * 100) / 100;
  return limit;
}
async function placeBuy({ ticker, side, count, price, auto = false }) {
  const m = (await kalshi('GET', `/markets/${ticker}`)).market || {};
  const idx = Number.isInteger(m.exchange_index) ? m.exchange_index : 0;
  await ensureShardFunds(idx, count * price + feeTotal(count, price) + 0.02);
  price = Math.round(price * 100) / 100; // whole cents only
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
  await rollDay(String(startOfTodayCT()));
  S.led.spent += total; if (filled > 0) { S.led.n++; if (auto) S.led.nAuto++; S.led.fees += fees; } await saveSettings().catch(() => {});
  return { filled, total, fees, px };
}

// ---------- model ----------
function normCdf(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const k = 0.3989422804014327 * Math.exp(-x * x / 2); const p = k * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x > 0 ? 1 - p : p; }
function probAbove(Sp, K, sig, T) { if (!(K > 0)) return NaN; const s = sig * Math.sqrt(Math.max(T, 0.5)); return normCdf((Math.log(Sp / K) - 0.5 * s * s) / s); }
const sd = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
// Live read of BTC and ETH before every trade: price, momentum, volatility regime, data freshness.
// Kalshi settles on CF Benchmarks' index, which blends several exchanges — so we do too.
// Price sources per coin. Unsupported pairs are remembered (6h) so we don't spam exchanges that don't list a coin.
const KRAKEN = { BTC: 'XBTUSD', DOGE: 'XDGUSD' }; // Kraken's own names; others are <COIN>USD
const unsup = {}; // 'src|COIN' -> retry-after ms
const isUnsup = k => unsup[k] && Date.now() < unsup[k];
const markUnsup = (k, e) => { if (/-> (400|404|422)|Unknown|not found|unknown|invalid/i.test(String(e && e.message || e))) unsup[k] = Date.now() + 6 * 3600e3; };
let hlMids = { t: 0, v: null, p: null };
function hyperMids() { // Hyperliquid: every coin's live price in one call
  if (hlMids.v && Date.now() - hlMids.t < 3e3) return Promise.resolve(hlMids.v);
  if (hlMids.p) return hlMids.p;
  hlMids.p = req('https://api.hyperliquid.xyz/info', { method: 'POST', body: { type: 'allMids' } })
    .then(v => { hlMids = { t: Date.now(), v, p: null }; return v; }, e => { hlMids.p = null; throw e; });
  return hlMids.p;
}
const pxCache = {}, PX_TTL = env.BOT_TEST === '1' ? 0 : 3e3;
function exchangePrices(product) { // shared for ~3s so the 15-min and hourly scans don't double-ask the exchanges
  const c = pxCache[product]; if (c && (c.p || Date.now() - c.t < PX_TTL)) return c.p || Promise.resolve(c.v);
  const p = exchangePricesNow(product).then(v => { pxCache[product] = { t: Date.now(), v }; return v; }, e => { delete pxCache[product]; throw e; });
  pxCache[product] = { t: 0, p }; return p;
}
async function exchangePricesNow(product) {
  const coin = product.split('-')[0], H = { 'User-Agent': 'kalshi-bot' };
  const kr = KRAKEN[coin] || coin + 'USD', bs = coin.toLowerCase() + 'usd';
  const src = (name, fn) => isUnsup(name + '|' + coin) ? Promise.reject(new Error('unsupported')) : fn().catch(e => { markUnsup(name + '|' + coin, e); throw e; });
  const tries = await Promise.allSettled([
    src('coinbase', () => req(`https://api.exchange.coinbase.com/products/${product}/ticker`, { headers: H }).then(t => ({ src: 'coinbase', px: Number(t.price), at: Date.parse(t.time) }))),
    src('kraken', () => req(`https://api.kraken.com/0/public/Ticker?pair=${kr}`, { headers: H }).then(t => { if (t.error && t.error.length) throw new Error(t.error.join(',')); const k = Object.values(t.result || {})[0]; return { src: 'kraken', px: Number(k && k.c && k.c[0]), at: Date.now() }; })),
    src('bitstamp', () => req(`https://www.bitstamp.net/api/v2/ticker/${bs}/`, { headers: H }).then(t => ({ src: 'bitstamp', px: Number(t.last), at: Number(t.timestamp) * 1000 }))),
    src('gemini', () => req(`https://api.gemini.com/v1/pubticker/${bs}`, { headers: H }).then(t => ({ src: 'gemini', px: Number(t.last), at: Number(t.volume && t.volume.timestamp) || Date.now() }))),
    coin === 'BTC' || coin === 'ETH' ? Promise.reject(new Error('enough')) : hyperMids().then(v => ({ src: 'hyperliquid', px: Number(v && v[coin]), at: Date.now() })), // extra source for the smaller coins
  ]);
  return tries.filter(x => x.status === 'fulfilled' && x.value.px > 0).map(x => x.value);
}
// 1-minute candles, newest first, Coinbase format [time, low, high, open, close, vol]; Hyperliquid fills in for coins Coinbase lacks
async function candles1m(product) {
  const coin = product.split('-')[0], H = { 'User-Agent': 'kalshi-bot' };
  if (!isUnsup('cbc|' + coin)) {
    try { const v = await req(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=60`, { headers: H }); if (Array.isArray(v) && v.length > 100) return v; }
    catch (e) { markUnsup('cbc|' + coin, e); }
  }
  const end = Date.now(), rows = await req('https://api.hyperliquid.xyz/info', { method: 'POST', body: { type: 'candleSnapshot', req: { coin, interval: '1m', startTime: end - 301 * 60e3, endTime: end } } });
  return (rows || []).map(k => [Math.floor(k.t / 1000), Number(k.l), Number(k.h), Number(k.o), Number(k.c), Number(k.v)]).reverse();
}

// Live read of one coin: fair price across exchanges, momentum, volatility regime, data freshness.
async function coinState(product) {
  const [prices, c] = await Promise.all([
    exchangePrices(product),
    (S.candles[product] && Date.now() - S.candles[product].t < 30e3) ? S.candles[product].v
      : candles1m(product).then(v => { S.candles[product] = { t: Date.now(), v }; return v; }),
  ]);
  const candles = c.slice().reverse(); // oldest -> newest: [time, low, high, open, close, vol]
  const r = []; for (let i = 1; i < candles.length; i++) r.push(Math.log(candles[i][4] / candles[i - 1][4]));
  const freshP = prices.filter(x => !(x.at > 0) || Date.now() - x.at < 30e3); // stale exchanges are dropped, not averaged in
  let pool = (freshP.length ? freshP : prices).slice();
  const med = a => { const v = a.map(x => x.px).sort((x, y) => x - y); return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2; };
  const thr = /^(BTC|ETH)-/.test(product) ? 0.002 : 0.005, dropped = [];
  const spr = a => { const v = a.map(x => x.px); return (Math.max(...v) - Math.min(...v)) / med(a); };
  { // exchanges off from the rest (thin book, perp premium): leave them out instead of pausing the coin,
    // but only while a clear majority still agrees — a real split keeps the coin paused
    let p2 = pool.slice(); const n0 = pool.length, out = [];
    while (p2.length >= 3 && spr(p2) > thr && p2.length - 1 > n0 / 2) {
      const srt = p2.slice().sort((a, b) => a.px - b.px), noLo = srt.slice(1), noHi = srt.slice(0, -1);
      const dropHi = spr(noHi) <= spr(noLo); out.push(dropHi ? srt[srt.length - 1].src : srt[0].src); p2 = dropHi ? noHi : noLo;
    }
    if (p2.length >= 2 && spr(p2) <= thr && out.length) { dropped.push(...out); pool = p2; }
  }
  const pxs = pool.map(x => x.px).sort((a, b) => a - b);
  const spot = !pxs.length ? NaN : pxs.length % 2 ? pxs[(pxs.length - 1) / 2] : (pxs[pxs.length / 2 - 1] + pxs[pxs.length / 2]) / 2; // median across exchanges
  const sig1h = sd(r.slice(-60)), sig5h = sd(r.slice(-300)), sig15 = sd(r.slice(-15));
  const sig = Math.sqrt((sig1h * sig1h + sig5h * sig5h) / 2) * CFG.VOL_MULT; // blend, not max (max overstates swings)
  const nowS = Date.now() / 1000;
  // price N minutes ago, looked up by timestamp (candles can lag a couple of minutes)
  const pxAgo = n => { const target = nowS - n * 60; let best = candles[0]; for (const k of candles) if (k[0] <= target) best = k; return best[4]; };
  const ret = n => Math.log(spot / pxAgo(n));
  const freshest = Math.max(...prices.map(x => x.at || 0));
  const major = /^(BTC|ETH)-/.test(product);
  const st = {
    product, spot, sig, sig15, sig5h, sources: pool.map(x => x.src), dropped, allPx: prices.map(x => `${x.src}=${x.px}`).join(' '),
    r5: ret(5), r15: ret(15),
    ageSec: Math.max(0, Math.round((Date.now() - freshest) / 1000)),
    candleLagSec: Math.round(nowS - candles[candles.length - 1][0]),
    spreadPct: pxs.length > 1 ? (pxs[pxs.length - 1] - pxs[0]) / spot : 0,
  };
  st.z5 = st.r5 / (sig * Math.sqrt(5)); st.z15 = st.r15 / (sig * Math.sqrt(15));
  st.problems = [];
  if (!(spot > 0) || r.length < 100) st.problems.push('price data missing');
  if (pool.length < 2) st.problems.push(`only ${pool.length} live exchange price${pool.length === 1 ? '' : 's'} available`);
  if (st.ageSec > 30) st.problems.push(`live price ${st.ageSec}s old`);
  if (st.candleLagSec > 600) st.problems.push(`price history ${Math.round(st.candleLagSec / 60)} min behind`);
  if (st.spreadPct > thr) st.problems.push(`exchanges disagree ${(st.spreadPct * 100).toFixed(2)}%`); // small coins trade on thinner books
  if (Math.abs(st.z5) > 4 && Math.abs(st.r5) > CFG.SHOCK_PCT * (major ? 1 : 1.5)) st.problems.push(`sudden ${st.r5 > 0 ? 'spike' : 'drop'} ${(st.r5 * 100).toFixed(2)}% in 5 min`);
  if (sig15 > 2.5 * sig5h) st.problems.push('volatility spiking');
  return st;
}
const activeCoins = () => [...new Set(['BTC', 'ETH', ...CFG.SERIES.map(coinOf).filter(Boolean)])];
async function marketConditions() {
  const coins = activeCoins();
  const res = await Promise.allSettled(coins.map(c => coinState(c + '-USD')));
  const out = {};
  coins.forEach((c, i) => {
    const p = c + '-USD';
    out[p] = res[i].status === 'fulfilled' ? res[i].value
      : { product: p, spot: NaN, sig: NaN, sig15: 0, sig5h: 0, sources: [], r5: 0, r15: 0, z5: 0, z15: 0, ageSec: 0, problems: ['price data missing'] };
  });
  // crypto moves together: a shock in BTC or ETH blocks every coin; a smaller coin's own shock blocks only that coin
  const own = {}; for (const l of ['BTC', 'ETH']) own[l] = (out[l + '-USD'] ? out[l + '-USD'].problems : []).filter(x => /sudden|spiking/.test(x)); // read before cross-adding
  for (const leader of ['BTC', 'ETH']) {
    const sh = own[leader]; if (!sh.length) continue;
    for (const p of Object.keys(out)) if (p !== leader + '-USD') out[p].problems.push(`${leader} ${sh[0]}`);
  }
  return out;
}
const otherOf = (cond, product) => cond[product === 'BTC-USD' ? 'ETH-USD' : 'BTC-USD'] || cond[product]; // BTC is compared with ETH, everything else with BTC
const pct = x => Math.abs(x) < 5e-5 ? '0.00%' : (x > 0 ? '+' : '−') + Math.abs(x * 100).toFixed(2) + '%';
function condLine(st, other) {
  const regime = st.sig15 > 1.5 * st.sig5h ? 'choppy' : st.sig15 < 0.6 * st.sig5h ? 'quiet' : 'normal';
  return `${st.product.split('-')[0]} 5m ${pct(st.r5)} · 15m ${pct(st.r15)} · vol ${regime} · ${other.product.split('-')[0]} ${other.problems.length ? '⚠️' : 'calm'} · price from ${st.sources.length} exchanges, ${st.ageSec}s old`;
}

// Full analysis of one Kalshi market given live conditions. Returns per-side verdicts.
function evaluate(m, st, now = Date.now()) {
  const mins = (new Date(m.close_time).getTime() - now) / 60000;
  const T = Math.max(mins - 2 / 3, 0.25); // Kalshi settles on a 60-second average, which cuts the last minute's variance
  // apply what the research engine proved on recent data (momentum / reversion tilt and volatility scale)
  const fastM = isFast(String(m.event_ticker || m.ticker || '').split('-')[0]);
  const L = ((S.learn || {})[String(st.product).split('-')[0]] || {})[fastM ? 'm15' : 'h1'];
  const useL = L && L.adopt;
  const sig = st.sig * (useL ? L.mult : 1);
  const tilt = useL ? L.k * (fastM ? st.r5 : st.r15) * Math.min(mins, 15) / 10 : 0;
  const spot = st.spot * Math.exp(tilt);
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
    s.mins = mins; s.spread = spread; s.spot = st.spot; s.sig = sig;
    s.pb = W * s.raw + (1 - W) * s.mkt;                 // model/market blend
    s.p = s.mkt + calLam() * (s.pb - s.mkt);           // self-calibrated: shrunk toward the market by what real results showed
    s.edge = s.p - s.ask - (0.07 * s.ask * (1 - s.ask) + 0.005);
    // which way does this bet need the price to move?
    const up = sty.startsWith('greater') ? s.side === 'yes' : sty.startsWith('less') ? s.side === 'no' : null;
    s.reasons = [...st.problems];
    const ev = eventPause(); if (ev) s.reasons.push(`event pause: ${ev}`);
    s.tilt = tilt;
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

// ---------- self-calibration from real results ----------
// Every alert stores (blend probability, market price, outcome). The bot fits how much of its own
// disagreement with the market actually came true (λ: 0 = market is always right, 1 = trust the model fully).
// Seeded with the first 35 graded live alerts (Nov 22 2026): model was ~6 pts too confident.
const CAL_SEED = [[50,41,1],[48,40,0],[48,40,0],[33,25,0],[50,41,1],[59,51,0],[51,42,1],[41,33,1],[46,37,0],[47,38,0],[26,17,0],[30,21,1],[23,15,1],[29,20,0],[59,50,1],[91,83,1],[45,36,1],[55,47,1],[40,31,0],[37,29,0],[34,26,0],[42,37,0],[24,20,0],[14,9,0],[18,13,0],[17,13,0],[14,10,0],[53,44,1],[56,47,0],[33,25,1],[45,37,0],[37,29,0],[30,21,0],[41,33,0],[23,15,0]];
function calLam() { return CFG.CAL === 1 && S.cal && S.cal.lam >= 0 ? S.cal.lam : 1; }
function fitCal() {
  const seed = env.BOT_TEST === '1' && !S.testSeed ? [] : CAL_SEED.map(([p, m, y]) => [p * 10, m * 10, y]);
  const h = seed.concat(S.sc.hist || []).slice(-300);
  if (h.length < 30) return null;
  const brier = lam => h.reduce((a, [p, m, y]) => { const q = (m + lam * (p - m)) / 1000; return a + (q - y) ** 2; }, 0) / h.length;
  const b1 = brier(1); let best = 1, bb = b1;
  for (let l = 0; l <= 1.25 + 1e-9; l += 0.05) { const b = brier(l); if (b < bb - 1e-6) { bb = b; best = Math.round(l * 100) / 100; } }
  if (bb > b1 * (1 - 0.005)) best = 1; // same bar as the research engine: change only on a real (0.5%+) accuracy gain
  const hit = h.reduce((a, x) => a + x[2], 0) / h.length, said = h.reduce((a, x) => a + x[0], 0) / h.length / 1000, mkt = h.reduce((a, x) => a + x[1], 0) / h.length / 1000;
  return { lam: best, n: h.length, hit, said, mkt, at: Date.now() };
}
async function refitCal(announce = true) {
  const r = fitCal(); if (!r) return;
  const before = calLam(); S.cal = r;
  if (announce && CFG.CAL === 1 && Math.abs(r.lam - before) >= 0.1) await say(`🧠 SELF-CALIBRATION · last ${r.n} graded picks: bot said ${Math.round(r.said * 100)}% on average, market said ${Math.round(r.mkt * 100)}%, reality ${Math.round(r.hit * 100)}%.\nNow trusting its own math ${Math.round(r.lam * 100)}% (was ${Math.round(before * 100)}%) — it only trades where an edge survives that.`);
}
const calText = () => S.cal ? `🎯 Self-calibration: last ${S.cal.n} picks — bot said ${Math.round(S.cal.said * 100)}%, market ${Math.round(S.cal.mkt * 100)}%, actual ${Math.round(S.cal.hit * 100)}% → trusting its own math ${Math.round(calLam() * 100)}%` : '🎯 Self-calibration: collecting results';

// ---------- scan ----------
function eventPause() {
  const cal = env.BOT_TEST === '1' && !S.testCal ? null : news.calendarPause();
  if (cal) return cal;
  if (Date.now() < S.newsPauseUntil) return `news: ${S.newsPauseWhy}`;
  return null;
}
function recapReason(w) {
  if (w.traded && w.traded !== true) return `✅ bought ${w.traded.n} ${w.traded.side.toUpperCase()} @ ${cents(w.traded.px)}`;
  if (w.traded === true) return '✅ traded';
  if (w.blocked && !w.best) return `⏸ paused — ${w.blocked}`;
  if (S.led.fastOff && CFG.AUTO_FAST === 1) return '🛑 auto stopped today — /auto15 on to restart';
  if (w.bid) return `📋 bid ${w.bid.n} ${w.bid.side.toUpperCase()} @ ${cents(w.bid.q)} — no seller came (no cost)`;
  if (w.skip) return `⏭ ${w.skip}`;
  if (!w.best) return '⏭ no tradable price seen';
  const r = (w.best.reasons || []).filter(x => !/^edge .* below/.test(x));
  const edge = `best edge ${w.best.edge >= 0 ? '+' : ''}${(w.best.edge * 100).toFixed(1)}¢ (needs ${(CFG.AUTO_EDGE * 100).toFixed(0)}¢)`;
  return r.length ? `⏭ ${r[0].replace(/ — market likely knows something/, '')}` : `⏭ no edge — ${edge}${S.led.safe ? ' · 🛡 safe mode' : ''}`;
}
async function windowRecap() {
  const done = Object.entries(S.win).filter(([, w]) => Date.now() > w.close + 15e3);
  if (!done.length) return;
  const lines = done.sort((a, b) => a[1].close - b[1].close).map(([k, w]) => `${w.label}: ${recapReason(w)}`);
  for (const [k] of done) delete S.win[k];
  await say(`⏱ WINDOW RECAP\n${lines.join('\n')}`);
}
// daily markets settle at 5 PM ET; the same Kalshi series also runs one event every hour
const etHour = iso => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map(x => [x.type, x.value])); return [+p.hour, +p.minute]; };
const isDailyClose = iso => { const [h, mi] = etHour(iso); return h === 17 && mi === 0; };
const laneOf = (eventTicker, closeIso) => { const ser = String(eventTicker).split('-')[0]; return `${coinOf(ser)}|${isFast(ser) ? 'm15' : isDailyClose(closeIso) ? 'd1' : 'h1'}`; };
const laneName = k => { const [c, t] = k.split('|'); return `${c} ${{ m15: '15-min', h1: 'hourly', d1: 'daily' }[t] || t}`; };
const laneState = k => (S.lanes[k] = S.lanes[k] || { r: [], bar: 0, bench: 0 });
const laneBar = k => CFG.LEARN === 1 ? (laneState(k).bar || 0) : 0;
const laneBenched = k => CFG.LEARN === 1 && Date.now() < (laneState(k).bench || 0);
// money already sitting in open auto positions (not yet settled)
const openCost = () => (S.led.auto || []).filter(x => !x.done && Date.now() < x.c + 30 * 60e3).reduce((a, x) => a + (x.cost || 0), 0);
S.emptyUntil = {};
// ---------- limit bids (maker) ----------
// Instead of paying the ask (+ the full taker fee), post a bid 1¢ above the best bid, never above
// calibrated-probability − MAKER_EDGE − maker fee, never touching the ask. Re-checked every scan:
// cancelled the moment the edge is gone, conditions turn bad, or the window gets close.
const resv = a => CFG.RESERVE_SCALE === 1 ? Math.min(CFG.RESERVE, Math.max(0.25, 0.1 * (a.cash + (a.exposure || 0)))) : CFG.RESERVE;
const makerFee = q => Math.ceil(0.0175 * q * (1 - q) * 100) / 100; // Kalshi maker fee where charged (¼ of taker) — assumed on all
function makerQuote(v) {
  if (!v || v.reasons.some(r => !/^edge .* below/.test(r) && !/^price .* outside/.test(r))) return null;
  const bid = Math.max(0, v.ask - v.spread);
  const cap = Math.floor((v.p - CFG.MAKER_EDGE - 0.0175 * v.p * (1 - v.p)) * 100 + 1e-9) / 100;
  const q = Math.min(Math.round((bid + 0.01) * 100) / 100, cap, Math.round((v.ask - 0.01) * 100) / 100);
  if (!(q >= CFG.MIN_PRICE && q <= CFG.MAX_PRICE)) return null;
  const edge = v.p - q - makerFee(q);
  return edge >= CFG.MAKER_EDGE - 1e-9 ? { q, edge } : null;
}
// half-Kelly stake on the calibrated edge, capped by tradepct of the whole account
function stakeFor(p, q, equity) {
  const cap = equity * CFG.TRADE_PCT;
  if (!(CFG.KELLY > 0)) return cap;
  const f = Math.max(0, (p - q) / (1 - q)) * CFG.KELLY;
  return Math.max(Math.min(cap, equity * f), q + 0.02); // at least one contract when the edge is real
}
const restingCost = () => Object.values(S.rest || {}).reduce((a, o) => a + Math.max(0, o.n - (o.filled || 0)) * (o.q + makerFee(o.q)), 0);
const restingFor = ev => Object.values(S.rest || {}).find(o => o.ev === ev);
async function postBid(m, v, q, n, product) {
  const idx = Number.isInteger(m.exchange_index) ? m.exchange_index : 0;
  await ensureShardFunds(idx, n * (q + makerFee(q)) + 0.02);
  const fast = isFast(m.event_ticker.split('-')[0]), close = Date.parse(m.close_time);
  const stopAt = close - (fast ? CFG.FAST_MIN_MINUTES : CFG.MIN_MINUTES) * 60e3;
  const exp = Math.floor(Math.min(stopAt, Date.now() + CFG.MAKER_TTL_MIN * 60e3) / 1000);
  const body = { ticker: m.ticker, side: v.side === 'yes' ? 'bid' : 'ask', count: n + '.00', price: (v.side === 'yes' ? q : 1 - q).toFixed(4),
    time_in_force: 'good_till_canceled', expiration_time: exp, post_only: true, self_trade_prevention_type: 'taker_at_cross',
    client_order_id: 'kbot-' + crypto.randomUUID(), exchange_index: idx };
  const o = await kalshi('POST', '/portfolio/events/orders', body);
  log('BID', JSON.stringify(body), '->', JSON.stringify(o));
  acctCache = null;
  S.rest[o.order_id] = { id: o.order_id, t: m.ticker, ev: m.event_ticker, side: v.side, n, q, p: Math.round(v.p * 1000) / 1000, pb: Math.round((v.pb ?? v.p) * 1000), mk: Math.round(v.mkt * 1000),
    placed: Date.now(), exp: exp * 1000, stop: stopAt, close, idx, filled: 0, cost: 0, fees: 0, product, cond: '' };
  if (num(o.fill_count) > 0) await recordBidFills(S.rest[o.order_id]); // crossed anyway (book moved) — count it
  await saveSettings().catch(() => {});
}
// pull this order's fills from Kalshi and book any new ones (ledger, receipt, scorecard)
async function recordBidFills(o) {
  const fills = await pageAll(`/portfolio/fills?order_id=${o.id}`, 'fills');
  let n = 0, cost = 0, fees = 0;
  for (const f of fills) { const c = num(f.count_fp ?? f.count); const px = o.side === 'yes' ? num(f.yes_price_dollars) : num(f.no_price_dollars); n += c; cost += c * px; fees += d(f, 'fee_cost') || 0; }
  if (!(n > (o.filled || 0) + 1e-9)) return false;
  const dn = n - (o.filled || 0), dCost = cost - (o.cost || 0), dFee = fees - (o.fees || 0), total = dCost + dFee, px = dn > 0 ? dCost / dn : o.q;
  o.filled = n; o.cost = cost; o.fees = fees;
  await rollDay(String(startOfTodayCT()));
  S.led.spent += total; S.led.n++; S.led.nAuto++; S.led.fees += dFee;
  if (isFast(o.ev.split('-')[0])) S.led.fast = (S.led.fast || 0) + total;
  const prev = S.led.auto.find(x => x.oid === o.id);
  if (prev) { prev.n += dn; prev.cost = Math.round((prev.cost + total) * 100) / 100; }
  else { S.led.auto.push({ t: o.t, s: o.side[0], n: dn, cost: Math.round(total * 100) / 100, c: o.close, oid: o.id }); if (S.led.auto.length > 30) S.led.auto.shift(); }
  if (!S.sc.open.some(x => x.t === o.t)) { S.sc.open.push({ t: o.t, s: o.side[0], p: o.p, pb: o.pb, mk: o.mk, a: o.q, c: o.close }); if (S.sc.open.length > 25) S.sc.open.shift(); }
  if (S.win[o.ev]) S.win[o.ev].traded = { side: o.side, px, n: o.filled };
  acctCache = null;
  const fast = isFast(o.ev.split('-')[0]);
  await say(`🟢🤖 LIMIT BUY FILLED · ${label(o.t)}\n` +
    `🎟 ${Math.round(dn * 100) / 100} ${o.side.toUpperCase()}${fast ? (o.side === 'yes' ? ' (⬆️ up)' : ' (⬇️ down)') : ''} @ ${cents(px)} = ${money(total)} (fee ${money(dFee)}) · bid, not ask 💡\n` +
    `🎯 Win chance ${Math.round(o.p * 100)}% · paid ${cents(px)} · edge +${((o.p - px - dFee / Math.max(dn, 1)) * 100).toFixed(1)}¢\n` +
    `✅ Win pays ${money(dn)} (+${money(dn - total)}) · ❌ lose −${money(total)}`);
  await saveSettings().catch(() => {});
  return true;
}
async function cancelBid(o, why) {
  try { const r = await kalshi('DELETE', `/portfolio/events/orders/${o.id}?market_ticker=${encodeURIComponent(o.t)}`); log('CANCEL', o.id, o.t, why, JSON.stringify(r)); }
  catch (e) { if (!/404|not.?found/i.test(e.message)) { log('cancel failed', o.id, e.message); return false; } }
  try { await recordBidFills(o); } catch (e) { log('fills check failed', e.message); }
  if (S.win[o.ev] && !S.win[o.ev].traded) S.win[o.ev].bid = { side: o.side, q: o.q, n: o.n, why };
  delete S.rest[o.id]; await saveSettings().catch(() => {});
  return true;
}
// every fast scan: book fills, then keep / cancel each resting bid against the latest prices
async function manageBids(latest, fast) {
  for (const o of Object.values(S.rest || {}).filter(x => isFast(x.ev.split('-')[0]) === !!fast)) {
    try {
      await recordBidFills(o);
      if ((o.filled || 0) >= o.n - 1e-9) { delete S.rest[o.id]; await saveSettings().catch(() => {}); continue; }
      const now = Date.now(), v = latest[o.t + '|' + o.side];
      let why = null;
      if (now >= o.stop) why = 'window closing';
      else if (now >= o.exp - 5e3) why = 'time to re-check';
      else if (S.paused) why = 'bot paused';
      else if (!v) { if (now - o.placed > 30e3) why = 'market not seen'; }
      else if (v.reasons.some(r => !/^edge .* below/.test(r) && !/^price .* outside/.test(r))) why = v.reasons.find(r => !/^edge .* below/.test(r) && !/^price .* outside/.test(r)).replace(/ — market likely knows something/, '');
      else if (v.p - o.q - makerFee(o.q) < CFG.MAKER_EDGE / 2) why = 'edge gone';
      else if (v.ask - v.spread > o.q + 0.005 && now - o.placed > 20e3) { const mq = makerQuote(v); if (mq && mq.q > o.q) why = 'outbid — re-posting higher'; }
      if (env.BOT_DEBUG_BIDS === '1') log('BIDCHK', o.id, why, v ? JSON.stringify({ p: v.p, ask: v.ask, sp: v.spread, r: v.reasons }) : 'no v');
      if (why) await cancelBid(o, why);
    } catch (e) { log('manage bid failed', o.id, e.message); }
  }
}
async function scan(fast) {
  if (!KEY_ID || !SIGN_KEY || !OWNER) return;
  if (S.paused) { for (const o of Object.values(S.rest || {})) await cancelBid(o, 'bot paused').catch(() => {}); return; }
  const now = Date.now();
  for (const [k, v] of Object.entries(S.recentAlerts)) if (now - v > 3 * 3600e3) delete S.recentAlerts[k];
  for (const [k, v] of Object.entries(S.pending)) if (now - v.created > 3600e3) delete S.pending[k];

  const a = await account();
  let remaining = a.dayCap - a.spent;
  if (env.BOT_DEBUG === '1') log('BUDGET', JSON.stringify({ dayCap: a.dayCap, spent: a.spent, cash: a.cash }));
  if (remaining < 0.5) return;

  const evp = eventPause();
  if (!!evp !== !!S.evpOn) { S.evpOn = evp; await say(evp ? `⏸📅 Trading paused — ${evp}. Resumes automatically.` : '▶️ Event pause over — trading resumed.'); }
  const lane = CFG.SERIES.filter(x => isFast(x) === !!fast && !(S.emptyUntil[x] > Date.now()));
  const [cond, lists] = await Promise.all([marketConditions(), Promise.all(lane.map(x => pageAll(`/markets?series_ticker=${x}&status=open`, 'markets').catch(e => { log('markets failed', x, e.message); return null; })))]);
  const cands = [], freshWin = new Set(), latest = {}; // windows re-priced in THIS scan (always-in only uses this scan's prices)
  S.lastCond = cond;
  for (const [si, series] of lane.entries()) {
    const product = CFG.SPOT[series]; if (!product || !cond[product]) continue;
    const markets = lists[si]; if (!markets) continue;
    if (!S.seen[series]) { S.seen[series] = 1; log('SERIES', series, 'open markets:', markets.length); }
    S.emptyN = S.emptyN || {};
    if (!markets.length) { // Kalshi has nothing open here: after 5 empty looks, check less often (never for BTC/ETH)
      S.emptyN[series] = (S.emptyN[series] || 0) + 1;
      if (S.emptyN[series] >= 5 && !(S.everHad || {})[series] && !/^KX(BTC|ETH)/.test(series)) { S.emptyN[series] = 0; S.emptyUntil[series] = Date.now() + (fast ? 1 : 5) * 60e3; } // only series that never had a market
      continue;
    }
    S.emptyN[series] = 0; (S.everHad = S.everHad || {})[series] = 1;
    const lo = isFast(series) ? CFG.FAST_MIN_MINUTES : CFG.MIN_MINUTES, hi = isFast(series) ? CFG.FAST_MAX_MINUTES : CFG.MAX_MINUTES;
    const dailyOK = CFG.DAILY === 1 && a.cash + (a.exposure || 0) >= CFG.DAILY_MIN_EQUITY;
    const inWindow = (m, mins) => (mins >= lo && mins <= hi) || (!isFast(series) && dailyOK && mins >= lo && mins <= 1440 && isDailyClose(m.close_time));
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
    if (cond[product].problems.length && isFast(series)) S.stats.last15[series] = { blocked: cond[product].problems.join('; '), at: Date.now() };
    if (cond[product].problems.length) for (const m of markets) { const mins = (Date.parse(m.close_time) - now) / 60000; if (inWindow(m, mins)) { const W1 = S.win[m.event_ticker] || (S.win[m.event_ticker] = { label: label(m.ticker).replace(/ ≥ \$[\d,.]+/, ''), series, close: Date.parse(m.close_time), best: null }); W1.blocked = cond[product].problems[0]; } }
    if (cond[product].problems.length) { if (env.BOT_DEBUG === '1') log('COND', product, cond[product].problems.join('; '));
      S.condWarn = S.condWarn || {}; if (!S.condWarn[product] || Date.now() - S.condWarn[product] > 15 * 60e3) { S.condWarn[product] = Date.now(); log('CONDITIONS BLOCK', product, cond[product].problems.join('; '), '|', cond[product].allPx || ''); } continue; }
    for (const m of markets) if (S.win[m.event_ticker]) S.win[m.event_ticker].close = Date.parse(m.close_time); // keep recap timing in sync with Kalshi
    for (let m of markets) {
      const mins = (new Date(m.close_time).getTime() - now) / 60000;
      if (!inWindow(m, mins)) continue;
      const W0 = S.win[m.event_ticker] || (S.win[m.event_ticker] = { label: label(m.ticker).replace(/ ≥ \$[\d,.]+/, ''), series, close: Date.parse(m.close_time), best: null });
      if (!freshWin.has(m.event_ticker)) { freshWin.add(m.event_ticker); W0.bestV = null; W0.mk = null; }
      const lk = laneOf(m.event_ticker, m.close_time);
      if (laneBenched(lk)) { W0.blocked = W0.blocked || `🧠 ${laneName(lk)} benched — losing lately, self-learning sits it out until ${timeCT(new Date(laneState(lk).bench).toISOString())}`; continue; }
      if (a.held.has(m.event_ticker) || S.sc.ev[m.event_ticker]) { W0.traded = W0.traded || true; if (isFast(series)) S.stats.last15[series] = { t: m.ticker, done: true, mins, at: Date.now() }; continue; } // ONE trade per window
      if (isFast(series)) {
        try { m = await withLiveQuote(m); } catch (e) { log('orderbook failed', m.ticker, e.message); }
        const vs = evaluate(m, cond[product], now), best = vs.slice().sort((x, y) => y.edge - x.edge)[0];
        if (best) S.stats.last15[series] = { t: m.ticker, side: best.side, raw: best.raw, mkt: best.mkt, p: best.p, ask: best.ask, edge: best.edge, mins, reasons: best.reasons.concat(best.edge < CFG.AUTO_EDGE && CFG.AUTO_FAST === 1 && best.ok ? [`edge ${(best.edge * 100).toFixed(1)}¢ below auto bar ${(CFG.AUTO_EDGE * 100).toFixed(0)}¢`] : []), at: Date.now() };
      }
      const verdicts = evaluate(m, cond[product], now);
      for (const v of verdicts) {
        latest[m.ticker + '|' + v.side] = v;
        if (CFG.MAKER === 1) { const mq = makerQuote(v); if (mq && (!W0.mk || mq.edge > W0.mk.edge)) W0.mk = { ...mq, v, m, product }; }
        if (env.BOT_DEBUG === '1') log('EVAL', m.ticker, v.side, JSON.stringify({ raw: v.raw, mkt: v.mkt, p: v.p, ask: v.ask, edge: v.edge, reasons: v.reasons }));
        if (!W0.best || v.edge > W0.best.edge) W0.best = { edge: v.edge, side: v.side, reasons: v.reasons.slice(0, 2) };
        if (!W0.bestV || v.edge > W0.bestV.edge) W0.bestV = { ...v, m, product, at: now, cond: condLine(cond[product], otherOf(cond, product)) };
      }
      for (const v of verdicts) if (v.ok) cands.push({ m, product, ...v, cond: condLine(cond[product], otherOf(cond, product)) });
    }
  }
  for (const [k, v] of Object.entries(S.sc.ev)) if (v < Date.now() - 60e3) delete S.sc.ev[k];
  // always-in: every open window without a qualifying trade gets its better side, if not negative after fees
  if (CFG.ALWAYS_IN === 1 && !S.led.safe && CFG.MAKER !== 1) { // with limit bids on, "always in" = a resting bid in every window (below)
    const have = new Set(cands.map(c => c.m.event_ticker));
    for (const [ev, w] of Object.entries(S.win)) {
      const v = w.bestV; if (!v || have.has(ev) || w.traded || isFast(w.series) !== !!fast || Date.now() - v.at > 30e3) continue;
      if (a.held.has(ev) || S.sc.ev[ev]) continue;
      if (laneBar(laneOf(ev, v.m.close_time)) > 0) continue; // self-learning: this market type lost lately, so only real edges count
      const blockers = v.reasons.filter(r => !/^edge .* below/.test(r)); // price range applies: no 10¢ long shots (they lost 7 of 7 live)
      if (blockers.length || v.edge < CFG.ALWAYS_EDGE / 100) continue;
      cands.push({ ...v, always: true });
    }
  }
  cands.sort((x, y) => y.edge - x.edge);
  const openBefore = S.sc.open.length;
  const used = new Set(); let sent = 0;
  for (const c of cands) {
    if (sent >= CFG.MAX_ALERTS_PER_RUN) break;
    if (used.has(c.m.event_ticker) || restingFor(c.m.event_ticker)) continue;
    const fastSeries = isFast(c.m.event_ticker.split('-')[0]);
    const autoFast = fastSeries && CFG.AUTO_FAST === 1 && !S.led.fastOff;
    const autoHour = !fastSeries && CFG.AUTO_HOURLY === 1 && !S.led.fastOff;
    const auto = S.unlocked || autoFast || autoHour;
    if (!auto && S.led.fastOff) continue; // loss stop hit: stay quiet until tomorrow (no tap alerts either)
    const bar = laneBar(laneOf(c.m.event_ticker, c.m.close_time));
    if (S.led.safe && c.always) continue; // safe mode: only real edges
    let limit = null;
    if ((autoFast || autoHour) && !S.unlocked) {
      if (!c.m._live) { // hourly list prices can lag: re-price from the live book before trading
        try {
          const live = await withLiveQuote(c.m); const v = evaluate(live, S.lastCond[c.product]).find(x => x.side === c.side);
          const blocked = !v || (c.always ? v.reasons.some(r => !/^edge .* below/.test(r)) || v.edge < CFG.ALWAYS_EDGE / 100 : !v.ok);
          if (blocked) continue; Object.assign(c, v, { m: live });
        } catch (e) { continue; }
      }
      if (!c.always && c.edge < CFG.AUTO_EDGE + bar) continue;    // full-size auto needs the bigger edge (+ whatever this market type has to earn back)
      limit = c.always ? bestLimit(c.p, c.ask, CFG.ALWAYS_EDGE / 100, fastSeries ? CFG.AUTO_GRACE : 0.02) : bestLimit(c.p, c.ask, CFG.AUTO_EDGE / 2, fastSeries ? CFG.AUTO_GRACE : 0.02);
      if (limit === null) continue;
    } else if (auto) {
      limit = bestLimit(c.p, c.ask, CFG.MIN_EDGE / 2, fastSeries ? CFG.AUTO_GRACE : 0.01); if (limit === null) continue;
    }
    // size within: per-trade cap, today's remaining budget, AND the cash actually in the wallet (fees + slippage included)
    const worst = limit || Math.min(c.ask + CFG.MAX_SLIPPAGE, 0.99);
    const fastLeft = autoFast && !S.unlocked && CFG.FAST_DAY > 0 ? CFG.FAST_DAY - (S.led.fast || 0) : Infinity;
    const oc = (a.exposure !== null && a.exposure !== undefined ? a.exposure : openCost()) + restingCost(), room = CFG.MAX_OPEN_PCT * (a.cash + oc) - oc; // never tie up more than MAX_OPEN_PCT of the money at once
    const W1 = S.win[c.m.event_ticker], skip = why => { if (W1 && !W1.traded) W1.skip = why; };
    if (auto && room < 0.15 && a.cash - resv(a) >= 0.5) { skip(`🔒 ${money(oc)} already in open bets (max ${Math.round(CFG.MAX_OPEN_PCT * 100)}% of money)`); if (Date.now() - (S.roomWarned || 0) > 60 * 60e3) { S.roomWarned = Date.now(); log('exposure cap', money(oc), 'open'); } continue; }
    const budget = Math.min(a.tradeCap, remaining, a.cash - restingCost() - Math.max(resv(a), 0.02), fastLeft, auto ? Math.max(room, 0) : Infinity, c.always ? Math.max(0.5, a.cash * CFG.ALWAYS_PCT) : Infinity,
      auto && CFG.KELLY > 0 ? stakeFor(c.p, worst, a.cash + oc) : Infinity);
    let count = Math.floor(budget / worst);
    while (count > 0 && count * worst + feeTotal(count, worst) > budget) count--;
    if (S.led.safe && count > 1) count = 1; // safe mode after a losing day: smallest possible bets
    if (count < 1) skip(`💸 not enough free cash for 1 at ${cents(worst)} (${money(Math.max(0, budget))} usable: wallet ${money(a.cash)}, ${money(resv(a))} kept safe, ${money(oc)} in open bets)`);
    if (auto && count >= 1) { const depth = bookDepth(c.m, c.side, worst); if (depth < count) count = Math.floor(depth); if (count < 1 && c.m._book) { skip(`📉 nobody selling at ≤${cents(worst)}`); S.nlq = S.nlq || {}; if (!S.nlq[c.m.ticker]) { S.nlq[c.m.ticker] = 1; log('no liquidity', c.m.ticker, c.side, worst); } continue; } }
    if (env.BOT_DEBUG === '1') log('SIZE', c.m.ticker, JSON.stringify({ cap: a.tradeCap, remaining, cash: a.cash, worst, count }));
    if (count < 1) { if (a.cash - resv(a) < worst + 0.02 && Date.now() - (S.lowCashWarned || 0) > 30 * 60e3) { S.lowCashWarned = Date.now(); await say(`💸 Wallet low: ${money(a.cash)} (keeping ${money(resv(a))} safe). Trading paused until funds are added on Kalshi — or /set reserve 0.`); } continue; }
    S.sc.open.push({ t: c.m.ticker, s: c.side[0], p: Math.round(c.p * 1000) / 1000, pb: Math.round((c.pb ?? c.p) * 1000), mk: Math.round((c.mkt ?? c.ask) * 1000), a: c.ask, c: Date.parse(c.m.close_time) }); if (S.sc.open.length > 25) S.sc.open.shift();
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
        let r = await placeBuy({ ticker: c.m.ticker, side: c.side, count, price: limit || c.ask, auto: true });
        // grace: if the price ran, re-read the live book and try again while the edge still holds
        for (let k = 1; r.filled === 0 && (autoFast || autoHour) && k < CFG.AUTO_TRIES; k++) {
          await new Promise(res => setTimeout(res, 700));
          let live; try { live = await withLiveQuote(c.m); } catch (e) { break; }
          const v = evaluate(live, S.lastCond[c.product]).find(x => x.side === c.side);
          const need = c.always ? CFG.ALWAYS_EDGE / 100 : CFG.MIN_EDGE;
          if (!v || v.reasons.some(x => !/^edge .* below/.test(x)) || v.edge < need) { log('retry stop', c.m.ticker, v && v.edge); break; }
          const lim = bestLimit(v.p, v.ask, c.always ? need : CFG.AUTO_EDGE / 2, CFG.AUTO_GRACE); if (lim === null) break;
          let n = Math.min(count, Math.floor(bookDepth(live, c.side, lim)));
          while (n > 0 && n * lim + feeTotal(n, lim) > budget) n--;
          if (n < 1) break;
          log('retry', k, c.m.ticker, lim, n);
          r = await placeBuy({ ticker: c.m.ticker, side: c.side, count: n, price: lim, auto: true });
        }
        remaining -= r.total; a.cash -= r.total; if (a.exposure !== null && a.exposure !== undefined) a.exposure += r.total; acctCache = null;
        if (r.filled > 0) {
          if (S.win[c.m.event_ticker]) S.win[c.m.event_ticker].traded = { side: c.side, px: r.px, n: r.filled };
          if (fastSeries) S.led.fast = (S.led.fast || 0) + r.total;
          { S.led.auto.push({ t: c.m.ticker, s: c.side[0], n: r.filled, cost: Math.round(r.total * 100) / 100, c: Date.parse(c.m.close_time) }); if (S.led.auto.length > 30) S.led.auto.shift(); }
          await saveSettings().catch(() => {});
          await say(`🟢🤖 AUTO BUY${c.always ? ' (always-in)' : ''} · ${label(c.m.ticker)}\n` +
            `🎟 ${r.filled} ${c.side.toUpperCase()}${fastSeries ? (c.side === 'yes' ? ' (⬆️ up)' : ' (⬇️ down)') : ''} @ ${cents(r.px)} = ${money(r.total)} (fee ${money(r.fees)})\n` +
            `🎯 Win chance ${Math.round(c.p * 100)}% · paid ${cents(r.px)} · edge +${((c.p - r.px - 0.07 * r.px * (1 - r.px)) * 100).toFixed(1)}¢\n` +
            `✅ Win pays ${money(r.filled)} (+${money(r.filled - r.total)}) · ❌ lose −${money(r.total)}\n` +
            `💰 Wallet ≈ ${money(a.cash)} · 🤖 auto today ${money(S.led.fast || 0)}${CFG.FAST_DAY > 0 ? '/' + money(CFG.FAST_DAY) : ' (no limit)'}\n📊 ${c.cond}`);
        } else {
          unmark(); log('auto not filled', c.m.ticker);
          S.nf = S.nf || {}; if (!S.nf[c.m.event_ticker]) { S.nf[c.m.event_ticker] = 1; await say(`⏳ MISSED FILL · ${label(c.m.ticker)} ${c.side.toUpperCase()}\nPrice ran past the bot's max (${cents(Math.min(0.99, c.ask + CFG.AUTO_GRACE))}) on ${CFG.AUTO_TRIES} tries. 💵 No money spent — it keeps watching this window.`); }
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
  if (CFG.MAKER === 1) {
    await manageBids(latest, fast);
    const autoOn = fast ? CFG.AUTO_FAST === 1 : CFG.AUTO_HOURLY === 1;
    if (autoOn && !S.paused && !S.led.fastOff) {
      const wins = Object.entries(S.win).filter(([ev, w]) => w.mk && isFast(w.series) === !!fast && !w.traded && freshWin.has(ev)).sort((x, y) => y[1].mk.edge - x[1].mk.edge);
      if (env.BOT_DEBUG_BIDS === '1') log('MKWINS', fast, Object.entries(S.win).filter(([ev]) => freshWin.has(ev)).map(([ev, w]) => `${ev}:${w.mk ? w.mk.q + '/' + w.mk.edge.toFixed(3) : 'none'}${w.traded ? ':T' : ''}`).join(' '));
      for (const [ev, w] of wins) {
        if (restingFor(ev) || a.held.has(ev) || used.has(ev)) continue;
        const lk = laneOf(ev, w.mk.m.close_time); if (laneBenched(lk) || w.mk.edge < CFG.MAKER_EDGE + laneBar(lk)) continue;
        const { q, v, m, product } = w.mk;
        const oc = (a.exposure ?? openCost()) + restingCost(), equity = a.cash + oc, room = CFG.MAX_OPEN_PCT * equity - oc;
        const free = a.cash - restingCost() - Math.max(resv(a), 0.02);
        const budget = Math.min(free, room, stakeFor(v.p, q, equity));
        let n = Math.floor(budget / (q + makerFee(q)) + 1e-9); if (S.led.safe) n = Math.min(n, 1);
        if (n < 1) { w.skip = free < q + 0.02 ? `💸 not enough free cash for a bid at ${cents(q)} (${money(Math.max(0, free))} usable, ${money(resv(a))} kept safe)` : `🔒 ${money(oc)} already in bets/bids (max ${Math.round(CFG.MAX_OPEN_PCT * 100)}%)`; continue; }
        try { await postBid(m, v, q, n, product); used.add(ev); w.skip = null; }
        catch (e) { log('bid failed', m.ticker, e.message); if (!/post.?only|cross/i.test(e.message)) { S.bidErr = S.bidErr || {}; if (!S.bidErr[ev]) { S.bidErr[ev] = 1; await say(`⚠️ Limit bid failed (${label(m.ticker)}): ${e.message.replace(/^.*?-> /, '').slice(0, 160)}`); } } }
      }
    }
  }
}

async function applySetting(name, raw) {
  name = String(name || '').toLowerCase();
  if (name === 'coins') {
    const list = /^all$/i.test(String(raw || '').trim()) ? ALL_SERIES.slice() : String(raw || '').toUpperCase().split(',').flatMap(c => COIN_SERIES[c.trim()] || []);
    if (!list.length) return `Usage: /set coins all  or  /set coins btc,eth,sol\nCoins: ${COINS.join(', ')}`;
    for (const x of list) delete S.emptyUntil[x];
    CFG.SERIES = list; await saveSettings(); return '✅ coins = ' + String(raw).toUpperCase();
  }
  const x = SETTINGS[name]; let v = Number(String(raw ?? '').replace(/[$%¢]/g, ''));
  if (['edge', 'autoedge', 'grace', 'minprice', 'maxprice', 'autotrade', 'autoday', 'makeredge'].includes(name) && v >= 1 && v <= 100) v = v / 100; // /set edge 8 = 8¢
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
    else if (a === 'scan') { await tick(false, true); return S.lastError ? 'scan error: ' + S.lastError : 'scan done'; }
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
    let m = (await kalshi('GET', `/markets/${p.ticker}`)).market || {};
    try { if (m.ticker) m = await withLiveQuote(m); } catch (e) { log('orderbook failed', p.ticker, e.message); }
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
    const lim0 = bestLimit(v.p, ask, CFG.MIN_EDGE / 2, 0.02);
    if (lim0 === null) return done('No edge left', `⚠️ No edge left at today's price (bot's fair value ~${cents(v.p)}). Not bought.`);
    let limit = lim0;
    // worst-case cost (price can tick up to the limit) must fit the per-trade cap, today's budget and the wallet
    const worstCost = n => n * limit + feeTotal(n, limit);
    const room = Math.min(a.tradeCap, a.dayCap - a.spent, a.cash - Math.max(CFG.RESERVE, 0.02));
    let count = Math.min(p.count, Math.floor(bookDepth(m, p.side, limit)));
    if (count < 1) return done('No sellers', `⚠️ Nobody is selling ${p.side.toUpperCase()} at ${cents(limit)} or less right now. Not bought, no money spent.`);
    while (count > 0 && worstCost(count) > room + 0.001) count--;
    if (count < 1) {
      if (a.dayCap - a.spent < worstCost(1)) return done('Daily limit hit', `🛑 Daily limit reached: spent ${money(a.spent)} of ${money(a.dayCap)} today.`);
      return done('Not enough cash', `🛑 Not enough cash: 1 contract needs up to ${money(worstCost(1))} incl. fees; wallet ${money(a.cash)} (keeping ${money(CFG.RESERVE)} reserve).`);
    }
    const r = await placeBuy({ ticker: p.ticker, side: p.side, count, price: limit }); acctCache = null;
    return done(r.filled ? 'Bought!' : 'Not filled', r.filled
      ? `🟢👆 BOUGHT ${r.filled}/${count} @ ${cents(r.px)} = ${money(r.total)} (fee ${money(r.fees)}) · 💰 wallet ≈ ${money(a.cash - r.total)}`
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
  if (env.BOT_TEST === '1' && t === '/_fasttick') { await tick(true); return; }
  if (env.BOT_TEST === '1' && t === '/_news') { await pollNews(); return; }
  if (env.BOT_TEST === '1' && t === '/_clearnewspause') { S.newsPauseUntil = 0; return; }
  if (env.BOT_TEST === '1' && t === '/_research') { await runResearch(); return; }
  if (t.startsWith('/research')) return say(S.lastResearch || '🧪 First research run happens ~3 min after start, then every 6 hours.');
  if (t.startsWith('/news')) {
    const ev = eventPause();
    return say(`📰 News watch (${S.newsSources || '…'} sources live)\n${ev ? `⏸ Paused: ${ev}` : '▶️ No event pause'}\n` + (S.newsLog.length ? S.newsLog.slice(0, 6).map(x => `• ${x.level === 'critical' ? '🚨' : x.level === 'macro' ? '🏛' : x.level.startsWith('critical') ? '⚠️' : x.level.startsWith('macro') ? '🏦' : '📊'} ${x.title.slice(0, 110)}`).join('\n') : 'No market-moving headlines since start.'));
  }
  if (t.startsWith('/report')) { try { await account(true); } catch (e) {} await rollDay(String(startOfTodayCT())); return say(dayReport(S.led, 'TODAY SO FAR')); }
  if (t.startsWith('/why')) {
    const st = S.stats, f5 = st.fast.filter(x => Date.now() - x < 5 * 60e3).length;
    const lines = [`🔍 Live check — 15-min scans in last 5 min: ${f5} ${f5 >= 25 ? '✅' : '⚠️'} (target 30) · auto 15-min ${CFG.AUTO_FAST !== 1 ? 'OFF' : S.led.fastOff ? 'STOPPED today' : S.led.safe ? 'ON · 🛡 SAFE MODE (1 contract, 5¢+ edges)' : 'ON'}`];
    for (const ser of CFG.SERIES.filter(isFast)) {
      const x = st.last15[ser], coin = ser.replace('KX', '').replace('15M', '');
      if (!x) { lines.push(`\n${coin}: no open 15-min market seen yet`); continue; }
      const age = Math.round((Date.now() - x.at) / 1000);
      if (x.blocked) lines.push(`\n${coin}: ⏸ blocked — ${x.blocked} (${age}s ago)`);
      else if (x.done) lines.push(`\n${coin}: ✅ already traded/alerted this window (${Math.round(x.mins)} min left)`);
      else lines.push(`\n${coin} ${x.side.toUpperCase()} @ ${cents(x.ask)} · ${x.mins.toFixed(1)} min left (${age}s ago)\nbot ${Math.round(x.p * 100)}% (model ${Math.round(x.raw * 100)}%, market ${Math.round(x.mkt * 100)}%) → edge ${(x.edge * 100).toFixed(1)}¢\n${x.reasons.length ? 'Not trading: ' + x.reasons.join('; ') : '👉 Qualifies — trading'}`);
    }
    return say(lines.join('\n'));
  }
  if (t.startsWith('/auto15')) {
    const on = !/off|0|stop/.test(t);
    CFG.AUTO_FAST = on ? 1 : 0; if (on) { S.led.fastOff = false; S.led.safe = false; S.led.streak = 0; S.led.autoPnl = 0; } await saveSettings();
    return say(on ? `🤖 Auto 15-min trading ON: up to ${money(CFG.SMALL_TRADE)}/trade, ${money(CFG.FAST_DAY)}/day, stops after ${money(CFG.FAST_MAX_LOSS)} loss or ${CFG.FAST_STREAK} losses in a row.` : '⏸ Auto 15-min trading OFF. 15-min ideas come as tap alerts.');
  }
  if (t.startsWith('/scan')) { await say('🔎 Scanning now…'); await tick(false, true); return say(S.lastError ? '⚠️ ' + S.lastError : '✅ Scan done. No alert = no good trade right now.'); }
  if (t.startsWith('/stats')) {
    const c = S.sc, n = c.n;
    if (!n) return say(`📈 Scorecard: no alerts settled yet (${c.open.length} waiting). Each alert is scored after its market closes, whether or not you bought it.\n\n` + lanesText());
    return say(lanesText() + `\n\n📈 Scorecard (every alert, 1 contract each)\nSettled: ${n} · waiting: ${c.open.length}\nBot predicted wins: ${(c.sumP / n * 100).toFixed(0)}% · actual: ${(c.wins / n * 100).toFixed(0)}%\nPaper profit: ${c.pnl >= 0 ? '+' : '−'}${money(Math.abs(c.pnl))} (${(c.pnl / n * 100).toFixed(1)}¢ per alert)\nAccuracy score (Brier, lower is better): ${(c.brier / n).toFixed(3)}\n${n < 50 ? 'Under 50 results is mostly luck — judge it after 50+.' : ''}`);
  }
  if (t.startsWith('/coins')) return coverageReport();
  if (t.startsWith('/learn')) return say(calText() + '\n\n' + lanesText());
  if (t.startsWith('/bids')) { const r = Object.values(S.rest || {}); return say(r.length ? `📋 Resting limit bids (${money(restingCost())} reserved):\n` + r.map(o => `• ${label(o.t)} ${o.side.toUpperCase()} ${o.n} @ ${cents(o.q)} · win chance ${Math.round(o.p * 100)}%${o.filled ? ` · ${o.filled} filled` : ''}`).join('\n') : `📋 No resting bids right now. Limit bids: ${CFG.MAKER === 1 ? 'ON' : 'OFF (/set maker 1)'}`); }
  if (t.startsWith('/settings')) return say('⚙️ Current settings\n' + settingsText() + '\n\nChange one: /set trade 3\nCoins: /set coins all  (or btc,eth,sol,…)');
  if (t.startsWith('/help')) return say('Commands\n/claude <anything> – talk to Claude (or just type)\n/status – money & mode\n/stats – is the bot predicting well?\n/settings – see all settings\n/set <name> <value> – change one live\n/scan – scan right now\n/pause /resume\n/lock – stay in confirm mode\n/auto – allow auto-trading\n/auto15 on|off – auto-trade 15-min markets\n/why – why it is or is not trading 15-min markets now\n/report – today: trades, wins, losses, P&L\n/news – market-moving headlines + pauses\n/research – what the self-test learned\n/coins – which coins & markets are live\n/learn – self-learning results per market\n/bids – resting limit bids\n/rollback – undo the last code change\n\nSettings you can change:\n' + Object.entries(SETTINGS).map(([n, x]) => `${n} – ${x.desc}`).join('\n') + '\ncoins – btc,eth,sol,xrp,doge,bnb,hype,near,zec (or all)');
  if (t.startsWith('/set')) { const [, name, raw] = t.split(/\s+/); return say(await applySetting(name, raw)); }
  if (t.startsWith('/rollback')) return rollback();
  if (t.startsWith('/claude') || !t.startsWith('/')) {
    const q = msg.text.replace(/^\/claude(@\w+)?\s*/i, '').trim();
    if (!q) return say('Ask me anything or tell me what to change, e.g.\n/claude only trade ETH and raise trades to $3\n\n(You can also just type without /claude.)');
    return askClaude(q);
  }
  try {
    const a = await account();
    return say(`📊 Status\nMode: ${S.paused ? 'PAUSED' : S.unlocked ? 'AUTO' : 'CONFIRM (you tap to buy)'}\nAuto 15-min: ${CFG.AUTO_FAST !== 1 ? 'OFF' : S.led.fastOff ? 'STOPPED for today' : S.led.safe ? 'ON · 🛡 SAFE MODE today (1 contract, 5¢+ edges)' : 'ON'} · today ${money(S.led.fast || 0)}/${CFG.FAST_DAY > 0 ? money(CFG.FAST_DAY) : 'no limit'} · result ${(S.led.autoPnl || 0) >= 0 ? '+' : '−'}${money(Math.abs(S.led.autoPnl || 0))}\nAuto hourly: ${CFG.AUTO_HOURLY !== 1 ? 'OFF' : S.led.fastOff ? 'STOPPED for today' : S.led.safe ? 'ON · 🛡 SAFE MODE' : 'ON'} · always-in ${CFG.ALWAYS_IN === 1 ? 'ON' : 'OFF'} · 🛡 reserve ${money(resv(a))} · max ${Math.round(CFG.TRADE_PCT * 100)}% of wallet/trade\nCash: ${money(a.cash)} · 📋 limit bids ${CFG.MAKER === 1 ? `ON (${Object.keys(S.rest || {}).length} resting)` : 'OFF'} · sizing ${CFG.KELLY > 0 ? `½-Kelly, max ${Math.round(CFG.TRADE_PCT * 100)}%/trade` : 'fixed'}\nProfit since start: ${money(a.profit)} (auto at ${money(CFG.UNLOCK_PROFIT)})\nToday: ${money(a.spent)} of ${money(a.dayCap)} · max ${money(a.tradeCap)}/trade\nLast scan: ${S.lastScan ? timeCT(S.lastScan) : 'not yet'}${S.lastError ? '\nLast error: ' + S.lastError : ''}\n\n/help for all commands`);
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
    { command: 'lock', description: 'Stay in confirm mode' }, { command: 'auto', description: 'Allow auto-trading' }, { command: 'auto15', description: 'Auto 15-min trading on/off' }, { command: 'report', description: 'Today: trades, wins, losses, P&L' }, { command: 'news', description: 'Market-moving news + pauses' }, { command: 'research', description: 'What the self-test learned' }, { command: 'coins', description: 'Which coins/markets are live' }, { command: 'learn', description: 'Self-learning results per market' }, { command: 'bids', description: 'Resting limit bids' }, { command: 'why', description: 'Why it is/isn\'t trading 15-min now' }, { command: 'rollback', description: 'Undo last code change' },
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
  setTimeout(() => refitCal(true).catch(e => log('calibration failed', e.message)), 4000);
  if (env.BOT_TEST !== '1') setTimeout(() => coverageReport().catch(e => log('coverage failed', e.message)), 25e3);
});

// Which coins and market types are live on Kalshi right now, and where prices come from. Sent at startup and by /coins.
async function coverageReport() {
  try { const r = await kalshi('GET', '/series?category=Crypto'); log('CRYPTO SERIES', (r.series || []).map(x => `${x.ticker}(${x.frequency || '?'})`).join(' ')); } catch (e) { log('series list failed', e.message); }
  const cond = await marketConditions(), now = Date.now(), lines = [];
  for (const c of activeCoins()) {
    const got = { m15: false, h1: false, d1: false }, any = { m15: false, h1: false };
    for (const ser of CFG.SERIES.filter(x => coinOf(x) === c)) {
      let ms = []; try { ms = await pageAll(`/markets?series_ticker=${ser}&status=open`, 'markets'); } catch (e) {}
      if (isFast(ser)) { any.m15 = true; got.m15 = got.m15 || ms.length > 0; }
      else { any.h1 = true; got.h1 = got.h1 || ms.length > 0; got.d1 = got.d1 || ms.some(m => isDailyClose(m.close_time) && Date.parse(m.close_time) - now < 1440 * 60e3); }
    }
    const parts = [...(any.m15 ? [`15-min ${got.m15 ? '✅' : '—'}`] : []), ...(any.h1 ? [`hourly ${got.h1 ? '✅' : '—'}`, `daily ${got.d1 ? '✅' : '—'}`] : [])];
    const st = cond[c + '-USD'], src = st ? st.sources.length : 0;
    lines.push(`${src >= 2 && !(st.problems || []).some(x => /missing|only/.test(x)) ? '🟢' : '🟡'} ${c}: ${parts.join(' · ') || 'not selected'} · 💱 ${src} price feeds`);
  }
  await say(`🪙 COVERAGE (all auto, self-learning on)\n${lines.join('\n')}\n— = Kalshi has no open market of that type right now; the bot checks again automatically.`);
}

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

// Self-learning from REAL results: every market type (coin x 15-min / hourly / daily) keeps its last 12 trades.
// Losing types must show a bigger edge before trading again (and stop always-in); badly losing types sit out 6h.
// Winning types earn their normal bar back. Changes are reported to Telegram.
async function learnLane(k, pnl, cost) {
  const L = laneState(k); L.r = (L.r || []).concat(Math.round(pnl * 100) / 100).slice(-12);
  const n = L.r.length, sum = L.r.reduce((x, y) => x + y, 0), wins = L.r.filter(x => x > 0).length, before = { bar: L.bar || 0, bench: L.bench || 0 };
  if (CFG.LEARN !== 1) return;
  if (n >= 6 && sum < 0) L.bar = Math.min(0.06, Math.round(((L.bar || 0) + 0.01) * 100) / 100);
  else if (n >= 6 && sum > 0) L.bar = Math.max(0, Math.round(((L.bar || 0) - 0.01) * 100) / 100);
  if (n >= 8 && sum < 0 && wins / n < 0.34 && !(Date.now() < (L.bench || 0))) { L.bench = Date.now() + 6 * 3600e3; L.r = L.r.slice(-4); } // fresh start after the break
  const tot = `last ${n}: ${wins}W·${n - wins}L ${sum >= 0 ? '+' : '−'}${money(Math.abs(sum))}`;
  if ((L.bench || 0) > before.bench) await say(`🧠 SELF-LEARNING · ${laneName(k)} benched 6h — ${tot}. Other markets keep trading.`);
  else if (L.bar > before.bar) await say(`🧠 SELF-LEARNING · ${laneName(k)} losing (${tot}) → now needs +${Math.round(L.bar * 100)}¢ extra edge, always-in off for it.`);
  else if (L.bar < before.bar) await say(`🧠 SELF-LEARNING · ${laneName(k)} winning (${tot}) → extra edge eased to +${Math.round(L.bar * 100)}¢${L.bar === 0 ? ', back to normal (always-in on)' : ''}.`);
}
function lanesText() {
  const ks = Object.keys(S.lanes || {}).filter(k => (S.lanes[k].r || []).length || S.lanes[k].bar || S.lanes[k].bench); if (!ks.length) return '🧠 Self-learning: no settled auto trades yet.';
  return '🧠 Self-learning by market:\n' + ks.sort().map(k => { const L = S.lanes[k], n = L.r.length, sum = L.r.reduce((x, y) => x + y, 0), w = L.r.filter(x => x > 0).length;
    return `${Date.now() < (L.bench || 0) ? '⏸' : L.bar > 0 ? '⚠️' : '✅'} ${laneName(k)}: ${w}W·${n - w}L ${sum >= 0 ? '+' : '−'}${money(Math.abs(sum))}${L.bar ? ` · +${Math.round(L.bar * 100)}¢ bar` : ''}${Date.now() < (L.bench || 0) ? ` · benched till ${timeCT(new Date(L.bench).toISOString())}` : ''}`; }).join('\n');
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
    await learnLane(laneOf(o.t.split('-').slice(0, -1).join('-'), new Date(o.c).toISOString()), o.pnl, o.cost);
    const maxLoss = CFG.FAST_MAX_LOSS > 0 ? CFG.FAST_MAX_LOSS : Math.max(1, 0.4 * (S.led.startCash || 5));
    if (!S.led.safe && !S.led.fastOff && (S.led.autoPnl <= -maxLoss || S.led.streak >= CFG.FAST_STREAK)) {
      S.led.safe = true; // keep trading, but small: 1 contract at a time, real 5¢+ edges only, no always-in
      await say(`🛡 SAFE MODE for the rest of today (protecting your wallet): ${S.led.streak >= CFG.FAST_STREAK ? `${S.led.streak} losses in a row` : `down ${money(-S.led.autoPnl)}`}.\nStill trading — 1 contract at a time, only ${Math.round(CFG.AUTO_EDGE * 100)}¢+ edges. Back to normal size at midnight CT (or send /auto15 on).`);
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
    if (o.pb >= 0 && o.mk >= 0) { S.sc.hist = (S.sc.hist || []).concat([[o.pb, o.mk, win]]).slice(-200); calDirty = true; }
    S.sc.pnl += win - o.a - 0.07 * o.a * (1 - o.a); // per 1 contract, after fee
    await say(`📝 Alert check · ${label(o.t)} ${o.s === 'y' ? 'YES' : 'NO'} @ ${cents(o.a)} → ${win ? '✅ right' : '❌ wrong'} (bot said ${Math.round(o.p * 100)}%) · scorecard ${S.sc.wins}/${S.sc.n}`);
    S.sc.open = S.sc.open.filter(x => x !== o); changed = true;
  }
  if (calDirty) { calDirty = false; await refitCal(); }
  if (changed) await saveSettings();
}
let calDirty = false;

async function tick(fast = false, both = false) {
  const lock = fast ? 'busyFast' : 'busySlow';
  if (S[lock]) { S.stats.skipped[lock] = (S.stats.skipped[lock] || 0) + 1; return; }
  S[lock] = true;
  try {
    if (fast) { await scan(true); S.stats.fast.push(Date.now()); await windowRecap(); }
    else { await scan(false); await scoreAlerts(); S.stats.slow.push(Date.now()); if (both) { S.busyFast = true; try { await scan(true); } finally { S.busyFast = false; } } }
    for (const k of ['fast', 'slow']) S.stats[k] = S.stats[k].filter(t => Date.now() - t < 15 * 60e3);
    S.lastScan = new Date().toISOString(); S.lastError = null; S.errCount = 0;
  }
  catch (e) {
    S.lastError = e.message.slice(0, 200); S.errCount = (S.errCount || 0) + 1; log('scan error', e.message);
    if (S.errCount >= 3 && Date.now() - (S.lastErrAlert || 0) > 30 * 60e3) { S.lastErrAlert = Date.now(); say('⚠️ Scanning keeps failing: ' + S.lastError); }
  }
  finally { S[lock] = false; }
}
if (env.BOT_TEST !== '1') { // tests drive scans manually
  setInterval(() => tick(true), 10e3); // 15-min markets checked every 10 seconds (own lock)
  setTimeout(() => tick(false), 15000);
  setInterval(() => { // watchdog: a stalled bot restarts itself (Render brings it right back)
    const last = S.stats.fast[S.stats.fast.length - 1] || S.bootAt;
    if (Date.now() - last > 120e3 && Date.now() - S.bootAt > 180e3) { log('WATCHDOG stall — restarting'); say('♻️ Bot stalled for 2 min — restarting itself now.').finally(() => setTimeout(() => process.exit(1), 1500)); }
  }, 30e3);
  setInterval(() => { // heartbeat: proves scanning is continuous
    const st = S.stats; log('HEARTBEAT', JSON.stringify({ fast5m: st.fast.filter(t => Date.now() - t < 5 * 60e3).length, slow5m: st.slow.filter(t => Date.now() - t < 5 * 60e3).length, skipped: st.skipped, lastError: S.lastError,
      cash: acctCache ? acctCache.v.cash : null, open: acctCache ? acctCache.v.exposure : null, day: { w: S.led.w, l: S.led.l, pnl: S.led.pnl, auto: S.led.autoPnl, trades: S.led.n }, safe: !!S.led.safe,
      lanes: Object.fromEntries(Object.entries(S.lanes || {}).filter(([, L]) => (L.r || []).length).map(([k, L]) => [k, `${L.r.filter(x => x > 0).length}-${L.r.filter(x => x <= 0).length}${L.bar ? ' +' + Math.round(L.bar * 100) + 'c' : ''}${Date.now() < (L.bench || 0) ? ' BENCH' : ''}`])) }));
    if (CFG.AUTO_FAST === 1 && !S.paused && st.fast.filter(t => Date.now() - t < 5 * 60e3).length < 10 && Date.now() - (S.lastStallAlert || 0) > 30 * 60e3) { S.lastStallAlert = Date.now(); say('⚠️ 15-min scanning is falling behind (fewer than 10 checks in 5 min). Investigating automatically; last error: ' + (S.lastError || 'none')); }
  }, 5 * 60e3);
}
// ---------- research + news (run in the background, automatically) ----------
async function runResearch() {
  try {
    const coins = activeCoins();
    const r = await research.run(req, coins);
    const lines = [`🧪 RESEARCH UPDATE (last 72h of ${coins.join('/')}, tested on unseen data)`];
    for (const coin of coins) for (const [key, name] of [['m15', '15-min'], ['h1', 'hourly']]) {
      const f = r[coin] && r[coin][key]; if (!f || !f.ok) { lines.push(`${coin} ${name}: not enough data`); continue; }
      const pattern = f.k > 0 ? `📈 momentum (k +${f.k})` : f.k < 0 ? `🔄 snap-back (k ${f.k})` : 'no direction pattern';
      lines.push(`${coin} ${name}: ${pattern} · swing scale ×${f.mult} → ${f.adopt ? `✅ adopted (+${(f.gain * 100).toFixed(1)}% accuracy)` : `➖ not proven (${(f.gain * 100).toFixed(1)}%), keeping baseline`}`);
      S.learn[coin] = S.learn[coin] || {};
      S.learn[coin][key] = { k: f.k, mult: f.mult, adopt: f.adopt, gain: Math.round(f.gain * 10000) / 10000, n: f.n, at: Date.now() };
    }
    S.lastResearch = lines.join('\n');
    await saveSettings(); await say(S.lastResearch);
  } catch (e) { log('research failed', e.message); }
}
async function pollNews() {
  try {
    const r = await news.poll(req, S.newsSeen);
    S.newsSources = `${r.sourcesOk}/${r.sources}`;
    if (!S.newsPrimed) { S.newsPrimed = true; return; } // first pass: learn what's already out, don't replay it
    const lines = [];
    for (const it of r.fresh) {
      S.newsLog.unshift(it); S.newsLog = S.newsLog.slice(0, 20);
      if (it.pauseMin > 0 && Date.now() + it.pauseMin * 60e3 > S.newsPauseUntil) { S.newsPauseUntil = Date.now() + it.pauseMin * 60e3; S.newsPauseWhy = it.title.slice(0, 80); } // longest pause keeps its reason
      const icon = it.level === 'critical' ? '🚨' : it.level === 'macro' ? '🏛' : it.level.startsWith('critical') ? '⚠️' : it.level.startsWith('macro') ? '🏦' : '📊';
      lines.push(`${icon} ${it.title.slice(0, 140)}${it.pauseMin ? ` — ⏸ trading paused ${it.pauseMin} min` : ''}`);
    }
    if (lines.length) await say(`📰 NEWS\n${lines.slice(0, 6).join('\n')}${lines.length > 6 ? `\n…and ${lines.length - 6} more (/news)` : ''}`);
  } catch (e) { log('news failed', e.message); }
}
if (env.BOT_TEST !== '1') {
  setTimeout(runResearch, 3 * 60e3); setInterval(runResearch, 6 * 3600e3);
  setTimeout(pollNews, 20e3); setInterval(pollNews, 2 * 60e3);
}
// keep the free Render instance awake
if (PUBLIC_URL) setInterval(() => fetch(PUBLIC_URL + '/').catch(() => {}), 4 * 60e3);
