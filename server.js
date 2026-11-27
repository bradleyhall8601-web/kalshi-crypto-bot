// Kalshi crypto prediction bot — standalone (no dependencies). Node 18+.
// Env: KALSHI_KEY_ID, KALSHI_PRIVATE_KEY, TELEGRAM_BOT_TOKEN, [TELEGRAM_CHAT_ID], [BOT_START_TS], [KALSHI_ENV=demo]
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const research = require('./research');
const news = require('./news');
const other = require('./other');

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
  MIN_PRICE: 0.15, MAX_PRICE: 0.85, // production raised to 40¢ by settings migration v12 (paper data 11/22: under 40¢ went 2W-14L)
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
  PAPER: 0,          // paper trading: score every trade the bot would make, spend nothing, until the record proves a profit
  QUIET: 1, // Telegram: 1 = only what matters (news only when it pauses trading, window recap only when the main strategy acted); 0 = everything
  OTHER: 1, OT_LIVE: 1, OT_GOAL: 10, // weather + sports practice bets (Brad 11/26 8:30 PM: "place bets on sports, crypto, weather ASWELL", chose practice first; 8:43 PM: "Profit 10$ then go to REAL FUNDS")
  LATE_MIN: 0.60, LATE_AM: 1, // real 15-min money skips leaders under 60¢ and US mornings (6–10 AM CT on US weekdays) — 11/24–26 real record: −4.7¢ and −10.8¢/contract there; paper tests still take them
  DAY_LOSS_PCT: 0.15, LOCK_MIN: 1.5, LOCK_KEEP: 0.5, // Brad 11/27: limits that protect the day's profit but never cap a winning run
  LATE: 1, LATE_MAX: 0.97, LATE_LIVE: 0, LATE_STOP: 5, LATE_PER: 15, LATE_GRACE: 0.01, // LATE_LIVE: real-money 12th-minute strategy (all coins), 1 contract per coin per LATE_PER $ of account; turns itself off after LATE_STOP $ lost
  // Brad's test: at the 12th minute of each 15-min market (and 12 min before each hourly/daily close), buy whichever side is winning
  PAPER_PROVE_N: 150, PAPER_PROVE_EDGE: 0.02, // go live after 150+ paper trades in all (and the last 50) averaging +2¢ per contract after fees (11/27: a rolling 50 swung −4.3¢ → +4.2¢ in two hours)
  MAX_SAME_DIR: env.BOT_TEST === '1' ? 50 : 2, // coins move together: at most 2 bets on the same direction (up/down) per closing time
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
  paper:    { key: 'PAPER', desc: 'paper trading (1 = practice only, no real money; 0 = real)', min: 0, max: 1 },
  quiet:    { key: 'QUIET', desc: 'Telegram: 1 = only what matters (news that pauses trading, recaps with a trade), 0 = every headline and every window recap', min: 0, max: 1 },
  late:     { key: 'LATE', desc: '12th-minute / last-12-min tests (15-min, hourly, daily): buy whichever side is winning, each with its own record: 1 on, 0 off', min: 0, max: 1 },
  latelive: { key: 'LATE_LIVE', desc: 'REAL money 12th-minute strategy: every 15-min coin, buys whichever side is winning (1 = on, 0 = off)', min: 0, max: 1 },
  lategrace:{ key: 'LATE_GRACE', desc: 'real 12th-minute buys may pay up to this much above the ask so they fill (never above latemax)', min: 0, max: 0.05 },
  lateper:  { key: 'LATE_PER', desc: 'real 12th-minute size: 1 contract per coin for every this many $ in the account', min: 1, max: 10000 },
  latestop: { key: 'LATE_STOP', desc: 'real 12th-minute strategy turns itself off after losing this many $ in total', min: 0.5, max: 10000 },
  latemin:  { key: 'LATE_MIN', desc: 'real 15-min buys skip a leader priced under this (a coin flip plus the biggest fee)', min: 0.01, max: 0.97 },
  daystop:  { key: 'DAY_LOSS_PCT', desc: "real 15-min buys stop until midnight CT after losing this share of the day's starting money in a day (0.15 = 15%, at least $2; 0 = off)", min: 0, max: 1 },
  lockmin:  { key: 'LOCK_MIN', desc: "profit lock starts once real 15-min buys are up this many $ in a day", min: 0.1, max: 10000 },
  lockkeep: { key: 'LOCK_KEEP', desc: "profit lock: real 15-min buys stop until midnight CT if the day's profit falls below this share of its best (0.5 = keep half; 0 = off). Wins are never capped", min: 0, max: 0.95 },
  lateam:   { key: 'LATE_AM', desc: 'real 15-min buys sit out US mornings, 6–10 AM CT on US weekdays (data releases and the stock open flip late leaders): 1 on, 0 off', min: 0, max: 1 },
  other:    { key: 'OTHER', desc: 'weather + sports practice bets (paper; NWS forecasts/observations/alerts, sportsbook lines, live win %, injury news): 1 on, 0 off', min: 0, max: 1 },
  otlive:   { key: 'OT_LIVE', desc: 'real money on weather/sports once practice is up otgoal $, for each rule that is itself in profit: 1 on, 0 off', min: 0, max: 1 },
  otgoal:   { key: 'OT_GOAL', desc: 'weather/sports practice profit ($) needed before real money', min: 1, max: 100000 },
  latemax:  { key: 'LATE_MAX', desc: 'highest price the buy-the-winner tests will pay for the winning side', min: 0.5, max: 0.99 },
  samedir:  { key: 'MAX_SAME_DIR', desc: 'max bets on the same direction (up/down) closing at the same time, across coins', min: 1, max: 50 },
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
  const blob = {}; for (const x of Object.values(SETTINGS)) blob[x.key] = CFG[x.key]; blob.SERIES = CFG.SERIES; blob.manualLock = S.manualLock; blob.paused = S.paused; blob.v = 22; blob.REST = S.rest; blob.PAPERS = { r: S.paper.r, tot: S.paper.tot, pos: S.paper.pos, bids: S.paper.bids, since: S.paper.since, old: S.paper.old, late: lateBlob() }; blob.LANES = S.lanes; blob.CALFIT = S.cal; blob.SC = S.sc; blob.LED = S.led; blob.SETL = S.setlTs; blob.LRN = S.learn; blob.NPS = (S.pauseStories || []).slice(-30); blob.OT = OT.blob(); // stories already paused for survive restarts; weather/sports practice records
  let text = '⚙️ BOT SETTINGS (do not unpin)\n' + JSON.stringify(blob);
  if (text.length > 4000) { S.sc.open = S.sc.open.slice(-8); blob.SC = S.sc; text = '⚙️ BOT SETTINGS (do not unpin)\n' + JSON.stringify(blob); }
  if (text.length > 4000) text = '⚙️ BOT SETTINGS (do not unpin)\nZ:' + zlib.deflateRawSync(Buffer.from(JSON.stringify(blob)), { level: 9 }).toString('base64'); // many coins: compress to fit Telegram's 4096 limit
  const zip = () => '⚙️ BOT SETTINGS (do not unpin)\nZ:' + zlib.deflateRawSync(Buffer.from(JSON.stringify(blob)), { level: 9 }).toString('base64');
  if (text.length > 4090) { S.led.auto = (S.led.auto || []).filter(x => !x.done).slice(-20); blob.LED = S.led; text = zip(); }
  // still too big for Telegram (4096): trim the oldest history, never the settings themselves
  if (text.length > 4090) { S.sc.hist = (S.sc.hist || []).slice(-120); blob.SC = S.sc; text = zip(); }
  if (text.length > 4090) { blob.PAPERS = { ...blob.PAPERS, r: (S.paper.r || []).slice(-60), late: lateBlob(10) }; text = zip(); }
  if (text.length > 4090) { S.sc.hist = (S.sc.hist || []).slice(-60); blob.SC = S.sc; blob.NPS = blob.NPS.slice(-5); text = zip(); }
  // 11/24: anchors + live record pushed it over again — keep trimming history (never settings, live record, stop flag, verdicts or anchors)
  if (text.length > 4090) { blob.NPS = (blob.NPS || []).slice(-3).map(x => { const t = news.storyTags(x.title), v = [...new Set([...(x.v || []), ...(t.v || [])])]; return { title: String(x.title).slice(0, 60), at: x.at, ...(x.c || t.c ? { c: 1 } : {}), ...(v.length ? { v } : {}) }; }); blob.SC = { ...S.sc, hist: (S.sc.hist || []).slice(-30) }; blob.PAPERS = { ...blob.PAPERS, late: lateBlob(5) }; text = zip(); }
  if (text.length > 4090) { blob.LANES = Object.fromEntries(Object.entries(S.lanes || {}).map(([k, v]) => [k, { ...v, r: (v.r || []).slice(-6) }])); blob.PAPERS = { ...blob.PAPERS, r: (S.paper.r || []).slice(-50) }; text = zip(); }
  if (text.length > 4090) { delete blob.LRN; blob.SC = { ...S.sc, hist: [] }; text = zip(); } // research results are rebuilt by the next research run (3 min after a restart)
  if (text.length > 4090 && blob.OT && blob.OT.p) { blob.OT = OT.blob(false); text = zip(); if (Date.now() - (S.otRoomLog || 0) > 3600e3) { S.otRoomLog = Date.now(); log('SETTINGS: open weather/sports practice bets kept in memory only (no room)'); } } // records stay; only the open paper bets drop
  if (text.length > 4090) { if (Date.now() - (S.bigWarn || 0) > 3600e3) { S.bigWarn = Date.now(); log('SETTINGS TOO BIG', text.length, 'chars — not saved'); say('⚠️ Settings too big to save — tell Claude.').catch(() => {}); } return; }
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
    if (Array.isArray(blob.NPS)) S.pauseStories = blob.NPS.filter(x => x && x.title && Date.now() - x.at < news.VENUE_MS);
    if (blob.PAPERS && typeof blob.PAPERS === 'object') S.paper = { r: blob.PAPERS.r || [], tot: blob.PAPERS.tot || null, pos: blob.PAPERS.pos || [], bids: blob.PAPERS.bids || {}, since: blob.PAPERS.since || Date.now(), old: blob.PAPERS.old || null, late: blob.PAPERS.late || undefined };
    if (!(blob.v >= 11) && env.BOT_TEST !== '1') { CFG.PAPER = 1; S.paper.since = Date.now(); setTimeout(() => { saveSettings(); say('📄 PAPER TRADING ON — no real money is spent from now on. The bot keeps scanning every market and grades every trade it would have made against Kalshi\'s real results. It switches back to real money by itself after 50+ paper trades averaging +2¢ or better per contract. /paper shows the record.'); }, 3000); }
    if (!(blob.v >= 16) && env.BOT_TEST !== '1' && blob.v >= 15) { CFG.LATE_LIVE = 1; CFG.LATE_STOP = 10000; const LV = lateState().live; delete LV.stopped; LV.base = LV.sum; setTimeout(() => { saveSettings(); say('💵 REAL MONEY BACK ON — 12th-minute strategy, no loss limit (your call, 11/24 8:40 PM).\n🛡 Still never more than 60% of the money in open bets at once.\n⚠️ With no loss limit it can lose the whole balance. /set latelive 0 stops it anytime; /set latestop 5 puts a limit back.'); }, 4500); } // Brad 11/24 8:40 PM: "Take the loss limit off… keep it live"
    if (!(blob.v >= 15) && env.BOT_TEST !== '1') { CFG.LATE_LIVE = 1; setTimeout(() => { saveSettings(); say(`💵 REAL MONEY ON — 12th-minute strategy (your go, 11/24)\n⏰ Every 15-min market, all 9 coins: at the 12th minute it buys whichever side is winning, with real money.\n📏 Size: 1 contract per coin for every ${money(CFG.LATE_PER)} in the account — grows as the account grows.\n🛡 Never more than ${Math.round(CFG.MAX_OPEN_PCT * 100)}% of the money in open bets at once; turns itself off if it loses ${money(CFG.LATE_STOP)} in total.\n📄 Main strategy stays paper. /paper shows both. /set latelive 0 stops it anytime.`); }, 4500); } // Brad 11/24: go full blown with the 12-minute version
    if (!(blob.v >= 12) && env.BOT_TEST !== '1') { // no more long shots; the go-live proof restarts so it measures only the new rule
      CFG.MIN_PRICE = Math.max(CFG.MIN_PRICE, 0.40);
      const r = S.paper.r || []; S.paper.old = { n: r.length, sum: Math.round(r.reduce((a, x) => a + x, 0) * 100) / 100, w: r.filter(x => x > 0).length };
      S.paper.r = []; S.paper.tot = null; S.paper.since = Date.now();
      S.paper.pos = (S.paper.pos || []).filter(o => o.px >= CFG.MIN_PRICE); for (const [k, b] of Object.entries(S.paper.bids || {})) if (b.q < CFG.MIN_PRICE) delete S.paper.bids[k];
      setTimeout(() => { saveSettings(); say(`🎯 NEW RULE: no more long shots — the bot only buys contracts priced 40¢–85¢.\n📊 Why: in ${S.paper.old.n} paper trades, buys under 40¢ went 2 wins / 14 losses (−20¢ each), while 40¢+ buys made money.\n📄 Paper proof restarts from 0 to test the new rule honestly (old record: ${S.paper.old.n} trades ${S.paper.old.sum >= 0 ? '+' : '−'}$${Math.abs(S.paper.old.sum).toFixed(2)}). Still goes live after 50+ trades averaging +2¢.`); }, 3500);
    }
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
    if (blob.OT && typeof blob.OT === 'object') OT.load(blob.OT);
    if (!(blob.v >= 19) && blob.OT && OT.state.p.length) { log('OTHER cleared', OT.state.p.length, 'open practice bets from the first weather model (recalibrated 11/26 9:25 PM CT)'); OT.state.p = []; } // they don't measure the rules as they are now
    if (blob.LANES && typeof blob.LANES === 'object') S.lanes = blob.LANES;
    if (blob.CALFIT && typeof blob.CALFIT === "object") S.cal = blob.CALFIT;
    if (blob.LED && typeof blob.LED.spent === 'number') S.led = { ...newLed(blob.LED.day), ...blob.LED };
    if (!(blob.v >= 17) && env.BOT_TEST !== '1' && S.led && String(S.led.day) === '1795586400' && S.led.w >= 4) { S.led.w -= 4; S.led.pnl = Math.round((S.led.pnl - 1.09) * 100) / 100; log('LED FIX', 'removed the 12:45 PM CT results counted twice on 11/25 (4W, +$1.09)'); setTimeout(saveSettings, 3000); } // v17: one-time correction of today's tally
    if (!(blob.v >= 22) && env.BOT_TEST !== '1') setTimeout(() => { saveSettings(); say(`🔒 NEW DAY LIMITS for real money (your call 11/27: "set limits if needed to ensure profit gain but don't limit it on winning")\n🛑 Real 15-min buys stop until midnight if the day's real result falls to −15% of the day's starting money (at least −$2).\n🔒 Once the day is up $1.50+, they stop until midnight if it gives back half of its best. No cap on wins.\n🧾 Fixed: "LOSS −$10.45 · NEAR 9:30 AM" was not a real loss — contracts in that market were sold before the close (the account's money went up). Such records are now left out of the tally.\n/set daystop 0 or /set lockkeep 0 turns a limit off.`); }, 6000); // Brad 11/27 9:31–9:40 AM
    if (!(blob.v >= 22) && env.BOT_TEST !== '1' && S.led && String(S.led.day) === '1795759200' && S.led.pnl < -10 && S.led.l >= 1) { S.led.pnl = Math.round((S.led.pnl + 10.45) * 100) / 100; S.led.l -= 1; S.led.worst = Math.max(S.led.worst, -1.85); log('LED FIX', 'removed the false NEAR 9:30 AM CT −$10.45 (contracts sold before the close)'); setTimeout(saveSettings, 3000); } // v22
    if (!(blob.v >= 21) && env.BOT_TEST !== '1' && blob.v >= 20) { CFG.PAPER = 1; setTimeout(() => { saveSettings(); say(`📄 MODEL BIDS BACK TO PRACTICE (your call, 11/27 9:10 AM)\n💵 Real money stays on the 12th-minute strategy only.\n🎯 The model goes real again only after 150+ practice trades averaging +2¢ or better (and its last 50 too) — a 50-trade streak was mostly luck.\n🧾 Its open real bids are cancelled; anything already bought settles as normal.`); }, 4500); }
    if (!(blob.v >= 20) && env.BOT_TEST !== '1' && S.led && String(S.led.day) === '1795759200') { const o = { n: 49, nAuto: 49, w: 49, l: 6, pnl: 2.17, fees: 0.56, best: 0.69, worst: -1.85 }; // v20: the 4:27 AM CT false day roll (11/27) wiped midnight–4:27 AM; put it back
      for (const k of ['n', 'nAuto', 'w', 'l']) S.led[k] = (S.led[k] || 0) + o[k]; S.led.pnl = Math.round((S.led.pnl + o.pnl) * 100) / 100; S.led.fees += o.fees; S.led.best = Math.max(S.led.best, o.best); S.led.worst = Math.min(S.led.worst, o.worst);
      log('LED FIX', 'added back midnight–4:27 AM CT 11/27 (49 trades, 49W·6L, +$2.17) lost to a false day roll'); setTimeout(saveSettings, 3000); }
    if (!(blob.v >= 18) && env.BOT_TEST !== '1') setTimeout(() => { saveSettings(); say(`🧠 NEW REAL-MONEY RULES (your call 11/26: "do what's best for profit")\n📊 Your last 283 real trades won about as often as the price said (−1.0¢ per contract after fees). The losses came from two places:\n🌅 US mornings, 6–10 AM CT (data releases + the stock open flip late leaders): −10.8¢ per contract → real money now sits these out on US weekdays\n🪙 Leaders under 60¢ (a coin flip plus the biggest fee): −4.7¢ → skipped\n📏 No more 2×/3× bets: 1 contract per coin, growing with the account\n🧪 Paper tests still take every trade, so the bot keeps learning and switches rules on its own when one proves itself.\n⚙️ Change with /set latemin 0.6 · /set lateam 0`); }, 4000);
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
  if (+S.led.day > 0 && +today > 0 && +today < +S.led.day + 3600) return; // same day (a key a second or an hour off is never a new day)
  if (S.led.day && (S.led.n || S.led.w || S.led.l)) await say(dayReport(S.led, 'DAILY REPORT (yesterday)'));
  S.led = { ...newLed(today), auto: S.led.auto || [] };
}
const S = { bootAt: Date.now(), win: {}, // per market window: best verdict seen, traded or not
   learn: {}, lanes: {}, rest: {}, paper: { r: [], pos: [], bids: {}, since: Date.now() }, newsSeen: new Set(), newsLog: [], newsPauseUntil: 0, newsPauseWhy: '', lastCond: {}, stats: { fast: [], slow: [], skipped: {}, last15: {} }, candles: {}, led: newLed(''), sc: { n: 0, wins: 0, sumP: 0, brier: 0, pnl: 0, open: [], ev: {} }, seen: {}, busy: false, pending: {}, recentAlerts: {}, paused: false, manualLock: false, unlocked: false, lastScan: null, lastError: null };
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
async function tg(method, payload, tries = 0) {
  try { return await req(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, { method: 'POST', body: payload }); }
  catch (e) {
    if (/not modified/.test(e.message)) return { ok: false, error: e.message };
    // network blips ("fetch failed", timeouts) and 429/5xx get retried so a report isn't silently lost; other 4xx are real errors
    if (tries < 3 && (!/-> \d{3}/.test(e.message) || /-> (429|5\d\d)/.test(e.message))) { await new Promise(r => setTimeout(r, (env.BOT_TEST === '1' ? 50 : 2000) * (tries + 1))); return tg(method, payload, tries + 1); }
    log('telegram error', e.message); return { ok: false, error: e.message };
  }
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
function startOfTodayCT(now = Date.now()) { // one clock reading only: reading the time twice could straddle a second and give midnight + 1 s, which looked like a new day (live 11/27 4:27 AM CT: a false "DAILY REPORT (yesterday)" and today's tally wiped)
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: CFG.TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const hms = t => Object.fromEntries(fmt.formatToParts(new Date(t)).map(x => [x.type, x.value]));
  const p = hms(now); let t0 = now - (+p.hour * 3600 + +p.minute * 60 + +p.second) * 1000;
  const h = +hms(t0).hour; if (h === 23) t0 += 3600e3; else if (h === 1) t0 -= 3600e3; // a daylight-saving day: the wall clock skipped or repeated an hour since midnight
  return Math.floor(t0 / 1000);
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
// Kalshi's settlement shows the cost of every contract bought in the market, but pays only what is still held at the close: if some were sold before the close
// (a manual trade), the record alone looks like a big loss (live 11/27 9:30 AM CT: "LOSS −$10.45" on NEAR while the account's money went UP). Held contracts can't cost over $1 each.
const settleIncomplete = s => { if (['yes_count_fp', 'yes_count', 'no_count_fp', 'no_count'].every(k => s[k] === undefined)) return false; const yc = cnt(s, 'yes_count'), nc = cnt(s, 'no_count'), ycost = d(s, 'yes_total_cost') || 0, ncost = d(s, 'no_total_cost') || 0; return ycost > yc + 0.011 || ncost > nc + 0.011; };
async function accountRaw() {
  const b = await kalshi('GET', '/portfolio/balance');
  const cash = d(b, 'balance');
  // realized profit = settled payouts minus what those positions cost, since START_TS
  const settles = await pageAll(`/portfolio/settlements?min_ts=${START_TS}`, 'settlements');
  let profit = 0;
  const pnlOf = s => d(s, 'revenue') - (d(s, 'yes_total_cost') || 0) - (d(s, 'no_total_cost') || 0) - (d(s, 'fee_cost') || 0);
  const LVx = S.paper && S.paper.late && S.paper.late.live, soldT = (LVx && LVx.soldT) || [];
  const emptySold = s => soldT.includes(s.ticker || s.market_ticker) && !(cnt(s, 'yes_count') > 0) && !(cnt(s, 'no_count') > 0); // fully sold before the close: its result was booked at the sale
  for (const s of settles) if (!emptySold(s) && !settleIncomplete(s)) profit += pnlOf(s);
  profit += (LVx && LVx.xadj) || 0; // early sales: Kalshi only settles what's still held at the close
  // report every newly settled trade
  const stime = s => Date.parse(s.settled_time || s.created_time || 0) || 0;
  if (!(S.setlTs > 0)) S.setlTs = Math.max(Date.now(), ...settles.map(stime)); // first boot: don't replay history
  const fresh = settles.filter(x => stime(x) > S.setlTs).sort((x, y) => stime(x) - stime(y));
  if (fresh.length) S.setlTs = stime(fresh[fresh.length - 1]); // claim them NOW, before any await: two scans checking the account at once both reported 12:45 PM's results and counted them twice (live 11/25)
  const setl = [];
  for (const x of fresh) {
    const pl = pnlOf(x), res = String(x.market_result || x.result || '').toUpperCase(), tk = x.ticker || x.market_ticker;
    if (soldT.includes(tk)) { log('SOLD-EARLY SETTLEMENT', JSON.stringify(x)); if (emptySold(x)) continue; } // already counted when it was sold
    if (settleIncomplete(x)) { log('SETTLEMENT INCOMPLETE', JSON.stringify(x)); setl.push({ pl: null, line: `ℹ️ ${label(tk)}: contracts were sold before the close (a manual trade?) — Kalshi's record can't show its real result, left out of the tally` }); continue; }
    await rollDay(String(startOfTodayCT()));
    if (pl >= 0) S.led.w++; else S.led.l++;
    S.led.pnl = Math.round((S.led.pnl + pl) * 100) / 100; S.led.best = Math.max(S.led.best, pl); S.led.worst = Math.min(S.led.worst, pl);
    setl.push({ pl, line: `${pl >= 0 ? '🏆 WIN' : '💔 LOSS'} ${pl >= 0 ? '+' : ''}${money(pl)} · ${label(tk)}${res ? ` → ${res}` : ''}` });
  }
  if (setl.length) { // one message per batch (a window's coins settle together) instead of one per coin
    const sc = setl.filter(y => y.pl !== null), net = sc.reduce((x, y) => x + y.pl, 0), wins = sc.filter(y => y.pl >= 0).length;
    await say(`${sc.length > 1 ? `🧾 RESULTS · ${wins}W·${sc.length - wins}L ${net >= 0 ? '+' : '−'}${money(Math.abs(net))}\n` : ''}${setl.map(y => y.line).join('\n')}\n` +
      `📊 Today ${S.led.w}W·${S.led.l}L ${S.led.pnl >= 0 ? '+' : ''}${money(S.led.pnl)} · all-time ${profit >= 0 ? '+' : ''}${money(profit)}`);
  }
  if (fresh.length) saveSettings().catch(() => {});
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
async function ensureShardFunds(idx, needed, topUp = 0) { // topUp: move enough for several orders at once (one transfer per 15-min window instead of one per coin)
  const shardCash = b => { const r = {}; for (const x of b.balance_breakdown || []) r[x.exchange_index] = Number(x.balance) || 0; return r; };
  let cash = shardCash(await kalshi('GET', '/portfolio/balance'));
  if ((cash[idx] || 0) >= needed) return;
  const [src, srcCash] = Object.entries(cash).filter(([k]) => Number(k) !== idx).sort((a, b) => b[1] - a[1])[0] || [];
  let short = Math.round((needed - (cash[idx] || 0) + 0.10) * 100) / 100;
  if (topUp > needed && srcCash > short) short = Math.round(Math.min(srcCash, Math.max(short, topUp - (cash[idx] || 0))) * 100) / 100;
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
async function placeBuy({ ticker, side, count, price, auto = false, fund = 0 }) {
  const m = (await kalshi('GET', `/markets/${ticker}`)).market || {};
  const idx = Number.isInteger(m.exchange_index) ? m.exchange_index : 0;
  await ensureShardFunds(idx, count * price + feeTotal(count, price) + 0.02, fund);
  price = Math.round(price * 100) / 100; // whole cents only
  const yesPrice = side === 'yes' ? price : 1 - price;
  const body = {
    ticker, side: side === 'yes' ? 'bid' : 'ask',
    count: (Math.floor(count * 100 + 1e-9) / 100).toFixed(2), price: yesPrice.toFixed(4), // whole or fractional contracts (a top-up after a sliver fill)
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
  if (w.traded && w.traded.paper) return `📄 paper ${w.traded.side.toUpperCase()} @ ${cents(w.traded.px)}`;
  if (w.bid && w.bid.paper) return `📄 paper bid ${w.bid.side.toUpperCase()} @ ${cents(w.bid.q)} — not filled`;
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
  const acted = done.some(([, w]) => (w.traded && w.traded !== true) || w.bid); // the main strategy bought, paper-bought or bid (true = only a buy-the-winner position, already reported)
  for (const [k] of done) delete S.win[k];
  if (CFG.QUIET === 1 && !acted) { log('RECAP', lines.join(' | ').slice(0, 900)); return; } // all skips: log only (/status still shows the last one)
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
// up/down exposure per closing time across ALL coins (all our markets are "above strike": YES = up)
function sameDirCount(close, side) {
  const r = Object.values(S.rest || {}).filter(o => Math.abs(o.close - close) < 1500 && o.side === side).length;
  const f = (S.led.auto || []).filter(x => !x.done && Math.abs(x.c - close) < 1500 && x.s === side[0] && !(x.oid && S.rest[x.oid])).length;
  if (CFG.PAPER !== 1) return r + f;
  const pb = Object.values(S.paper.bids || {}).filter(b => Math.abs(b.close - close) < 1500 && b.side === side).length;
  const pp = (S.paper.pos || []).filter(o => Math.abs(o.c - close) < 1500 && o.side === side).length;
  return pb + pp;
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
// ---------- paper trading ----------
// Same decisions as real trading, no money. Taker picks fill at the ask (+taker fee). Limit bids fill only when
// the market later offers at or below our bid — i.e. only when a real resting bid would have been hit,
// including the bad fills when price moves against us. Graded against Kalshi's real settlement.
const paperTot = () => { const r = S.paper.r || []; if (!S.paper.tot) S.paper.tot = { n: r.length, sum: Math.round(r.reduce((a, x) => a + x, 0) * 100) / 100, w: r.filter(x => x > 0).length }; return S.paper.tot; }; // all paper trades since the last reset (the saved list keeps only the latest ~50)
const paperRec = () => { const t = paperTot(); return { n: t.n, sum: t.sum, w: t.w, avg: t.n ? t.sum / t.n : 0 }; };
const paperRecent = (k = 50) => { const r = (S.paper.r || []).slice(-k); return r.length ? r.reduce((a, x) => a + x, 0) / r.length : 0; };
const paperText = () => paperTextMain() + (CFG.LATE === 1 || LATE_VARIANTS.some(x => lateRec(x.k).n) ? `\n${lateLines()}` : '') + `\n${OT.lines()}`;
const paperTextMain = () => { const { n, sum, w, avg } = paperRec(), open = (S.paper.pos || []).length, bids = Object.keys(S.paper.bids || {}).length;
  return `📄 PAPER ${CFG.PAPER === 1 ? 'TRADING ON (no real money)' : 'record'}\n🧾 ${n} graded · ${w}W·${n - w}L · ${sum >= 0 ? '+' : '−'}${money(Math.abs(sum))} (${avg >= 0 ? '+' : ''}${(avg * 100).toFixed(1)}¢ per contract)${S.paper.old ? `\n🗂 Before the 40¢ rule: ${S.paper.old.n} trades ${S.paper.old.sum >= 0 ? '+' : '−'}${money(Math.abs(S.paper.old.sum))}` : ''}\n⏳ ${open} open · ${bids} bids waiting\n🎯 Goes live after ${CFG.PAPER_PROVE_N}+ trades averaging +${Math.round(CFG.PAPER_PROVE_EDGE * 100)}¢ or better${n ? ` — now ${Math.max(0, CFG.PAPER_PROVE_N - n)} to go` : ''}`; };
function paperOpen(o) { S.paper.pos = (S.paper.pos || []).concat([o]).slice(-60); if (S.win[o.ev]) S.win[o.ev].traded = { side: o.side, px: o.px, n: 1, paper: true }; }
// ---------- "buy the winner" late-entry tests (Brad, 11/23) ----------
// On every 15-min market, wait until the 12th minute, then paper-buy whichever side is winning.
// Paper only, each variant has its own record: never touches real money, calibration, lane learning or the main go-live proof.
const LATE_VARIANTS = [{ k: 'm12', name: '12th-minute', lo: 2.25, hi: 3.0 }, // 10th-minute variant removed 11/25: −$22 over 900+ paper trades, failed its test
  { k: 'm125', name: '12½-minute', lo: 2.0, hi: 2.5, mem: true }, // Brad 11/25: buy at 12:30 into the window (open positions kept in memory only: the pinned save has no room)
  { k: 'm12b', name: '12th-min · bid 2¢ under', lo: 99, hi: -1, mem: true, bid: true }, // Brad 11/25 evening: instead of paying the ask, bid 2¢ lower and only count it if a seller comes down to us before 1 min left (real resting bid once it leads: lateBidLive)
  { k: 'm12x', name: '12th-min · sell early if it flips', lo: 99, hi: -1, mem: true, exit: true }, // Brad 11/25 evening: same buys, but sell at the bid as soon as our side drops to 45¢ or less (it flipped) with 15+ s left (real reduce-only sale once it leads: lateExitCheck)
  { k: 'h12', name: 'hourly last-12-min', lo: 10, hi: 12, slow: true }, { k: 'd12', name: 'daily last-12-min', lo: 10, hi: 12, slow: true }]; // hourly/daily (Brad 11/24): strike nearest the price when the hour/day opened, buy the leader with 12 min left // minutes LEFT: enter once 10:00 / 12:00 of the 15 have passed
// Brad 11/25 ("yes all of that"): the same 12th-minute trades, judged by four filters. Each filter keeps its own record from the m12 trades it would have taken (no extra positions to save):
// bit 1 = the bot's own price model agrees the leader is at least as safe as its price, bit 2 = calm market (no big 5-min swing, not choppy — that coin and BTC), bit 4 = no fresh market-moving news
const LATE_FILTERS = [{ k: 'cap', name: '12th-min · max 2 per side', need: 0, cap: 8 }, { k: 'mdl', name: '12th-min · model agrees', need: 1 }, { k: 'calm', name: '12th-min · calm market', need: 2 },
  { k: 'news', name: '12th-min · no fresh news', need: 4 }, { k: 'all', name: '12th-min · all filters', need: 7, cap: 16 },
  { k: 'bench', name: '12th-min · skip losing coins/hours', need: 8 | 128 }]; // bit 8 = that coin and that time of day aren't benched; 128 = entered after benching existed
// benching (Brad 11/25 evening): every 12th-minute paper trade also scores its coin and its time of day (CT); a coin or time block that keeps losing sits out until it recovers
const BN_BLOCKS = [{ k: 'o', name: 'overnight (12–6 AM)', from: 0 }, { k: 'am', name: 'morning (6–11 AM)', from: 6 }, { k: 'md', name: 'midday (11 AM–2 PM)', from: 11 }, { k: 'pm', name: 'afternoon (2–6 PM)', from: 14 }, { k: 'ev', name: 'evening (6 PM–12 AM)', from: 18 }];
const ctHourOf = ms => Number(new Date(ms).toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false })) % 24;
const bnBlock = ms => { const h = ctHourOf(ms); let b = BN_BLOCKS[0]; for (const x of BN_BLOCKS) if (h >= x.from) b = x; return b; };
const bnCoin = t => String(t).replace(/^KX/, '').replace(/(15M|D|H)?-.*$/, '');
const bnAdd = (a, pnl) => { a[2] += 1; a[3] = Math.round((a[3] + pnl) * 100) / 100; if (a[2] >= 25) { a[0] = a[2]; a[1] = a[3]; a[2] = 0; a[3] = 0; } };
const bnBad = a => { if (!a) return false; const n = a[0] + a[2]; return n >= 25 && (a[1] + a[3]) / n < -0.02; }; // a full block (25+) of recent trades averaging worse than −2¢/contract. Was 30+: right after each 25-trade rollover n is only 25, so a losing coin slipped back in for 5 trades every block (live 11/26 1:15 PM CT: NEAR's last 25 at −12.9¢/contract was trading again)
const bnState = () => { const L = lateState(); L.bn = L.bn || {}; L.bn.c = L.bn.c || {}; L.bn.t = L.bn.t || {}; return L.bn; };
const benchedNow = (ms = Date.now()) => { const B = bnState(); return [...Object.entries(B.c).filter(([, a]) => bnBad(a)).map(([c]) => c), ...BN_BLOCKS.filter(x => bnBad(B.t[x.k])).map(x => x.name)]; }; // cap: of the coins betting the same way in one window, only the 2 priced highest (one market-wide reversal can't hit 6 at once)
const lateB = (R, pnl) => { R.b = R.b || [0, 0, 0, 0]; R.b[2] += 1; R.b[3] = Math.round((R.b[3] + pnl) * 100) / 100; if (R.b[2] >= 25) R.b = [R.b[2], R.b[3], 0, 0]; }; // recent record: last full block of 25 + the current block
const lateRecent = R => { const b = (R && R.b) || [0, 0, 0, 0], n = b[0] + b[2]; return { n, avg: n ? (b[1] + b[3]) / n : 0 }; };
const lateState = () => { const L = (S.paper.late = S.paper.late || {}); L.v = L.v || {}; L.seen = L.seen || {};
  for (const x of LATE_VARIANTS) { const V = (L.v[x.k] = L.v[x.k] || { r: [], pos: [] }); V.r = V.r || []; V.pos = V.pos || [];
    if (typeof V.n !== 'number') { V.n = V.r.length; V.w = V.r.filter(y => y > 0).length; V.sum = Math.round(V.r.reduce((a, y) => a + y, 0) * 100) / 100; } // running totals (older saves only had r)
    if (!Array.isArray(V.b)) { const rr = V.r.slice(-25); V.b = [0, 0, rr.length, Math.round(rr.reduce((a, y) => a + y, 0) * 100) / 100]; } // seed the recent record from saved results
    if (typeof V.nw !== 'number') V.nw = 0; V.cs = Array.isArray(V.cs) ? V.cs : []; } // nw = 15-min windows graded, cs = recent window close times (so each window counts once)
  L.f = L.f || {}; for (const F of LATE_FILTERS) { const R = (L.f[F.k] = L.f[F.k] || { n: 0, w: 0, sum: 0, b: [0, 0, 0, 0], s0: L.v.m12.nw }); if (!Array.isArray(R.b)) R.b = [0, 0, 0, 0]; } // s0: m12's window count when the filter started
  const LV = (L.live = L.live || {}); LV.pos = LV.pos || []; LV.n = LV.n || 0; LV.w = LV.w || 0; LV.sum = LV.sum || 0; LV.cost = LV.cost || 0; // real-money 12th-minute test
  return L; };
// what goes in the pinned settings: totals + recent results + open positions (the "seen" map stays in memory — it made the save too big for Telegram)
const lateBlob = (keep = 30) => { const L = lateState(); return { v: Object.fromEntries(LATE_VARIANTS.map(x => { const V = L.v[x.k]; return [x.k, { n: V.n, w: V.w, sum: V.sum, nw: V.nw, cs: V.cs.slice(-4), b: V.b, ...(V.verdict ? { verdict: V.verdict } : {}), ...(V.miss ? { miss: V.miss } : {}), ...(V.xn ? { xn: V.xn, xs: V.xs } : {}), r: x.mem ? [] : V.r.slice(-keep), pos: x.mem ? [] : V.pos.map(o => ({ t: o.t, ev: o.ev, side: o.side, px: o.px, c: o.c, ...(o.f !== undefined ? { f: o.f } : {}), ...(o.rk !== undefined ? { rk: o.rk } : {}) })) }]; })), f: L.f, ...(L.ch ? { ch: L.ch } : {}), ...(L.bn ? { bn: L.bn } : {}), ...(L.arb ? { arb: { day: L.arb.day, n: L.arb.n, best: L.arb.best } } : {}), live: L.live, dA: L.dA || {}, hA: L.hA || {} }; };
const lateRec = k => { const V = lateState().v[k], n = V.n, sum = V.sum, w = V.w; return { n, sum, w, avg: n ? sum / n : 0 }; };
const LATE_WINDOWS = 50, LATE_PASS = 0.02; // verdict after 50 graded windows: passes at +2¢/contract or better
const lateLine = x => { const { n, sum, w, avg } = lateRec(x.k), nw = lateState().v[x.k].nw; return `⏰ ${x.name} test: ${n} trades · ${w}W·${n - w}L · ${sum >= 0 ? '+' : '−'}${money(Math.abs(sum))} (${avg >= 0 ? '+' : ''}${(avg * 100).toFixed(1)}¢/contract) · ${Math.min(nw, LATE_WINDOWS)}/${LATE_WINDOWS} windows`; };
const liveLine = () => { const LV = lateState().live, on = [lateName(lateChamp()), ...LATE_VARIANTS.filter(x => x.slow && lateState().v[x.k].verdict === 'pass').map(x => x.name)].join(' + '); return `💵 REAL ${on} (all coins): ${CFG.LATE_LIVE === 1 ? 'ON' : LV.stopped ? 'STOPPED' : 'OFF'} · ${LV.n} trades · ${LV.w}W·${LV.n - LV.w}L · ${LV.sum >= 0 ? '+' : '−'}${money(Math.abs(LV.sum))} · ${CFG.LATE_STOP >= 10000 ? 'no loss limit' : `stops at −${money(CFG.LATE_STOP)}`} · ${LV.pos.length} open` + (() => { const D = lateDay(), t = (LV.sum || 0) - D.s0; return `\n📅 Today ${t >= 0 ? '+' : '−'}${money(Math.abs(t))} (best +${money(D.pk || 0)})${D.off === 'lock' ? ' · 🔒 profit locked until midnight' : D.off === 'loss' ? ' · 🛑 day loss limit hit, back at midnight' : ` · stops at −${money(lateDayLoss())} or below ${Math.round(CFG.LOCK_KEEP * 100)}% of the day's best once it's up ${money(CFG.LOCK_MIN)}`}`; })(); };
// self-learning switch (Brad 11/25): real 15-min money follows whichever rule has proven itself best lately; with none proven it stays on the plain 12th-minute rule (Brad: keep money on)
const LATE_FAST = () => [{ k: 'm12', name: '12th-minute' }, { k: 'm125', name: '12½-minute' }, { k: 'm12b', name: '12th-min · bid 2¢ under' }, { k: 'm12x', name: '12th-min · sell early if it flips' }, ...LATE_FILTERS.map(F => ({ k: F.k, name: F.name, F }))]; // bid / sell-early: real resting bids and real selling built 11/25 evening (Brad: "Do what's needed"); like the others they only get real money after proving themselves
const lateRecOf = k => { const L = lateState(); return L.v[k] || L.f[k]; };
const lateWins = k => { const L = lateState(); return L.f[k] ? Math.max(0, L.v.m12.nw - (L.f[k].s0 || 0)) : (L.v[k] ? L.v[k].nw : 0); }; // 15-min windows each rule has been judged on
// proven = 50 windows AND 50 trades (a picky filter shares the window count: 11/25 10 PM "all filters" had 35 windows but only 22 trades), recent +2¢
const lateOk = k => { const R = lateRecOf(k), r = lateRecent(R); return lateWins(k) >= LATE_WINDOWS && ((R && R.n) || 0) >= LATE_WINDOWS && r.n >= 20 && r.avg >= LATE_PASS; };
const lateChamp = () => { const ch = lateState().ch; return LATE_FAST().some(x => x.k === ch) ? ch : 'm12'; };
const lateName = k => (LATE_FAST().find(x => x.k === k) || LATE_VARIANTS.find(x => x.k === k) || { name: k }).name;
const fLine = F => { const R = lateState().f[F.k], avg = R.n ? R.sum / R.n : 0, rc = lateRecent(R); return `🔎 ${F.name}: ${R.n} trades · ${R.w}W·${R.n - R.w}L · ${R.sum >= 0 ? '+' : '−'}${money(Math.abs(R.sum))} (${avg >= 0 ? '+' : ''}${(avg * 100).toFixed(1)}¢/contract) · ${Math.min(lateWins(F.k), LATE_WINDOWS)}/${LATE_WINDOWS} windows${rc.n ? ` · recent ${(rc.avg * 100).toFixed(1)}¢` : ''}`; };
const champLine = () => `🧠 Real 15-min money follows: ${lateName(lateChamp())} (switches by itself to any rule that beats it after ${LATE_WINDOWS} windows at +${Math.round(LATE_PASS * 100)}¢ or better)`;
const arbLine = () => { const A = lateState().arb; return `🆓 Free-money scanner today: ${A && A.day === String(startOfTodayCT()) && A.n ? `${A.n} gap${A.n > 1 ? 's' : ''} seen (best +${(A.best * 100).toFixed(1)}¢ guaranteed)` : 'no gaps seen yet'} — watching only, no money`; };
const benchLine = () => { const b = benchedNow(); return `🪑 Benched now: ${b.length ? b.join(', ') : 'nothing (every coin and time of day is above −2¢/contract)'}`; };
const lateLines = () => LATE_VARIANTS.map(x => `${lateLine(x)} · ${lateState().v[x.k].pos.length} open${x.bid ? ` · ${lateState().v[x.k].miss || 0} bids never filled` : ''}${x.exit ? ` · ${(lateState().v[x.k].xn || 0) + lateState().v[x.k].pos.filter(o => o.xp !== undefined).length} sold early (graded ones ${(lateState().v[x.k].xs || 0) >= 0 ? 'saved' : 'cost'} ${money(Math.abs(lateState().v[x.k].xs || 0))} vs holding)` : ''}`).join('\n') + '\n' + LATE_FILTERS.map(fLine).join('\n') + '\n' + benchLine() + '\n' + arbLine() + (CFG.LATE_LIVE === 1 || lateState().live.n || lateState().live.stopped ? '\n' + liveLine() + '\n' + champLine() : '');
// real money: the 12th-minute strategy on every coin, at the same moment and price the paper test buys (Brad funded $15 on 11/24 after the paper test passed: "go full blown")
// size grows with the account (1 contract per coin per LATE_PER $); never more than MAX_OPEN_PCT of the money in open positions; reserve kept
// sizing (Brad 11/25 evening): only once the rule real money follows has PROVEN itself (50+ windows at +2¢): 1 contract per $10 instead of $15, and 2× when the model and a calm market agree, 3× when there's no fresh news either
function lateSize(f) { if (!lateOk(lateChamp())) return { mult: 1, per: CFG.LATE_PER }; return { mult: 1, per: Math.min(CFG.LATE_PER, 10) }; } // 11/26: no 2×/3× — the 3× bets landed on 55¢/68¢ coin flips (−$1.70, −$2.09) and the real record shows win rate ≈ price, so bigger bets only add risk
// real 15-min money sits out what lost (11/24–26, 283 real trades, win rate ≈ price overall): leaders under 60¢ (−4.7¢/contract: a coin flip plus the
// biggest fee) and US mornings, 6–10 AM CT on US weekdays (−10.8¢: data releases and the stock open flip late leaders). Paper tests still take them.
const ctHour = () => S.testHour !== undefined ? S.testHour : Number(new Intl.DateTimeFormat('en-US', { timeZone: CFG.TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
const usMorning = () => !(env.BOT_TEST === '1' && S.testHour === undefined) && (S.testDataDay !== undefined ? S.testDataDay : news.usDataDay()) && ctHour() >= 6 && ctHour() < 10; // tests set the clock themselves
function lateDay() { const LV = lateState().live, k = String(startOfTodayCT()); if (!LV.day || LV.day.k !== k) LV.day = { k, s0: LV.sum || 0, pk: 0 }; return LV.day; } // real 15-min money's day: start, best, and whether a day limit stopped it
const lateDayLoss = () => Math.max(2, CFG.DAY_LOSS_PCT * (S.led.startCash > 0 ? S.led.startCash : 15));
function lateDayCheck() { // after real results: 🛑 day loss limit, or 🔒 profit lock once it gives back too much of the day's best. Never stops a winning run.
  const LV = lateState().live, D = lateDay(), today = Math.round(((LV.sum || 0) - D.s0) * 100) / 100; D.pk = Math.max(D.pk || 0, today);
  if (D.off) return null;
  if (CFG.DAY_LOSS_PCT > 0 && today <= -lateDayLoss()) { D.off = 'loss'; return `🛑 DAY LOSS LIMIT: real 15-min buys are down ${money(-today)} today (limit ${money(lateDayLoss())}, ${Math.round(CFG.DAY_LOSS_PCT * 100)}% of the day's starting money). No more real buys until midnight CT — practice keeps running. /set daystop 0 turns this off.`; }
  if (CFG.LOCK_KEEP > 0 && D.pk >= CFG.LOCK_MIN && today < D.pk * CFG.LOCK_KEEP) { D.off = 'lock'; return `🔒 PROFIT LOCKED: real 15-min buys were up +${money(D.pk)} at best today and are now ${today >= 0 ? '+' : '−'}${money(Math.abs(today))} — stopping to keep the rest. Real buys resume at midnight CT; practice keeps running. Wins are never capped (it only stops after giving back ${Math.round((1 - CFG.LOCK_KEEP) * 100)}% of the day's best). /set lockkeep 0 turns this off.`; }
  return null;
}
function lateLiveSkip(m, px) {
  if (!isFast(String(m.ticker).split('-')[0])) return null;
  const off = lateDay().off;
  const why = off ? (off === 'lock' ? 'profit locked for today' : 'day loss limit hit') : px < CFG.LATE_MIN ? `leader under ${cents(CFG.LATE_MIN)}` : CFG.LATE_AM === 1 && usMorning() ? 'US morning (6–10 AM CT)' : null;
  if (why) log('LATE LIVE skip', m.ticker, px, why);
  return why;
}
// Real 15-min results straight from Kalshi's settlements, split by price, coin, time of day and size: where the money is made and lost
async function realStats(sinceTs) {
  const st = await pageAll(`/portfolio/settlements?min_ts=${sinceTs}`, 'settlements'), rows = [];
  for (const x of st) {
    const tk = String(x.ticker || x.market_ticker || ''), m = tk.match(/^KX([A-Z]+)15M-/); if (!m) continue;
    const yc = cnt(x, 'yes_count'), nc = cnt(x, 'no_count'), n = yc + nc; if (!(n > 0) || settleIncomplete(x)) continue; // sold before the close: booked at the sale (or a manual trade the record can't price)
    const cost = (d(x, 'yes_total_cost') || 0) + (d(x, 'no_total_cost') || 0), pl = d(x, 'revenue') - cost - (d(x, 'fee_cost') || 0), t = Date.parse(x.settled_time || 0) || 0;
    const h = +new Intl.DateTimeFormat('en-US', { timeZone: CFG.TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date(t - 5 * 60000));
    rows.push({ coin: m[1], n, px: cost / n, pl, t, h });
  }
  const g = (key) => { const o = {}; for (const r of rows) { const k = key(r); const a = o[k] = o[k] || { n: 0, c: 0, w: 0, pl: 0 }; a.n++; a.c += r.n; if (r.pl > 0) a.w++; a.pl += r.pl; } return o; };
  const pb = r => r.px < 0.7 ? '60–69¢' : r.px < 0.8 ? '70–79¢' : r.px < 0.9 ? '80–89¢' : r.px < 0.95 ? '90–94¢' : '95¢+';
  const hb = r => r.h < 6 ? '12–6 AM' : r.h < 10 ? '6–10 AM' : r.h < 14 ? '10 AM–2 PM' : r.h < 18 ? '2–6 PM' : '6 PM–12 AM';
  return { rows, tot: g(() => 'all').all || { n: 0, c: 0, w: 0, pl: 0 }, px: g(pb), coin: g(r => r.coin), hour: g(hb), size: g(r => r.n > 1 ? '2+ contracts' : '1 contract') };
}
if (env.BOT_TEST !== '1') setTimeout(() => realStats(Math.floor(Date.now() / 1000) - 7 * 86400).then(R => log('REALSTATS', JSON.stringify({ days: 7, tot: R.tot, px: R.px, coin: R.coin, hour: R.hour, size: R.size }))).catch(e => log('REALSTATS failed', e.message)), 90e3); // after each start: the real record by price/coin/time/size, for the checks
function realStatsText(R, days) {
  const line = (k, a) => `${k}: ${a.n} · ${Math.round(a.w / a.n * 100)}% won · ${a.pl >= 0 ? '+' : '−'}${money(Math.abs(a.pl))} (${a.pl >= 0 ? '+' : ''}${(a.pl / a.c * 100).toFixed(1)}¢/contract)`;
  const sec = (title, o, order) => `${title}\n` + (order || Object.keys(o).sort((x, y) => o[y].pl - o[x].pl)).filter(k => o[k]).map(k => (o[k].pl >= 0 ? '🟢 ' : '🔴 ') + line(k, o[k])).join('\n');
  return `📊 REAL 15-MIN RESULTS · last ${days} days (from Kalshi)\n` + (R.tot.n ? line('All', R.tot) : 'no settled real trades') + '\n\n' +
    sec('💲 By price', R.px, ['60–69¢', '70–79¢', '80–89¢', '90–94¢', '95¢+']) + '\n\n' + sec('🪙 By coin', R.coin) + '\n\n' +
    sec('🕐 By time (CT)', R.hour, ['12–6 AM', '6–10 AM', '10 AM–2 PM', '2–6 PM', '6 PM–12 AM']) + '\n\n' + sec('📏 By size', R.size, ['1 contract', '2+ contracts']);
}
// how many contracts a real 12th-minute order may be: 1 per LATE_PER $ of the money (× mult), capped so open bets (and resting late bids) stay under MAX_OPEN_PCT and the reserve is kept
async function lateCount(lim, mult, per) {
  const L = lateState(), LV = L.live, a = await account(true), open = LV.pos.reduce((x, o) => x + o.cost, 0) + Object.values(L.lbids || {}).reduce((x, b) => x + Math.max(0, b.n - b.filled) * (b.q + feeTotal(1, b.q)), 0) + OT.liveOpen(), money0 = a.cash + open;
  let count = Math.max(1, Math.floor(money0 / per)) * mult; // the room check below still caps it at 60% of the money in open bets
  const room = Math.min(CFG.MAX_OPEN_PCT * money0 - open, a.cash - Math.max(resv(a), 0.02));
  while (count > 0 && count * lim + feeTotal(count, lim) > room) count--;
  return { count, room, a, open };
}
async function lateLive(m, side, px, name = '12th-minute', { mult = 1, per = CFG.LATE_PER, exit = false } = {}) {
  const LV = lateState().live;
  if (lateLiveSkip(m, px)) return;
  if (CFG.LATE_LIVE !== 1 || LV.stopped || LV.pos.some(o => o.ev === m.event_ticker) || Object.values(lateState().lbids || {}).some(b => b.ev === m.event_ticker)) return;
  const lim = Math.max(px, Math.min(CFG.LATE_MAX, Math.round((px + CFG.LATE_GRACE) * 100) / 100)); // live: a cent of room so a 1¢ tick doesn't miss the fill (live 11/24: 3 of 5 missed)
  let { count, room, a, open } = await lateCount(lim, mult, per);
  if ((a.held && a.held.has(m.event_ticker)) || restingFor(m.event_ticker)) { log('LATE LIVE skip', m.ticker, side, 'the account already holds or bids on this market (another strategy or a manual bet)'); return; } // never pay both sides of one market
  if (count < 1) { log('LATE LIVE skip', m.ticker, 'room', room.toFixed(2), 'cash', a.cash, 'open', open.toFixed(2)); return; }
  if (isFast(String(m.ticker).split('-')[0])) { // re-check the book right before the order: the account check takes ~1–2 s and a leader can collapse in between, and a buy limit has no floor
    // (live 11/26: DOGE quoted 64¢ → filled 56¢ at 12:00 PM CT, NEAR 69¢ → 53¢ at 2:30 PM CT; both lost)
    let q = null; try { q = await withLiveQuote(m); } catch (e) { log('LATE LIVE recheck failed', m.ticker, e.message); }
    if (q) { const ask = side === 'yes' ? d(q, 'yes_ask') : d(q, 'no_ask');
      if (!(ask > 0)) { log('LATE LIVE skip', m.ticker, side, 'no ask before the order'); return; }
      if (ask < px - 0.005) log('LATE LIVE recheck', m.ticker, side, 'quoted', px, 'now', ask);
      if (lateLiveSkip(m, ask)) return; } }
  let r = await placeBuy({ ticker: m.ticker, side, count, price: lim, auto: true, fund: room });
  let part = null; if (r.filled > 0 && r.filled < 1) { log('LATE LIVE partial', m.ticker, side, r.filled, 'of', count); part = r; r = { filled: 0 }; } // a sliver (live 11/25: 0.01 of a contract): keep it and try once more for the full size
  if (!(r.filled > 0)) { // missed: usually the leader got stronger in the second before the order. Re-quote once and retry if it's still the leader and at most 3¢ (and latemax) higher
    log('LATE LIVE not filled', m.ticker, side, px, 'limit', lim);
    const keep = () => { if (part) { r = part; return true; } return false; }; // nothing more filled: the sliver is still a real position
    let q; try { q = await withLiveQuote(m); } catch (e) { if (!keep()) return; q = null; }
    if (q) {
    const yb = d(q, 'yes_bid'), ya = d(q, 'yes_ask'), na = d(q, 'no_ask'), mid = (yb + ya) / 2, ask = side === 'yes' ? ya : na;
    const still = side === 'yes' ? mid >= 0.53 : mid <= 0.47, lim2 = Math.min(CFG.LATE_MAX, Math.round((ask + CFG.LATE_GRACE) * 100) / 100);
    const need = part ? Math.round((count - part.filled) * 100) / 100 : count; // after a sliver, only the rest (live 11/26 12:15 PM: 0.6 + a full 1 = 1.6 HYPE contracts)
    if (!still || !(ask > 0) || ask > Math.min(CFG.LATE_MAX, px + 0.03) || lateLiveSkip(m, ask) || need * lim2 + feeTotal(need, lim2) > room + 0.03) { log('LATE LIVE no retry', m.ticker, side, 'ask now', ask, still ? '' : 'leader changed'); if (!keep()) return; }
    else {
    r = await placeBuy({ ticker: m.ticker, side, count: need, price: lim2, auto: true });
    if (!(r.filled > 0)) { log('LATE LIVE retry not filled', m.ticker, side, 'limit', lim2); if (!keep()) return; }
    else { log('LATE LIVE retry filled', m.ticker, side, r.px);
      if (part) { const tot = part.total + r.total, n = Math.round((part.filled + r.filled) * 100) / 100; r = { filled: n, total: tot, fees: (part.fees || 0) + (r.fees || 0), px: (part.px * part.filled + r.px * r.filled) / n }; } } }
    } }
  LV.pos = LV.pos.concat([{ t: m.ticker, ev: m.event_ticker, side, px: r.px, n: r.filled, cost: Math.round(r.total * 100) / 100, c: Date.parse(m.close_time), ...(exit ? { x: 1 } : {}) }]); // x: the "sell early if it flips" rule watches this one
  log('LATE LIVE BUY', m.ticker, side, r.filled, r.px, r.total);
  await saveSettings().catch(() => {});
  S.buyBuf = (S.buyBuf || []).concat([{ name, cost: r.total, cash: a.cash - r.total, line: `${side === 'yes' ? '⬆️' : '⬇️'} ${label(m.ticker).replace(/ ≥ \$[\d,.]+/, '')} · ${r.filled} ${side.toUpperCase()} @ ${cents(r.px)} = ${money(r.total)} · win +${money(r.filled - r.total)}` }]); // sent as one message after the scan (flushBuys)
}
// weather + sports (other.js): practice bets; a rule that proves itself buys with real money here — same size, 60% cap and reserve as the crypto buys
async function otherLive(m, side, px, name) {
  const lim = Math.min(0.97, Math.round((px + CFG.LATE_GRACE) * 100) / 100);
  const { count, room } = await lateCount(lim, 1, CFG.LATE_PER);
  if (count < 1) { log('OTHER LIVE skip', m.ticker, 'room', room.toFixed(2)); return null; }
  let q = null; try { q = await withLiveQuote(m); } catch (e) { log('OTHER LIVE recheck failed', m.ticker, e.message); return null; }
  const ask = side === 'yes' ? d(q, 'yes_ask') : d(q, 'no_ask');
  if (!(ask > 0) || ask > lim || ask < px - 0.05) { log('OTHER LIVE skip', m.ticker, side, 'ask now', ask, 'quoted', px); return null; } // the price moved: the practice edge is gone
  const r = await placeBuy({ ticker: m.ticker, side, count, price: lim, auto: true, fund: room });
  if (!(r.filled > 0)) { log('OTHER LIVE not filled', m.ticker, side, lim); return null; }
  log('OTHER LIVE BUY', m.ticker, side, r.filled, r.px, r.total);
  try { const ps = await kalshi('GET', '/portfolio/positions?count_filter=position&limit=1000'), p = (ps.market_positions || []).find(x => x.ticker === m.ticker), held = p ? Math.abs(cnt(p, 'position')) : 0; // after the buy: Kalshi must show the position
    if (held + 1e-9 < r.filled) { log('OTHER LIVE VERIFY mismatch', m.ticker, 'filled', r.filled, 'Kalshi shows', held); say(`⚠️ Check: bought ${r.filled} of ${m.ticker} but Kalshi shows ${held} — flagged.`).catch(() => {}); } else log('OTHER LIVE VERIFIED', m.ticker, held); } catch (e) { log('OTHER LIVE verify failed', m.ticker, e.message); }
  S.buyBuf = (S.buyBuf || []).concat([{ name, cost: r.total, cash: (acctCache ? acctCache.v.cash : 0), line: `${side === 'yes' ? '⬆️' : '⬇️'} ${m.ticker} · ${r.filled} ${side.toUpperCase()} @ ${cents(r.px)} = ${money(r.total)} · win +${money(r.filled - r.total)}` }]);
  return { n: r.filled, px: r.px, cost: Math.round(r.total * 100) / 100 };
}
const OT = other.create({ kalshi, req, log, say: t => say(t), feeTotal, money, cents, cfg: () => CFG, save: () => saveSettings().catch(() => {}), realBuy: otherLive, quote: m => withLiveQuote(m) });
async function flushConds() { // coins paused/cleared in the same scan share one message (one ETH drop paused all 9 coins = 18 messages on 11/25)
  const b = S.condBuf || []; if (!b.length) return; S.condBuf = [];
  const by = {}; for (const x of b) { const k = x.on ? 'P' + x.why : 'C'; (by[k] = by[k] || []).push(x.coin); }
  const out = Object.entries(by).map(([k, cs]) => k === 'C' ? `✅ ${cs.join(', ')} conditions clear again — trading resumed.` : `🚧 ${cs.join(', ')} trading paused — ${k.slice(1)}. I'll tell you when it clears.`);
  await say(out.join('\n'));
}
async function flushBuys() { // all of a window's real buys in ONE Telegram message (was one per coin)
  const b = S.buyBuf || []; if (!b.length) return; S.buyBuf = [];
  const names = [...new Set(b.map(x => x.name))].join(' + '), cost = b.reduce((x, y) => x + y.cost, 0);
  await say(`💵 REAL BUY (${names}) · ${b.length} coin${b.length > 1 ? 's' : ''}\n${b.map(x => x.line).join('\n')}\n💸 ${money(cost)} at risk · 💰 Wallet ≈ ${money(b[b.length - 1].cash)}`);
}
// what the filters see at the moment of a 12th-minute entry (bits: 1 model agrees, 2 calm market, 4 no fresh news)
function lateNewsBusy(now = Date.now()) { // Brad 11/25: "pay attention to the news it's putting out, it can affect the market"
  if (env.BOT_TEST !== '1' && news.releaseWindow(now)) return 'just after a scheduled US data release'; // tests: real clock time must not change results
  const it = (S.newsLog || []).find(x => (x.level === 'macro' || x.level === 'critical') && now - (x.got || 0) < 15 * 60e3);
  if (it) return `fresh news: ${String(it.title).slice(0, 60)}`;
  if (S.newsPauseUntil && now >= S.newsPauseUntil && now - S.newsPauseUntil < 10 * 60e3) return 'news pause just ended';
  return null;
}
function lateFlags(m, side, px, cond) {
  let f = 0; const st = cond && cond[CFG.SPOT[String(m.event_ticker).split('-')[0]]], btc = cond && cond['BTC-USD'];
  if (st && st.spot > 0) { const sd = evaluate(m, st).find(x => x.side === side); if (sd && sd.raw - px - 0.07 * px * (1 - px) >= 0.01) f |= 1; } // the bot's own odds beat the price (after the fee)
  const wild = x => !x || !(x.sig5h > 0) || x.sig15 > 1.5 * x.sig5h || Math.abs(x.z5) > 2; // choppy, or a 2-sigma 5-minute swing
  if (st && !wild(st) && !wild(btc)) f |= 2;
  if (!lateNewsBusy()) f |= 4;
  const B = bnState(); if (!bnBad(B.c[bnCoin(m.ticker)]) && !bnBad(B.t[bnBlock(Date.now()).k])) f |= 8; // coin and time of day not benched
  return f | 128;
}
async function lateEntry(m, mins, k, cond) {
  const L = lateState(), xs = k ? [LATE_VARIANTS.find(v => v.k === k)] : LATE_VARIANTS.filter(v => !v.slow && mins >= v.lo && mins <= v.hi); // 12th and 12½-minute windows overlap: one quote serves both
  const todo = xs.filter(x => x && !L.seen[x.k + '|' + m.event_ticker] && !L.v[x.k].pos.some(o => o.ev === m.event_ticker));
  if (!todo.length || S.paused || eventPause()) return;
  try { m = await withLiveQuote(m); } catch (e) { return; }
  const yb = d(m, 'yes_bid'), ya = d(m, 'yes_ask'), na = d(m, 'no_ask'); if (!(ya > 0 && na > 0 && yb >= 0)) { if (k && !(S.lateNoPx = S.lateNoPx || {})[k + '|' + m.event_ticker]) { S.lateNoPx[k + '|' + m.event_ticker] = 1; log('LATE skip', k, m.ticker, 'no seller on one side (already decided)', 'yes ask', ya, 'no ask', na); } return; } // 11/25 3:48 PM: 6 of 7 daily strikes were skipped without a word
  const mid = (yb + ya) / 2; let side = null, px = null;
  if (mid >= 0.53) { side = 'yes'; px = ya; } else if (mid <= 0.47) { side = 'no'; px = na; }
  for (const [kk, t] of Object.entries(L.seen)) if (Date.now() - t > 6 * 3600e3) delete L.seen[kk];
  const champ = lateChamp(), CF = LATE_FILTERS.find(F => F.k === champ);
  for (const x of todo) {
    L.seen[x.k + '|' + m.event_ticker] = Date.now();
    if (!side) { log('LATE skip', x.k, m.ticker, 'no clear leader', mid.toFixed(3)); continue; }
    if (px > CFG.LATE_MAX) { log('LATE skip', x.k, m.ticker, side, 'price', px, '> max', CFG.LATE_MAX); continue; }
    const V = L.v[x.k], o = { t: m.ticker, ev: m.event_ticker, side, px, c: Date.parse(m.close_time), at: Date.now() };
    if (!x.slow) o.f = lateFlags(m, side, px, cond);
    if (x.k === 'm12') { const bid = lateBidPx(px); if (bid > 0) (L.bids = L.bids || {})[m.event_ticker] = { t: m.ticker, ev: m.event_ticker, side, bid, c: o.c }; // the "bid 2¢ under" test waits for a seller at this price
      const X = L.v.m12x; if (!X.pos.some(y => y.ev === m.event_ticker)) X.pos = X.pos.concat([{ t: m.ticker, ev: m.event_ticker, side, px, c: o.c, at: Date.now() }]).slice(-80); } // the "sell early" twin
    V.pos = V.pos.concat([o]).slice(-80);
    log('LATE', x.k, m.ticker, side, px, `${mins.toFixed(1)} min left`, o.f !== undefined ? `filters ${o.f & 1 ? 'M' : '-'}${o.f & 2 ? 'C' : '-'}${o.f & 4 ? 'N' : '-'}` : '');
    const fail = e => { log('LATE LIVE failed', m.ticker, e.message); return say(`⚠️ Real ${x.name} buy failed: ${String(e.message).replace(/^.*?-> /, '').slice(0, 200)} — no money spent on this one.`); };
    if (x.slow) { if (V.verdict === 'pass') await lateLive(m, side, px, x.name).catch(fail); } // hourly/daily: real money once their own test passed
    else if (x.k === champ) await lateLive(m, side, px, x.name, lateSize(o.f)).catch(fail); // the 15-min rule real money follows right now
    else if (x.k === 'm12' && champ === 'm12x') await lateLive(m, side, px, lateName('m12x'), { ...lateSize(o.f), exit: true }).catch(fail); // same buy, then sold early if it flips (lateExitCheck)
    else if (x.k === 'm12' && champ === 'm12b') await lateBidLive(m, side, px, lateName('m12b'), lateSize(o.f)).catch(fail); // a real bid 2¢ under instead of paying the ask
    else if (x.k === 'm12' && CF && (o.f & CF.need) === CF.need) { if (CF.cap) (S.liveCand = S.liveCand || []).push({ m, side, px, name: CF.name, f: o.f }); else await lateLive(m, side, px, CF.name, lateSize(o.f)).catch(fail); } // a filter rule leads: buy only what it would
  }
  await saveSettings().catch(() => {});
}
// "bid 2¢ under": the bid is whole cents (Kalshi only takes whole-cent orders), 2¢ under the ask we'd have paid
const lateBidPx = px => Math.floor((px - 0.02) * 100 + 1e-9) / 100;
const sideBid = (m, side) => { const ya = d(m, 'yes_ask'); return side === 'yes' ? d(m, 'yes_bid') : (d(m, 'no_bid') > 0 ? d(m, 'no_bid') : (ya > 0 ? 1 - ya : NaN)); }; // what a buyer pays for our side right now
// paper test: filled only if the ask on our side comes down to our bid before 1 min left (a seller would have hit it); otherwise it's a miss.
// Real (once this rule leads real money): the same bid really rests on Kalshi and expires by itself at 1 min left (so a restart can't leave one behind).
async function lateBidCheck(m, mins) {
  const L = lateState(), B = (L.bids || {})[m.event_ticker];
  if (B && B.t === m.ticker) { const V = L.v.m12b;
    if (mins < 1.0) { delete L.bids[m.event_ticker]; V.miss = (V.miss || 0) + 1; log('LATE BID missed', m.ticker, B.side, B.bid); }
    else { const ask = d(m, B.side + '_ask');
      if (ask > 0 && ask <= B.bid + 1e-9) { delete L.bids[m.event_ticker]; V.pos = V.pos.concat([{ t: B.t, ev: B.ev, side: B.side, px: B.bid, c: B.c, at: Date.now() }]).slice(-80); log('LATE BID filled', m.ticker, B.side, B.bid, `${mins.toFixed(1)} min left`); } } }
  for (const b of Object.values(L.lbids || {})) {
    if (b.t !== m.ticker) continue;
    if (mins < 1.0 || S.paused || CFG.LATE_LIVE !== 1) await lateBidCancel(b, mins < 1.0 ? 'no seller came down by 1 min left' : 'real buying is off or paused');
    else { const ask = d(m, b.side + '_ask'); if (ask > 0 && ask <= b.q + 0.005) await lateBidFills(b); } // the ask touched our price: see what filled
  }
}
async function lateBidLive(m, side, px, name, { mult = 1, per = CFG.LATE_PER } = {}) {
  if (lateLiveSkip(m, px)) return;
  const L = lateState(), LV = L.live, LB = (L.lbids = L.lbids || {}); // memory only (the pinned save has no room); each order expires on Kalshi by itself
  if (CFG.LATE_LIVE !== 1 || LV.stopped || S.paused || LV.pos.some(o => o.ev === m.event_ticker) || Object.values(LB).some(b => b.ev === m.event_ticker)) return;
  const q = lateBidPx(px), close = Date.parse(m.close_time), exp = Math.floor((close - 60e3) / 1000);
  if (!(q >= 0.01) || exp * 1000 < Date.now() + 15e3) { log('LATE BID LIVE skip', m.ticker, 'bid', q, 'too late'); return; }
  const { count, room, a, open } = await lateCount(q, mult, per);
  if (count < 1) { log('LATE BID LIVE skip', m.ticker, 'room', room.toFixed(2), 'cash', a.cash, 'open', open.toFixed(2)); return; }
  const mk = (await kalshi('GET', `/markets/${m.ticker}`)).market || {}, idx = Number.isInteger(mk.exchange_index) ? mk.exchange_index : 0;
  await ensureShardFunds(idx, count * q + feeTotal(count, q) + 0.02, room);
  const body = { ticker: m.ticker, side: side === 'yes' ? 'bid' : 'ask', count: count + '.00', price: (side === 'yes' ? q : 1 - q).toFixed(4),
    time_in_force: 'good_till_canceled', expiration_time: exp, self_trade_prevention_type: 'taker_at_cross', client_order_id: 'kbot-' + crypto.randomUUID(), exchange_index: idx };
  const o = await kalshi('POST', '/portfolio/events/orders', body);
  log('LATE BID LIVE', JSON.stringify(body), '->', JSON.stringify(o)); acctCache = null;
  LB[o.order_id] = { id: o.order_id, t: m.ticker, ev: m.event_ticker, side, q, n: count, c: close, name, filled: 0, cost: 0, fees: 0, cash: a.cash };
  if (num(o.fill_count) > 0) await lateBidFills(LB[o.order_id]); // the ask was already at our price: filled on the spot
}
// book whatever of a real late bid has filled (from Kalshi's own fills) as a real 12th-minute position
async function lateBidFills(b) {
  const fills = await pageAll(`/portfolio/fills?order_id=${b.id}`, 'fills');
  let n = 0, cost = 0, fees = 0;
  for (const f of fills) { const c = num(f.count_fp ?? f.count), px = b.side === 'yes' ? num(f.yes_price_dollars) : num(f.no_price_dollars); if (!(c > 0) || !(px > 0)) continue; n += c; cost += c * px; fees += d(f, 'fee_cost') || 0; }
  n = Math.round(n * 100) / 100;
  if (!(n > b.filled + 1e-9)) return false;
  const dn = Math.round((n - b.filled) * 100) / 100, total = Math.round((cost + fees - b.cost - b.fees) * 10000) / 10000, dFee = fees - b.fees, LV = lateState().live;
  b.filled = n; b.cost = cost; b.fees = fees;
  await rollDay(String(startOfTodayCT())); S.led.spent += total; S.led.n++; S.led.nAuto++; S.led.fees += dFee;
  const P = LV.pos.find(o => o.oid === b.id);
  if (P) { P.n = n; P.cost = Math.round((cost + fees) * 100) / 100; P.px = Math.round(cost / n * 10000) / 10000; }
  else LV.pos = LV.pos.concat([{ t: b.t, ev: b.ev, side: b.side, px: Math.round(cost / n * 10000) / 10000, n, cost: Math.round((cost + fees) * 100) / 100, c: b.c, oid: b.id }]);
  if (b.filled >= b.n - 1e-9) delete (lateState().lbids || {})[b.id];
  log('LATE BID LIVE filled', b.t, b.side, dn, 'of', b.n, '@', b.q);
  S.buyBuf = (S.buyBuf || []).concat([{ name: b.name, cost: total, cash: b.cash - (cost + fees), line: `${b.side === 'yes' ? '⬆️' : '⬇️'} ${label(b.t).replace(/ ≥ \$[\d,.]+/, '')} · ${dn} ${b.side.toUpperCase()} @ ${cents(b.q)} (bid, not ask 💡) = ${money(total)} · win +${money(dn - total)}` }]); // sent with the scan's other buys (flushBuys)
  acctCache = null; await saveSettings().catch(() => {});
  return true;
}
async function lateBidCancel(b, why) {
  try { const r = await kalshi('DELETE', `/portfolio/events/orders/${b.id}?market_ticker=${encodeURIComponent(b.t)}`); log('LATE BID LIVE cancel', b.id, b.t, why, JSON.stringify(r)); }
  catch (e) { if (!/404|not.?found/i.test(e.message)) { log('late bid cancel failed', b.id, e.message); if (Date.now() < b.c - 60e3) return false; } } // 404: already gone (expired or filled); a failed cancel is retried next scan until Kalshi's own expiry (1 min left) has ended it
  try { await lateBidFills(b); } catch (e) { log('late bid fills check failed', e.message); }
  delete (lateState().lbids || {})[b.id]; acctCache = null;
  if (!(b.filled > 0)) log('LATE BID LIVE missed', b.t, b.side, b.q, why);
  return true;
}
// sell (part of) a position we hold: reduce_only, so Kalshi caps it at what we really hold and it can never open or grow a position
async function placeSell({ ticker, side, count, price }) {
  const m = (await kalshi('GET', `/markets/${ticker}`)).market || {}, idx = Number.isInteger(m.exchange_index) ? m.exchange_index : 0;
  price = Math.max(0.01, Math.round(price * 100) / 100); // whole cents: the least we accept per contract
  const body = { ticker, side: side === 'yes' ? 'ask' : 'bid', count: (Math.floor(count * 100 + 1e-9) / 100).toFixed(2), price: (side === 'yes' ? price : 1 - price).toFixed(4),
    time_in_force: 'immediate_or_cancel', reduce_only: true, self_trade_prevention_type: 'taker_at_cross', client_order_id: 'kbot-' + crypto.randomUUID(), exchange_index: idx };
  const o = await kalshi('POST', '/portfolio/events/orders', body);
  log('SELL', JSON.stringify(body), '->', JSON.stringify(o)); acctCache = null;
  const filled = num(o.fill_count) || 0, avgYes = num(o.average_fill_price), px = avgYes === avgYes ? (side === 'yes' ? avgYes : 1 - avgYes) : price;
  const fees = num(o.average_fee_paid) === num(o.average_fee_paid) ? num(o.average_fee_paid) * filled : feeTotal(filled, px);
  if (filled > 0) { await rollDay(String(startOfTodayCT())); S.led.fees += fees; }
  return { filled, px, fees, got: filled * px - fees };
}
// "sell early if it flips": once our side's bid is 45¢ or less with 15+ seconds left, sell there (both fees counted) instead of riding it to $0.
// Paper: every m12 trade's twin. Real (once this rule leads real money): the real position bought for it, re-checked on the live order book first.
async function lateExitCheck(m, mins) {
  for (const o of lateState().v.m12x.pos) {
    if (o.t !== m.ticker || o.xp !== undefined || mins < 0.25) continue;
    const sp = sideBid(m, o.side);
    if (sp > 0 && sp <= 0.45) { o.xs = sp; o.xp = Math.round((sp - o.px - 0.07 * o.px * (1 - o.px) - 0.07 * sp * (1 - sp)) * 100) / 100; log('LATE EXIT', m.ticker, o.side, 'bought', o.px, 'sold', sp, `${mins.toFixed(1)} min left`, o.xp); }
  }
  const LV = lateState().live;
  for (const o of LV.pos) {
    if (!o.x || o.t !== m.ticker || (o.sn || 0) >= o.n - 1e-9 || mins < 0.25 || mins > 15 || (o.xt || 0) >= 4 || S.paused || CFG.LATE_LIVE !== 1) continue;
    if (!(sideBid(m, o.side) <= 0.45)) continue;
    let q; try { q = await withLiveQuote(m); } catch (e) { continue; }
    const sp = sideBid(q, o.side); if (!(sp > 0 && sp <= 0.45)) continue; // the live book disagrees: keep holding
    o.xt = (o.xt || 0) + 1;
    const left = Math.round((o.n - (o.sn || 0)) * 100) / 100, r = await placeSell({ ticker: o.t, side: o.side, count: left, price: sp - 0.01 }); // a cent of room so a 1¢ tick doesn't miss it
    if (!(r.filled > 0)) { log('LATE SELL not filled', o.t, o.side, left, 'bid', sp, 'try', o.xt); continue; }
    const basis = o.cost * r.filled / o.n, pl = Math.round((r.got - basis) * 100) / 100;
    o.sn = Math.round(((o.sn || 0) + r.filled) * 100) / 100; o.sp = Math.round(((o.sp || 0) + r.got) * 10000) / 10000;
    LV.xadj = Math.round(((LV.xadj || 0) + pl) * 100) / 100; // Kalshi's settlements only cover what's still held at the close, so the all-time profit adds sales here
    const done = o.sn >= o.n - 1e-9; if (done) LV.soldT = (LV.soldT || []).concat([o.t]).slice(-12);
    S.led.pnl = Math.round((S.led.pnl + pl) * 100) / 100; if (done) { if (pl >= 0) S.led.w++; else S.led.l++; S.led.worst = Math.min(S.led.worst, pl); }
    log('LATE SELL', o.t, o.side, r.filled, '@', r.px, 'bought', o.px, 'pnl', pl, `${mins.toFixed(1)} min left`);
    const hold = Math.round(o.cost * r.filled / o.n * 100) / 100;
    await say(`🔻 SOLD EARLY (${lateName('m12x')}) · ${label(o.t).replace(/ ≥ \$[\d,.]+/, '')}\n${r.filled} ${o.side.toUpperCase()} bought @ ${cents(o.px)} → sold @ ${cents(r.px)} with ${mins.toFixed(1)} min left: ${pl >= 0 ? '+' : '−'}${money(Math.abs(pl))} (riding it to a loss would be −${money(hold)})\n📊 Today ${S.led.w}W·${S.led.l}L ${S.led.pnl >= 0 ? '+' : ''}${money(S.led.pnl)}`);
    await saveSettings().catch(() => {});
  }
}
// "max 2 per side" leading: the scan's candidates are ranked after it (all coins share the window), and only the 2 priced highest per side are bought
async function flushLiveCand() {
  const c = S.liveCand || []; if (!c.length) return; S.liveCand = [];
  const LV = lateState().live, by = {};
  for (const x of c) { const g = Date.parse(x.m.close_time) + '|' + x.side; (by[g] = by[g] || []).push(x); }
  for (const [g, xs] of Object.entries(by)) {
    const [cl, sd] = g.split('|'), have = LV.pos.filter(o => o.c === +cl && o.side === sd).length;
    for (const x of xs.sort((p, q) => q.px - p.px).slice(0, Math.max(0, 2 - have))) await lateLive(x.m, x.side, x.px, x.name, lateSize(x.f)).catch(e => { log('LATE LIVE failed', x.m.ticker, e.message); return say(`⚠️ Real ${x.name} buy failed: ${String(e.message).replace(/^.*?-> /, '').slice(0, 200)} — no money spent on this one.`); });
  }
}
// hourly/daily ladders: pin the strike nearest the price as the hour (or day) opens, then at 12 min left buy whichever side of it is winning
// free-money scanner (Brad 11/25 evening; watching only): on one hourly/daily ladder every strike settles on the same price, so YES on a lower strike + NO on the next strike up pays at least $1.
// If that pair costs under $1 after fees, the profit is guaranteed. Logged and counted, nothing bought.
function lateArb(byEv, now) {
  const L = lateState(), today = String(startOfTodayCT()); if (!L.arb || L.arb.day !== today) L.arb = { day: today, n: 0, best: 0 }; S.arbSeen = S.arbSeen || {};
  for (const [ev, ms] of Object.entries(byEv)) {
    const lad = ms.filter(m => String(m.strike_type).startsWith('greater') && Number.isFinite(num(m.floor_strike))).sort((a, b) => num(a.floor_strike) - num(b.floor_strike));
    if (lad.length < 2 || (Date.parse(lad[0].close_time) - now) / 60000 < 1) continue;
    for (let i = 0; i + 1 < lad.length; i++) {
      const lo = lad[i], hi = lad[i + 1], ya = d(lo, 'yes_ask'), na = d(hi, 'no_ask'); if (!(ya > 0 && na > 0)) continue;
      const gain = Math.round((1 - ya - na - feeTotal(1, ya) - feeTotal(1, na)) * 1000) / 1000;
      if (gain <= 0.005) continue;
      const key = `${lo.ticker}|${hi.ticker}`; if (S.arbSeen[key] && now - S.arbSeen[key] < 3600e3) continue; S.arbSeen[key] = now;
      L.arb.n += 1; L.arb.best = Math.max(L.arb.best, gain); saveSettings().catch(() => {});
      log('ARB', ev, `YES ${lo.ticker} @ ${ya} + NO ${hi.ticker} @ ${na}`, `guaranteed +${(gain * 100).toFixed(1)}¢ (+$${(1 + gain).toFixed(2)} if it lands between)`);
    }
  }
  for (const [k, t] of Object.entries(S.arbSeen)) if (now - t > 6 * 3600e3) delete S.arbSeen[k];
}
async function lateLadder(markets, now) {
  const L = lateState(), HA = (L.hA = L.hA || {}), DA = (L.dA = L.dA || {}), byEv = {}; // anchors are saved (a restart mustn't lose the hour's/day's strike)
  for (const m of markets) (byEv[m.event_ticker] = byEv[m.event_ticker] || []).push(m);
  try { lateArb(byEv, now); } catch (e) { log('arb scan failed', e.message); }
  for (const [ev, ms] of Object.entries(byEv)) {
    const close = Date.parse(ms[0].close_time), mins = (close - now) / 60000, daily = isDailyClose(ms[0].close_time), len = daily ? 1440 : 60, A = daily ? DA : HA;
    if (!A[ev] && mins <= len && mins >= (daily ? 720 : len - 5)) { // hourly: as the hour opens; daily: as soon as it's listed in the first half of its day // window just opened: the at-the-money strike
      let best = null; for (const m of ms) { const yb = d(m, 'yes_bid'), ya = d(m, 'yes_ask'); if (!(ya > 0 && yb >= 0)) continue; const gap = Math.abs((yb + ya) / 2 - 0.5); if (!best || gap < best.gap) best = { t: m.ticker, gap }; }
      if (best) { A[ev] = { t: best.t, c: close }; log('LATE anchor', daily ? 'd12' : 'h12', best.t, `${Math.round(mins)} min left`); await saveSettings().catch(() => {}); }
    }
    if (A[ev] && mins >= 10 && mins <= 12) { /* 2-minute entry window so one late scan or a short pause doesn't miss the hour */ const m = ms.find(x => x.ticker === A[ev].t); if (m) await lateEntry(m, mins, daily ? 'd12' : 'h12'); else log('LATE skip', daily ? 'd12' : 'h12', A[ev].t, 'anchored strike no longer listed'); }
  }
  for (const A of [HA, DA]) for (const [ev, a] of Object.entries(A)) if (now > a.c) delete A[ev]; // an anchor is only needed until its window closes (keeps the saved settings small)
}
function lateReChamp() { // pick the 15-min rule real money follows; returns the Telegram note when it changes
  const L = lateState(), cur = lateChamp(), pct = k => `${(lateRecent(lateRecOf(k)).avg * 100).toFixed(1)}¢`;
  const ok = LATE_FAST().filter(x => lateOk(x.k)).sort((p, q) => lateRecent(lateRecOf(q.k)).avg - lateRecent(lateRecOf(p.k)).avg), best = ok[0];
  let next = cur;
  if (!best) next = 'm12'; // nothing proven: Brad's keep-money-on choice — the plain 12th-minute rule
  else if (best.k !== cur && (!lateOk(cur) || lateRecent(lateRecOf(best.k)).avg >= lateRecent(lateRecOf(cur)).avg + 0.01)) next = best.k; // a clear winner (≥1¢ better) or the current one stopped proving itself
  if (next === cur) return null;
  L.ch = next; log('LATE CHAMP', cur, '->', next);
  return next === 'm12' && !best ? `🧠 SELF-LEARNING: "${lateName(cur)}" stopped proving itself (recent ${pct(cur)}/contract) — real 15-min money is back on the plain 12th-minute rule.`
    : `🧠 SELF-LEARNING SWITCH: real 15-min money now follows "${lateName(next)}" — recent ${pct(next)}/contract over its last ${lateRecent(lateRecOf(next)).n} trades, ${lateWins(next)} windows (was "${lateName(cur)}" at ${pct(cur)}).\n📈 It's proven, so bets grow with the account: 1 contract per $10 (was $${CFG.LATE_PER}).`;
}
async function lateGrade() {
  const L = lateState(), parts = [], verdicts = []; let graded = false;
  for (const x of LATE_VARIANTS) {
    const V = L.v[x.k], due = V.pos.filter(o => Date.now() > o.c + 3 * 60e3).sort((a, b) => a.c - b.c), lines = [];
    if (x.k === 'm12') { // rank each closed window once (all its coins are in by now): the 2 priced highest per side pass the "max 2 per side" filters
      const byW = {}; for (const o of due) if (o.f !== undefined && o.rk === undefined) (byW[o.c + '|' + o.side] = byW[o.c + '|' + o.side] || []).push(o);
      for (const g of Object.values(byW)) { const all = V.pos.filter(o => o.c === g[0].c && o.side === g[0].side && o.f !== undefined), top = (xs) => xs.slice().sort((p, q) => q.px - p.px).slice(0, 2);
        for (const o of all) o.rk = 0; for (const o of top(all)) o.rk |= 8; for (const o of top(all.filter(o => (o.f & 7) === 7))) o.rk |= 16; } }
    for (const o of due) {
      let m; try { m = (await kalshi('GET', `/markets/${o.t}`)).market || {}; } catch (e) { continue; }
      const res = String(m.result || '').toLowerCase();
      if (res !== 'yes' && res !== 'no') { if (Date.now() > o.c + 6 * 3600e3) V.pos = V.pos.filter(y => y !== o); continue; }
      let win = res === o.side ? 1 : 0, pnl = Math.round((win - o.px - 0.07 * o.px * (1 - o.px)) * 100) / 100; // taker fee included
      if (x.exit && o.xp !== undefined) { V.xn = (V.xn || 0) + 1; V.xs = Math.round(((V.xs || 0) + o.xp - pnl) * 100) / 100; pnl = o.xp; win = pnl > 0 ? 1 : 0; } // sold early: its sale is the result (and how it compared with holding)
      graded = true; V.r = V.r.concat([pnl]).slice(-100); V.n += 1; V.w += win; V.sum = Math.round((V.sum + pnl) * 100) / 100; V.pos = V.pos.filter(y => y !== o); lateB(V, pnl);
      if (x.k === 'm12') { const B = bnState(), cn = bnCoin(o.t), bk = bnBlock(o.c - 3 * 60e3).k; bnAdd(B.c[cn] = B.c[cn] || [0, 0, 0, 0], pnl); bnAdd(B.t[bk] = B.t[bk] || [0, 0, 0, 0], pnl); } // score the coin and the time of day
      if (x.k === 'm12' && o.f !== undefined) for (const F of LATE_FILTERS) if ((o.f & F.need) === F.need && (!F.cap || (o.rk & F.cap))) { const R = L.f[F.k]; R.n += 1; R.w += win; R.sum = Math.round((R.sum + pnl) * 100) / 100; lateB(R, pnl); } // each filter's record: the m12 trades it would have taken
      { const wk = Math.round(o.c / 60e3); if (!V.cs.includes(wk)) { V.cs = V.cs.concat([wk]).slice(-10); V.nw += 1; } } // one count per 15-min window (all coins share its close minute)
      if (x.slow || (x.k === 'm12' && CFG.LATE_LIVE !== 1)) lines.push(`${win ? '✅' : '❌'} ${label(o.t).replace(/ ≥ \$[\d,.]+/, '')} ${o.side.toUpperCase()} @ ${cents(o.px)} ${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}`); // with real money on, the 12th-minute paper twin would repeat the real results message; 15-min test variants: totals only (every 15 min would be spam)
      else if (x.k !== 'm12') log('LATE GRADED', x.k, o.t, o.side, o.px, pnl);
    }
    if (lines.length) parts.push(`${x.name}:\n${lines.join('\n')}`);
    if (V.nw >= LATE_WINDOWS && !V.verdict) { const { avg } = lateRec(x.k); V.verdict = avg >= LATE_PASS ? 'pass' : 'fail';
      const next = x.slow ? 'Real money now buys it too (1 contract per coin per $' + CFG.LATE_PER + ').' : 'The self-learning switch moves real 15-min money to it if it stays the best rule.';
      verdicts.push(V.verdict === 'pass' ? `✅ ${x.name} test PASSED after ${V.nw} windows: ${(avg * 100).toFixed(1)}¢/contract (needed +${Math.round(LATE_PASS * 100)}¢). ${next}` : `❌ ${x.name} test FAILED after ${V.nw} windows: ${(avg * 100).toFixed(1)}¢/contract (needed +${Math.round(LATE_PASS * 100)}¢). It keeps recording, but this idea isn't profitable as-is.`); }
  }
  { const LV = L.live, lines = []; lateDay(); // a new day starts from the record as it stood before these results
    for (const o of LV.pos.filter(o => Date.now() > o.c + 3 * 60e3)) {
      let m; try { m = (await kalshi('GET', `/markets/${o.t}`)).market || {}; } catch (e) { continue; }
      const res = String(m.result || '').toLowerCase(); if (res !== 'yes' && res !== 'no') continue; // real money: keep waiting for Kalshi's result
      const held = res === o.side ? 1 : 0, pnl = Math.round((held * (o.n - (o.sn || 0)) + (o.sp || 0) - o.cost) * 100) / 100, win = o.sn > 0 ? (pnl > 0 ? 1 : 0) : held; // sold early: the sale plus whatever was still held
      LV.n += 1; LV.w += win; LV.sum = Math.round((LV.sum + pnl) * 100) / 100; LV.cost = Math.round((LV.cost + o.cost) * 100) / 100; LV.pos = LV.pos.filter(y => y !== o);
      lines.push(`${win ? '✅' : '❌'} ${label(o.t).replace(/ ≥ \$[\d,.]+/, '')} ${o.side.toUpperCase()} @ ${cents(o.px)} ${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}`);
    }
    if (lines.length) { // Kalshi's own settlement message (🧾 RESULTS) already tells Brad each real win/loss: log only here
      log('LATE LIVE', lines.join(' | ')); log('LATE LIVE RECORD', `n=${LV.n} w=${LV.w} sum=${LV.sum.toFixed(2)}`); graded = true;
      const dl = lateDayCheck(); if (dl) { log('LATE DAY', JSON.stringify(lateDay())); verdicts.push(dl); }
      if (CFG.LATE_LIVE === 1 && LV.sum - (LV.base || 0) <= -CFG.LATE_STOP) { /* limit counts from when real trading was last switched back on */ CFG.LATE_LIVE = 0; LV.stopped = Date.now(); verdicts.push(`🛑 REAL 12th-minute test STOPPED itself: down ${money(-LV.sum)} (limit ${money(CFG.LATE_STOP)}). No more real buys. /set latelive 1 restarts it.`); }
    } }
  if (graded) { log('LATE RECORD', LATE_VARIANTS.map(x => { const r = lateRec(x.k); return `${x.k} n=${r.n} w=${r.w} sum=${r.sum.toFixed(2)}`; }).join(' | ') + ' || ' + LATE_FILTERS.map(F => { const R = L.f[F.k]; return `${F.k} n=${R.n} w=${R.w} sum=${R.sum.toFixed(2)} win=${lateWins(F.k)}`; }).join(' | ')); // full totals in the log (Telegram log lines are truncated)
    const sw = lateReChamp(); if (sw) verdicts.push(sw); }
  if (!parts.length && !verdicts.length) { if (graded) await saveSettings().catch(() => {}); return; }
  await say(`⏰ BUY-THE-WINNER TEST${L.live.n || L.live.pos.length || CFG.LATE_LIVE === 1 ? '' : ' (paper)'}${parts.length ? '\n' + parts.join('\n') : ''}\n📊 ${LATE_VARIANTS.map(lateLine).join('\n📊 ').replace(/⏰ /g, '')}\n🔎 Filters (recent ¢/contract): ${LATE_FILTERS.map(F => { const r = lateRecent(L.f[F.k]); return `${F.k} ${r.n ? (r.avg >= 0 ? '+' : '') + (r.avg * 100).toFixed(1) : '—'} (${L.f[F.k].n})`; }).join(' · ')}${L.live.n || CFG.LATE_LIVE === 1 ? '\n' + liveLine() + '\n' + champLine() : ''}${verdicts.length ? '\n\n' + verdicts.join('\n') : ''}`);
  await saveSettings().catch(() => {});
}
async function paperGrade() {
  const due = (S.paper.pos || []).filter(o => Date.now() > o.c + 3 * 60e3); if (!due.length) return;
  const lines = [];
  for (const o of due) {
    let m; try { m = (await kalshi('GET', `/markets/${o.t}`)).market || {}; } catch (e) { continue; }
    const res = String(m.result || '').toLowerCase();
    if (res !== 'yes' && res !== 'no') { if (Date.now() > o.c + 6 * 3600e3) S.paper.pos = S.paper.pos.filter(x => x !== o); continue; }
    const win = res === o.side ? 1 : 0, fee = o.kind === 'take' ? 0.07 * o.px * (1 - o.px) : 0;
    const pnl = Math.round((win - o.px - fee) * 100) / 100;
    { const t = paperTot(); t.n++; t.sum = Math.round((t.sum + pnl) * 100) / 100; if (pnl > 0) t.w++; }
    S.paper.r = (S.paper.r || []).concat([pnl]).slice(-200); S.paper.pos = S.paper.pos.filter(x => x !== o);
    if (o.pb >= 0 && o.mk >= 0) { S.sc.hist = (S.sc.hist || []).concat([[o.pb, o.mk, win]]).slice(-200); calDirty = true; }
    await learnLane(laneOf(o.ev, new Date(o.c).toISOString()), pnl, o.px);
    lines.push(`${win ? '✅' : '❌'} ${label(o.t).replace(/ ≥ \$[\d,.]+/, '')} ${o.side.toUpperCase()} @ ${cents(o.px)} ${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}${o.kind === 'bid' ? ' (bid)' : ''}`);
  }
  if (!lines.length) return;
  const { n, sum, avg } = paperRec();
  await say(`📄 PAPER RESULTS\n${lines.join('\n')}\n📊 Record: ${n} trades ${sum >= 0 ? '+' : '−'}${money(Math.abs(sum))} (${avg >= 0 ? '+' : ''}${(avg * 100).toFixed(1)}¢/contract)`);
  if (CFG.PAPER === 1 && n >= CFG.PAPER_PROVE_N && avg >= CFG.PAPER_PROVE_EDGE && paperRecent() >= CFG.PAPER_PROVE_EDGE) {
    CFG.PAPER = 0; await say(`✅ PAPER RECORD PROVEN: ${n} trades averaging +${(avg * 100).toFixed(1)}¢ per contract (last 50: +${(paperRecent() * 100).toFixed(1)}¢). Real trading is back ON (smallest sizes first). /set paper 1 to go back to practice.`);
  }
  await saveSettings().catch(() => {});
}
function managePaperBids(latest, fast) {
  for (const [ev, b] of Object.entries(S.paper.bids || {})) {
    if (isFast(ev.split('-')[0]) !== !!fast) continue;
    const v = latest[b.t + '|' + b.side], now = Date.now();
    if (v && v.ask <= b.q + 1e-9) { delete S.paper.bids[ev]; paperOpen({ t: b.t, ev, side: b.side, px: b.q, c: b.close, p: b.p, pb: b.pb, mk: b.mk, kind: 'bid' }); continue; } // a seller came down to our price
    let why = null;
    if (now >= b.stop) why = 'window closing';
    else if (!v) { if (now - b.placed > 30e3) why = 'market not seen'; }
    else if (v.reasons.some(r => !/^edge .* below/.test(r) && !/^price .* outside/.test(r))) why = 'conditions';
    else if (v.p - b.q - makerFee(b.q) < CFG.MAKER_EDGE / 2) why = 'edge gone';
    else { const mq = makerQuote(v); if (mq && mq.q > b.q && now - b.placed > 20e3) { b.q = mq.q; b.placed = now; } }
    if (why) { delete S.paper.bids[ev]; if (S.win[ev] && !S.win[ev].traded) S.win[ev].bid = { side: b.side, q: b.q, n: 1, why, paper: true }; }
  }
}
async function scan(fast) {
  if (!KEY_ID || !SIGN_KEY || !OWNER) return;
  if (S.paused) { for (const o of Object.values(S.rest || {})) await cancelBid(o, 'bot paused').catch(() => {}); for (const b of Object.values(lateState().lbids || {})) await lateBidCancel(b, 'bot paused').catch(() => {}); return; }
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
    if (isFast(series) && CFG.LATE === 1) for (const m of markets) { const mins = (Date.parse(m.close_time) - now) / 60000; await lateBidCheck(m, mins).catch(e => log('late bid check failed', m.ticker, e.message)); await lateExitCheck(m, mins).catch(e => log('late exit check failed', m.ticker, e.message)); } // before the safety-pause check: jumpy minutes are exactly when a bid fills or a position flips (11/25: the pause skipped them)
    const lo = isFast(series) ? CFG.FAST_MIN_MINUTES : CFG.MIN_MINUTES, hi = isFast(series) ? CFG.FAST_MAX_MINUTES : CFG.MAX_MINUTES;
    const dailyOK = CFG.DAILY === 1 && a.cash + (a.exposure || 0) >= CFG.DAILY_MIN_EQUITY;
    const inWindow = (m, mins) => (mins >= lo && mins <= hi) || (!isFast(series) && dailyOK && mins >= lo && mins <= 1440 && isDailyClose(m.close_time));
    S.blk = S.blk || {};
    const blocked = cond[product].problems.length > 0, coinName = product.split('-')[0];
    // Telegram always matches what's really happening: "clear" is only said after 3 calm minutes (a flicker stays one "paused"),
    // and a new pause is always said when the last thing Brad heard was "clear" (11/25 6:14 PM: "resumed", then 6:30 PM was skipped without a word)
    const prev = S.blk[product] || (S.blk[product] = { on: false, said: null, clearAt: 0 });
    if (blocked) {
      if (!prev.on) { delete (S.condWarn = S.condWarn || {})[product]; prev.on = true; } // log every new pause (the 15-min log throttle hid when this one began)
      if (prev.said !== 'P') { (S.condBuf = S.condBuf || []).push({ on: true, coin: coinName, why: cond[product].problems.join('; ') }); prev.said = 'P'; }
    } else {
      if (prev.on) { prev.on = false; prev.clearAt = Date.now(); log('CONDITIONS CLEAR', product); }
      if (prev.said === 'P' && Date.now() - prev.clearAt >= 3 * 60e3) { (S.condBuf = S.condBuf || []).push({ on: false, coin: coinName }); prev.said = 'C'; }
    }
    if (cond[product].problems.length && isFast(series)) S.stats.last15[series] = { blocked: cond[product].problems.join('; '), at: Date.now() };
    if (cond[product].problems.length) for (const m of markets) { const mins = (Date.parse(m.close_time) - now) / 60000; if (inWindow(m, mins)) { const W1 = S.win[m.event_ticker] || (S.win[m.event_ticker] = { label: label(m.ticker).replace(/ ≥ \$[\d,.]+/, ''), series, close: Date.parse(m.close_time), best: null }); W1.blocked = cond[product].problems[0]; } }
    if (cond[product].problems.length) { if (env.BOT_DEBUG === '1') log('COND', product, cond[product].problems.join('; '));
      S.condWarn = S.condWarn || {}; if (!S.condWarn[product] || Date.now() - S.condWarn[product] > 15 * 60e3) { S.condWarn[product] = Date.now(); log('CONDITIONS BLOCK', product, cond[product].problems.join('; '), '|', cond[product].allPx || ''); } continue; }
    for (const m of markets) if (S.win[m.event_ticker]) S.win[m.event_ticker].close = Date.parse(m.close_time); // keep recap timing in sync with Kalshi
    for (let m of markets) {
      const mins = (new Date(m.close_time).getTime() - now) / 60000;
      if (isFast(series) && CFG.LATE === 1 && mins <= 3.0 && mins >= 2.0) await lateEntry(m, mins, undefined, cond).catch(e => log('late entry failed', m.ticker, e.message));
      if (!isFast(series) && CFG.LATE === 1 && m === markets[0]) await lateLadder(markets, now).catch(e => log('late ladder failed', series, e.message));
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
        { // recap reason: prefer moments when the price was tradable (40–85¢) over the decided tail of the window
          const inRange = !v.reasons.some(r => /^price .* outside/.test(r)), b = W0.best;
          if (!b || (inRange && !b.inRange) || (inRange === !!b.inRange && v.edge > b.edge)) W0.best = { edge: v.edge, side: v.side, reasons: v.reasons.slice(0, 2), inRange };
        }
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
    if (sameDirCount(Date.parse(c.m.close_time), c.side) >= CFG.MAX_SAME_DIR) { const W2 = S.win[c.m.event_ticker]; if (W2 && !W2.traded) W2.skip = `🔗 already ${CFG.MAX_SAME_DIR} ${c.side === 'yes' ? 'UP' : 'DOWN'} bets closing then (coins move together)`; continue; }
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
    if (auto && CFG.PAPER !== 1 && room < 0.15 && a.cash - resv(a) >= 0.5) { skip(`🔒 ${money(oc)} already in open bets (max ${Math.round(CFG.MAX_OPEN_PCT * 100)}% of money)`); if (Date.now() - (S.roomWarned || 0) > 60 * 60e3) { S.roomWarned = Date.now(); log('exposure cap', money(oc), 'open'); } continue; }
    const budget = Math.min(a.tradeCap, remaining, a.cash - restingCost() - Math.max(resv(a), 0.02), fastLeft, auto ? Math.max(room, 0) : Infinity, c.always ? Math.max(0.5, a.cash * CFG.ALWAYS_PCT) : Infinity,
      auto && CFG.KELLY > 0 ? stakeFor(c.p, worst, a.cash + oc) : Infinity);
    let count = Math.floor(budget / worst);
    while (count > 0 && count * worst + feeTotal(count, worst) > budget) count--;
    if (S.led.safe && count > 1) count = 1; // safe mode after a losing day: smallest possible bets
    if (auto && CFG.PAPER === 1) count = 1; // paper: one contract, no wallet limits
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
    if (auto && CFG.PAPER === 1) { // practice: record the trade at the price we'd really pay, spend nothing
      paperOpen({ t: c.m.ticker, ev: c.m.event_ticker, side: c.side, px: Math.min(limit || c.ask, c.ask), c: Date.parse(c.m.close_time), p: c.p, pb: Math.round((c.pb ?? c.p) * 1000), mk: Math.round((c.mkt ?? c.ask) * 1000), kind: 'take' });
      S.sc.open = S.sc.open.filter(o => o.t !== c.m.ticker); // graded by the paper book instead
      continue;
    }
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
  if (CFG.MAKER === 1 && CFG.PAPER === 1) {
    for (const o of Object.values(S.rest || {}).filter(x => isFast(x.ev.split('-')[0]) === !!fast)) await cancelBid(o, 'paper mode').catch(() => {});
    managePaperBids(latest, fast);
    const autoOn = fast ? CFG.AUTO_FAST === 1 : CFG.AUTO_HOURLY === 1;
    if (autoOn && !S.led.fastOff) for (const [ev, w] of Object.entries(S.win).filter(([e, w]) => w.mk && isFast(w.series) === !!fast && !w.traded && freshWin.has(e)).sort((x, y) => y[1].mk.edge - x[1].mk.edge)) {
      if (S.paper.bids[ev] || used.has(ev) || (S.paper.pos || []).some(o => o.ev === ev)) continue;
      const lk = laneOf(ev, w.mk.m.close_time); if (laneBenched(lk) || w.mk.edge < CFG.MAKER_EDGE + laneBar(lk)) continue;
      if (sameDirCount(Date.parse(w.mk.m.close_time), w.mk.v.side) >= CFG.MAX_SAME_DIR) { w.skip = `🔗 already ${CFG.MAX_SAME_DIR} ${w.mk.v.side === 'yes' ? 'UP' : 'DOWN'} bets closing then (coins move together)`; continue; }
      const { q, v, m } = w.mk, close = Date.parse(m.close_time);
      S.paper.bids[ev] = { t: m.ticker, side: v.side, q, p: Math.round(v.p * 1000) / 1000, pb: Math.round((v.pb ?? v.p) * 1000), mk: Math.round(v.mkt * 1000), placed: Date.now(), close, stop: close - (fast ? CFG.FAST_MIN_MINUTES : CFG.MIN_MINUTES) * 60e3 };
    }
  } else if (CFG.MAKER === 1) {
    await manageBids(latest, fast);
    const autoOn = fast ? CFG.AUTO_FAST === 1 : CFG.AUTO_HOURLY === 1;
    if (autoOn && !S.paused && !S.led.fastOff) {
      const wins = Object.entries(S.win).filter(([ev, w]) => w.mk && isFast(w.series) === !!fast && !w.traded && freshWin.has(ev)).sort((x, y) => y[1].mk.edge - x[1].mk.edge);
      if (env.BOT_DEBUG_BIDS === '1') log('MKWINS', fast, Object.entries(S.win).filter(([ev]) => freshWin.has(ev)).map(([ev, w]) => `${ev}:${w.mk ? w.mk.q + '/' + w.mk.edge.toFixed(3) : 'none'}${w.traded ? ':T' : ''}`).join(' '));
      for (const [ev, w] of wins) {
        if (restingFor(ev) || a.held.has(ev) || used.has(ev)) continue;
        const lk = laneOf(ev, w.mk.m.close_time); if (laneBenched(lk) || w.mk.edge < CFG.MAKER_EDGE + laneBar(lk)) continue;
        if ((S.bidCool || {})[ev] > Date.now()) continue;
        if (env.BOT_DEBUG_BIDS === '1') log('MKTRY', ev, sameDirCount(Date.parse(w.mk.m.close_time), w.mk.v.side), JSON.stringify((S.led.auto || []).filter(x => !x.done).map(x => [x.t, x.s, x.c - Date.parse(w.mk.m.close_time)])));
        if (sameDirCount(Date.parse(w.mk.m.close_time), w.mk.v.side) >= CFG.MAX_SAME_DIR) { w.skip = `🔗 already ${CFG.MAX_SAME_DIR} ${w.mk.v.side === 'yes' ? 'UP' : 'DOWN'} bets closing then (coins move together)`; continue; }
        let { q, v, m, product } = w.mk;
        if (!m._live) { // list prices can lag (hourly): price the bid off the live book
          try { const live = await withLiveQuote(m); const v2 = evaluate(live, S.lastCond[product]).find(x => x.side === v.side); const mq2 = makerQuote(v2);
            if (!mq2 || mq2.edge < CFG.MAKER_EDGE + laneBar(lk)) { if (env.BOT_DEBUG_BIDS === '1') log('MKSKIP live', ev, JSON.stringify(v2 && { p: v2.p, ask: v2.ask, sp: v2.spread, r: v2.reasons })); continue; } ({ q } = mq2); v = v2; m = live; } catch (e) { if (env.BOT_DEBUG_BIDS === '1') log('MKSKIP err', ev, e.message); continue; }
        }
        const oc = (a.exposure ?? openCost()) + restingCost(), equity = a.cash + oc, room = CFG.MAX_OPEN_PCT * equity - oc;
        const free = a.cash - restingCost() - Math.max(resv(a), 0.02);
        const budget = Math.min(free, room, stakeFor(v.p, q, equity));
        let n = Math.floor(budget / (q + makerFee(q)) + 1e-9); if (S.led.safe) n = Math.min(n, 1);
        if (n < 1) { w.skip = free < q + 0.02 ? `💸 not enough free cash for a bid at ${cents(q)} (${money(Math.max(0, free))} usable, ${money(resv(a))} kept safe)` : `🔒 ${money(oc)} already in bets/bids (max ${Math.round(CFG.MAX_OPEN_PCT * 100)}%)`; continue; }
        try { await postBid(m, v, q, n, product); used.add(ev); w.skip = null; }
        catch (e) { log('bid failed', m.ticker, e.message); (S.bidCool = S.bidCool || {})[ev] = Date.now() + 60e3; if (!/post.?only|cross/i.test(e.message)) { S.bidErr = S.bidErr || {}; if (!S.bidErr[ev]) { S.bidErr[ev] = 1; await say(`⚠️ Limit bid failed (${label(m.ticker)}): ${e.message.replace(/^.*?-> /, '').slice(0, 160)}`); } } }
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
  if (env.BOT_TEST === '1' && t === '/_other') { await OT.tick({ force: true }); await flushBuys().catch(() => {}); return; }
  if (env.BOT_TEST === '1' && /^\/_otherprove \w+$/.test(t)) { const R = OT.state.r[t.split(' ')[1]]; Object.assign(R, { n: 60, w: 45, sum: 10.5, b: [25, 4, 10, 1.5] }); return; } // tests: a rule with 60 trades, +$10.50
  if (env.BOT_TEST === '1' && t === '/_news') { await pollNews(); return; }
  if (env.BOT_TEST === '1' && t === '/_clearnewspause') { S.newsPauseUntil = 0; return; }
  if (env.BOT_TEST === '1' && t === '/_clearlearn') { S.learn = {}; return; }
  if (env.BOT_TEST === '1' && /^\/_latepass \w+$/.test(t)) { lateState().v[t.split(' ')[1]].verdict = 'pass'; return; } // tests: a variant passed its paper test
  if (env.BOT_TEST === '1' && /^\/_ladderat \w+ [\d.]+$/.test(t)) { const [, ser, ml] = t.split(' '); const ms = await pageAll(`/markets?series_ticker=${ser.toUpperCase()}&status=open`, 'markets'); if (ms.length) await lateLadder(ms, Date.parse(ms[0].close_time) - Number(ml) * 60e3); return; } // tests: run the ladder as if N minutes were left
  if (env.BOT_TEST === '1' && t === '/_bloat') { const L = lateState(), far = Date.now() + 20 * 3600e3, cs = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE']; L.hA = {}; L.dA = {}; for (const c of cs) { for (const h of ['21', '22']) L.hA[`KX${c}D-26NOV24${h}`] = { t: `KX${c}D-26NOV24${h}-T59499.99`, c: far }; L.dA[`KX${c}D-26NOV2517`] = { t: `KX${c}D-26NOV2517-T59749.99`, c: far }; } S.pauseStories = Array.from({ length: 3 }, (_, i) => ({ title: i === 2 ? 'UK FCA Pushes Ahead With Tighter DeFi Rules, Citing $6.3B Binance Hack - Crypto Economy' : 'Gloom overshadows the year-end market! JPMorgan: Escalating military tensions, Federal Reserve tightening, a government shutdown and tariff hikes are converging ' + i, at: Date.now() })); L.live = { ...L.live, n: 145, w: 114, sum: -5.43, cost: 118.47, stopped: Date.now() }; saveSettings(); return; } // tests: production-sized state from the 11/24 overflow
  if (env.BOT_TEST === '1' && t === '/_livelateclosed') { for (const o of lateState().live.pos) o.c = Date.now() - 4 * 60e3; return; } // tests: real test positions' windows closed
  if (env.BOT_TEST === '1' && t.startsWith('/_ctclock ')) { const [, h, dd] = t.split(' '); S.testHour = h === 'off' ? undefined : Number(h); S.testDataDay = dd === undefined ? undefined : dd === '1'; return; } // tests: pretend it's this CT hour (and a US weekday or not)
  if (env.BOT_TEST === '1' && t === '/_clearage') { for (const b of Object.values(S.blk || {})) if (b.clearAt) b.clearAt -= 4 * 60e3; return; } // tests: conditions have been calm for 3+ minutes
  if (env.BOT_TEST === '1' && t.startsWith('/_champ ')) { lateState().ch = t.split(' ')[1]; return; } // tests: make a rule the one real money follows
  if (env.BOT_TEST === '1' && t === '/_livereset') { lateState().live = {}; lateState(); return; } // tests: fresh real record
  if (env.BOT_TEST === '1' && t.startsWith('/_livesum ')) { lateState().live.sum = Number(t.split(/\s+/)[1]); return; } // tests: real record total
  if (env.BOT_TEST === '1' && t === '/_daycheck') { const x = lateDayCheck(); if (x) await say(x); return; }
  if (env.BOT_TEST === '1' && t === '/_dayold') { lateDay().k = '1'; return; } // tests: pretend the day changed
  if (env.BOT_TEST === '1' && t === '/_acct2') { acctCache = null; await Promise.all([account(true), account(true)]); return; } // tests: two scans read the account at the same moment
  if (env.BOT_TEST === '1' && t === '/_lateage') { const L = lateState(), all = [...Object.values(L.v).flatMap(V => V.pos), ...L.live.pos]; if (all.length) { const dt = Date.now() - 4 * 60e3 - Math.max(...all.map(o => o.c)); for (const o of all) o.c += dt; } return; } // tests: every open window closed 4 min ago (windows keep their own close times)
  if (env.BOT_TEST === '1' && /^\/_bench \w+( -?[\d.]+){0,4}$/.test(t)) { const a = t.split(' ').slice(2).map(Number); bnState().c[t.split(' ')[1].toUpperCase()] = a.length === 4 ? a : [25, -2, 10, -1]; return; } // tests: a coin with 35 recent trades at −8.6¢/contract (or the 4 numbers given)
  if (env.BOT_TEST === '1' && t === '/_newsfresh') { S.newsLog.unshift({ title: 'Test: market-moving macro story', level: 'macro', got: Date.now(), at: Date.now() }); return; } // tests: a fresh headline the news filter must see
  if (env.BOT_TEST === '1' && t === '/_newsold') { for (const x of S.newsLog) x.got = 0; return; } // tests: those headlines are old now
  if (env.BOT_TEST === '1' && /^\/_lateelig \w+( \d+)?$/.test(t)) { const L = lateState(), k = t.split(' ')[1], n = Number(t.split(' ')[2] || 60), R = L.f[k] || L.v[k]; Object.assign(R, { n, w: n - 5, sum: 3, b: [Math.min(25, n - 10), 1.5, 10, 0.6] }); if (L.f[k]) R.s0 = L.v.m12.nw - 60; else R.nw = 60; return; } // tests: a rule with 60 windows at +6¢ recently
  if (env.BOT_TEST === '1' && /^\/_lateinelig \w+$/.test(t)) { const L = lateState(), k = t.split(' ')[1], R = L.f[k] || L.v[k]; R.b = [25, -2, 10, -1]; return; } // tests: that rule stopped proving itself
  if (env.BOT_TEST === '1' && /^\/_latewindows \d+$/.test(t)) { lateState().v.m12.nw = +t.split(' ')[1]; lateState().v.m12.cs = []; return; } // tests: jump the window count
  if (env.BOT_TEST === '1' && t === '/_lateclosed') { for (const x of LATE_VARIANTS) for (const o of lateState().v[x.k].pos) o.c = Date.now() - 4 * 60e3; return; } // tests: pretend the test's windows closed // tests: research findings must not leak into later tests
  if (env.BOT_TEST === '1' && t === '/_research') { await runResearch(); return; }
  if (t.startsWith('/research')) return say(S.lastResearch || '🧪 First research run happens ~3 min after start, then every 6 hours.');
  if (t.startsWith('/news')) {
    const ev = eventPause();
    return say(`📰 News watch (${S.newsSources || '…'} sources live)\n${ev ? `⏸ Paused: ${ev}` : '▶️ No event pause'}\n` + (S.newsLog.length ? S.newsLog.slice(0, 6).map(x => `• ${x.level === 'critical' ? '🚨' : x.level === 'macro' ? '🏛' : x.level.startsWith('critical') ? '⚠️' : x.level.startsWith('macro') ? '🏦' : '📊'} ${x.title.slice(0, 110)}`).join('\n') : 'No market-moving headlines since start.'));
  }
  if (t.startsWith('/realstats')) { const days = Math.min(30, Math.max(1, parseInt(t.split(/\s+/)[1], 10) || 7)); try { const R = await realStats(Math.floor(Date.now() / 1000) - days * 86400); log('REALSTATS', JSON.stringify({ days, tot: R.tot, px: R.px, coin: R.coin, hour: R.hour, size: R.size })); return say(realStatsText(R, days)); } catch (e) { return say(`⚠️ /realstats failed: ${String(e.message).slice(0, 200)}`); } }
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
  if (t.startsWith('/paper')) return say(paperText());
  if (t.startsWith('/bids')) { const r = Object.values(S.rest || {}); return say(r.length ? `📋 Resting limit bids (${money(restingCost())} reserved):\n` + r.map(o => `• ${label(o.t)} ${o.side.toUpperCase()} ${o.n} @ ${cents(o.q)} · win chance ${Math.round(o.p * 100)}%${o.filled ? ` · ${o.filled} filled` : ''}`).join('\n') : `📋 No resting bids right now. Limit bids: ${CFG.MAKER === 1 ? 'ON' : 'OFF (/set maker 1)'}`); }
  if (t.startsWith('/settings')) return say('⚙️ Current settings\n' + settingsText() + '\n\nChange one: /set trade 3\nCoins: /set coins all  (or btc,eth,sol,…)');
  if (t.startsWith('/help')) return say('Commands\n/claude <anything> – talk to Claude (or just type)\n/status – money & mode\n/stats – is the bot predicting well?\n/settings – see all settings\n/set <name> <value> – change one live\n/scan – scan right now\n/pause /resume\n/lock – stay in confirm mode\n/auto – allow auto-trading\n/auto15 on|off – auto-trade 15-min markets\n/why – why it is or is not trading 15-min markets now\n/report – today: trades, wins, losses, P&L\n/realstats [days] – real 15-min results by price, coin, time and size\n/news – market-moving headlines + pauses\n/research – what the self-test learned\n/coins – which coins & markets are live\n/learn – self-learning results per market\n/bids – resting limit bids\n/paper – practice-trading record\n/rollback – undo the last code change\n\nSettings you can change:\n' + Object.entries(SETTINGS).map(([n, x]) => `${n} – ${x.desc}`).join('\n') + '\ncoins – btc,eth,sol,xrp,doge,bnb,hype,near,zec (or all)');
  if (t.startsWith('/set')) { const [, name, raw] = t.split(/\s+/); return say(await applySetting(name, raw)); }
  if (t.startsWith('/rollback')) return rollback();
  if (t.startsWith('/claude') || !t.startsWith('/')) {
    const q = msg.text.replace(/^\/claude(@\w+)?\s*/i, '').trim();
    if (!q) return say('Ask me anything or tell me what to change, e.g.\n/claude only trade ETH and raise trades to $3\n\n(You can also just type without /claude.)');
    return askClaude(q);
  }
  try {
    const a = await account();
    return say(`📊 Status\nMode: ${S.paused ? 'PAUSED' : CFG.PAPER === 1 ? '📄 PAPER (practice, no real money)' : S.unlocked ? 'AUTO' : 'CONFIRM (you tap to buy)'}\nAuto 15-min: ${CFG.AUTO_FAST !== 1 ? 'OFF' : S.led.fastOff ? 'STOPPED for today' : S.led.safe ? 'ON · 🛡 SAFE MODE today (1 contract, 5¢+ edges)' : 'ON'} · today ${money(S.led.fast || 0)}/${CFG.FAST_DAY > 0 ? money(CFG.FAST_DAY) : 'no limit'} · result ${(S.led.autoPnl || 0) >= 0 ? '+' : '−'}${money(Math.abs(S.led.autoPnl || 0))}\nAuto hourly: ${CFG.AUTO_HOURLY !== 1 ? 'OFF' : S.led.fastOff ? 'STOPPED for today' : S.led.safe ? 'ON · 🛡 SAFE MODE' : 'ON'} · always-in ${CFG.ALWAYS_IN === 1 ? 'ON' : 'OFF'} · 🛡 reserve ${money(resv(a))} · max ${Math.round(CFG.TRADE_PCT * 100)}% of wallet/trade\nCash: ${money(a.cash)} · 📋 limit bids ${CFG.MAKER === 1 ? `ON (${Object.keys(S.rest || {}).length} resting)` : 'OFF'} · sizing ${CFG.KELLY > 0 ? `½-Kelly, max ${Math.round(CFG.TRADE_PCT * 100)}%/trade` : 'fixed'}\nProfit since start: ${money(a.profit)} (auto at ${money(CFG.UNLOCK_PROFIT)})\nToday: ${money(a.spent)} of ${money(a.dayCap)} · max ${money(a.tradeCap)}/trade\nLast scan: ${S.lastScan ? timeCT(S.lastScan) : 'not yet'}${S.lastError ? '\nLast error: ' + S.lastError : ''}\n\n/help for all commands`);
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
    { command: 'lock', description: 'Stay in confirm mode' }, { command: 'auto', description: 'Allow auto-trading' }, { command: 'auto15', description: 'Auto 15-min trading on/off' }, { command: 'report', description: 'Today: trades, wins, losses, P&L' }, { command: 'news', description: 'Market-moving news + pauses' }, { command: 'research', description: 'What the self-test learned' }, { command: 'coins', description: 'Which coins/markets are live' }, { command: 'learn', description: 'Self-learning results per market' }, { command: 'bids', description: 'Resting limit bids' }, { command: 'paper', description: 'Practice-trading record' }, { command: 'why', description: 'Why it is/isn\'t trading 15-min now' }, { command: 'rollback', description: 'Undo last code change' },
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
  await paperGrade().catch(e => log('paper grade failed', e.message));
  await lateGrade().catch(e => log('late grade failed', e.message));
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
  finally { await flushLiveCand().catch(e => log('live candidates failed', e.message)); await flushBuys().catch(() => {}); await flushConds().catch(() => {}); S[lock] = false; }
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
      it.got = Date.now(); S.newsLog.unshift(it); S.newsLog = S.newsLog.slice(0, 20); // got: when the bot saw it (the 12th-minute news filter looks back 15 min)
      S.pauseStories = (S.pauseStories || []).filter(x => Date.now() - x.at < news.VENUE_MS).slice(-30); // 7 days for a venue's hack/halt follow-ups; other matches are 6 h (news.sameStory)
      if (it.pauseMin > 0 && news.sameStory(it.title, S.pauseStories)) { it.pauseMin = 0; it.repeat = true; } // already paused for this story
      if (it.pauseMin > 0) S.pauseStories.push({ title: it.title, at: Date.now() });
      if (it.pauseMin > 0 && Date.now() + it.pauseMin * 60e3 > S.newsPauseUntil) { S.newsPauseUntil = Date.now() + it.pauseMin * 60e3; S.newsPauseWhy = it.title.slice(0, 80); } // longest pause keeps its reason
      const icon = it.level === 'critical' ? '🚨' : it.level === 'macro' ? '🏛' : it.level.startsWith('critical') ? '⚠️' : it.level.startsWith('macro') ? '🏦' : '📊';
      lines.push(`${icon} ${it.title.slice(0, 140)}${it.pauseMin ? ` — ⏸ trading paused ${it.pauseMin} min` : it.repeat ? ' — (same story, no new pause)' : ''}`);
    }
    if (lines.length && CFG.QUIET === 1 && !r.fresh.some(it => it.pauseMin > 0)) { log('NEWS (quiet)', lines.join(' | ').slice(0, 600)); return; } // headlines that change nothing stay in /news
    if (lines.length) await say(`📰 NEWS\n${lines.slice(0, 6).join('\n')}${lines.length > 6 ? `\n…and ${lines.length - 6} more (/news)` : ''}`);
  } catch (e) { log('news failed', e.message); }
}
if (env.BOT_TEST !== '1') {
  setTimeout(runResearch, 3 * 60e3); setInterval(runResearch, 6 * 3600e3);
  setTimeout(pollNews, 20e3); setInterval(pollNews, 2 * 60e3);
  let otBusy = false; setInterval(async () => { if (otBusy) return; otBusy = true; try { await OT.tick(); await flushBuys(); } catch (e) { log('OTHER failed', e.message); } finally { otBusy = false; } }, 60e3); // weather every 10 min, sports every minute
}
// keep the free Render instance awake
if (PUBLIC_URL) setInterval(() => fetch(PUBLIC_URL + '/').catch(() => {}), 4 * 60e3);
