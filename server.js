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
  SERIES: (env.BOT_SERIES || 'KXBTCD,KXETHD').split(',').map(s => s.trim()).filter(Boolean),
  SPOT: { KXBTCD: 'BTC-USD', KXBTC: 'BTC-USD', KXETHD: 'ETH-USD', KXETH: 'ETH-USD', KXSOLD: 'SOL-USD' },
  MIN_EDGE: Number(env.BOT_MIN_EDGE || 0.06), MAX_EDGE: 0.25,
  MIN_PRICE: 0.10, MAX_PRICE: 0.85,
  MIN_MINUTES: 8, MAX_MINUTES: 70,
  VOL_MULT: Number(env.BOT_VOL_MULT || 1.25),
  UNLOCK_PROFIT: 100, RELOCK_PROFIT: 50,
  SMALL_TRADE: 2, SMALL_DAY: 15, SCALED_TRADE_PCT: 0.02, SCALED_DAY_PCT: 0.10,
  MAX_ALERTS_PER_RUN: 2, ALERT_TTL_MIN: 4, MAX_SLIPPAGE: 0.02,
  SCAN_EVERY_MIN: 5, TZ: 'America/Chicago',
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
  vol:      { key: 'VOL_MULT', desc: 'volatility multiplier (higher = more cautious)', min: 0.5, max: 3 },
  alerts:   { key: 'MAX_ALERTS_PER_RUN', desc: 'max alerts per scan', min: 1, max: 10 },
  every:    { key: 'SCAN_EVERY_MIN', desc: 'scan every N minutes', min: 1, max: 60 },
  ttl:      { key: 'ALERT_TTL_MIN', desc: 'minutes to tap Buy before alert expires', min: 1, max: 30 },
};
const COIN_SERIES = { BTC: 'KXBTCD', ETH: 'KXETHD', SOL: 'KXSOLD' };
let pinnedId = null;
function settingsText() { return Object.entries(SETTINGS).map(([n, x]) => `${n} = ${CFG[x.key]}`).join('\n') + `\ncoins = ${CFG.SERIES.map(s => Object.keys(COIN_SERIES).find(c => COIN_SERIES[c] === s) || s).join(',')}`; }
async function saveSettings() {
  const blob = {}; for (const x of Object.values(SETTINGS)) blob[x.key] = CFG[x.key]; blob.SERIES = CFG.SERIES; blob.manualLock = S.manualLock; blob.paused = S.paused;
  const text = '⚙️ BOT SETTINGS (do not unpin)\n' + JSON.stringify(blob);
  if (pinnedId) { const r = await tg('editMessageText', { chat_id: OWNER, message_id: pinnedId, text }); if (r.ok) return; }
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
    S.manualLock = !!blob.manualLock; S.paused = !!blob.paused; pinnedId = pm.message_id;
    log('settings loaded', JSON.stringify(blob));
  } catch (e) { log('settings parse error', e.message); }
}
let scanTimer = null;
function schedule() { if (scanTimer) clearInterval(scanTimer); scanTimer = setInterval(tick, CFG.SCAN_EVERY_MIN * 60e3); }

const S = { pending: {}, recentAlerts: {}, paused: false, manualLock: false, unlocked: false, lastScan: null, lastError: null };
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- helpers ----------
async function req(url, { method = 'GET', headers = {}, body } = {}) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${url.split('?')[0].replace(/\/bot[^/]+/, '/bot***')} -> ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}
async function kalshi(method, path, body) {
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
  catch (e) { log('telegram error', e.message); return { ok: false }; }
}
const say = (text, extra = {}) => OWNER ? tg('sendMessage', { chat_id: OWNER, text, ...extra }) : null;
const num = v => (v === undefined || v === null || v === '') ? NaN : Number(v);
const d = (o, k) => { const a = num(o[k + '_dollars']); if (a === a) return a; const b = num(o[k]); return b === b ? b / 100 : NaN; };
const cnt = (o, k = 'count') => { const a = num(o[k + '_fp']); return a === a ? a : (num(o[k]) || 0); };
const feeTotal = (c, p) => Math.ceil(0.07 * c * p * (1 - p) * 100 - 1e-9) / 100;
const money = x => '$' + Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cents = x => Math.round(x * 100) + '¢';
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
async function account() {
  const b = await kalshi('GET', '/portfolio/balance');
  const cash = d(b, 'balance');
  // realized profit = settled payouts minus what those positions cost, since START_TS
  const settles = await pageAll(`/portfolio/settlements?min_ts=${START_TS}`, 'settlements');
  let profit = 0;
  for (const s of settles) profit += d(s, 'revenue') - (d(s, 'yes_total_cost') || 0) - (d(s, 'no_total_cost') || 0) - (d(s, 'fee_cost') || 0);
  // today's spend = buys filled since midnight CT
  const fills = await pageAll(`/portfolio/fills?min_ts=${startOfTodayCT()}`, 'fills');
  let spent = 0;
  for (const f of fills) if ((f.action || 'buy') === 'buy') { const px = d(f, f.side === 'no' ? 'no_price' : 'yes_price'); spent += cnt(f) * px + (d(f, 'fee_cost') || feeTotal(cnt(f), px)); }
  // events we already hold
  const pos = await kalshi('GET', '/portfolio/positions?count_filter=position&limit=1000');
  const held = new Set((pos.market_positions || []).filter(p => cnt(p, 'position') !== 0).map(p => p.ticker.split('-').slice(0, -1).join('-')));

  if (!S.unlocked && !S.manualLock && profit >= CFG.UNLOCK_PROFIT) { S.unlocked = true; await say(`🔓 Profit hit ${money(profit)}. Auto-trading ON (${CFG.SCALED_TRADE_PCT*100}% of balance per trade, ${CFG.SCALED_DAY_PCT*100}% per day). /lock to stop.`); }
  else if (S.unlocked && profit < CFG.RELOCK_PROFIT) { S.unlocked = false; await say(`🔒 Profit fell to ${money(profit)}. Back to confirm mode (${money(CFG.SMALL_TRADE)}/trade, ${money(CFG.SMALL_DAY)}/day).`); }
  const tradeCap = S.unlocked ? Math.max(CFG.SMALL_TRADE, cash * CFG.SCALED_TRADE_PCT) : CFG.SMALL_TRADE;
  const dayCap = S.unlocked ? Math.max(CFG.SMALL_DAY, cash * CFG.SCALED_DAY_PCT) : CFG.SMALL_DAY;
  return { cash, profit, spent, held, tradeCap, dayCap, settledCount: settles.length };
}

async function placeBuy({ ticker, side, count, price }) {
  const r = await kalshi('POST', '/portfolio/orders', {
    ticker, side, action: 'buy', count, type: 'limit', [side + '_price_dollars']: price.toFixed(4),
    time_in_force: 'immediate_or_cancel', client_order_id: 'kbot-' + crypto.randomUUID(),
  });
  const o = r.order || r;
  let filled = cnt(o, 'fill_count'); if (!filled) { const rem = num(o.remaining_count_fp ?? o.remaining_count); filled = rem >= 0 ? count - rem : 0; }
  let cost = d(o, 'taker_fill_cost'); if (!(cost >= 0)) cost = filled * price;
  let fees = d(o, 'taker_fees'); if (!(fees >= 0)) fees = feeTotal(filled, price);
  return { filled, total: cost + fees };
}

// ---------- model ----------
function normCdf(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const k = 0.3989422804014327 * Math.exp(-x * x / 2); const p = k * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x > 0 ? 1 - p : p; }
function probAbove(Sp, K, sig, T) { if (!(K > 0)) return NaN; const s = sig * Math.sqrt(Math.max(T, 0.5)); return normCdf((Math.log(Sp / K) - 0.5 * s * s) / s); }
const sd = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
async function spotVol(product) {
  const H = { 'User-Agent': 'kalshi-bot' };
  const t = await req(`https://api.exchange.coinbase.com/products/${product}/ticker`, { headers: H });
  const c = await req(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=60`, { headers: H });
  const closes = c.map(x => x[4]).reverse(), r = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  return { spot: Number(t.price), sig: Math.max(sd(r.slice(-60)), sd(r.slice(-300))) * CFG.VOL_MULT };
}

// ---------- scan ----------
async function scan() {
  if (!KEY_ID || !SIGN_KEY || !OWNER) return;
  if (S.paused) return;
  const now = Date.now();
  for (const [k, v] of Object.entries(S.recentAlerts)) if (now - v > 3 * 3600e3) delete S.recentAlerts[k];
  for (const [k, v] of Object.entries(S.pending)) if (now - v.created > 3600e3) delete S.pending[k];

  const a = await account();
  let remaining = a.dayCap - a.spent;
  if (remaining < 0.5) return;

  const cache = {}, cands = [];
  for (const series of CFG.SERIES) {
    const product = CFG.SPOT[series]; if (!product) continue;
    const markets = await pageAll(`/markets?series_ticker=${series}&status=open`, 'markets');
    for (const m of markets) {
      const mins = (new Date(m.close_time).getTime() - now) / 60000;
      if (!(mins >= CFG.MIN_MINUTES && mins <= CFG.MAX_MINUTES)) continue;
      if (a.held.has(m.event_ticker) || S.recentAlerts[m.ticker]) continue;
      if (!cache[product]) cache[product] = await spotVol(product);
      const { spot, sig } = cache[product];
      const fl = num(m.floor_strike), cp = num(m.cap_strike), st = String(m.strike_type);
      let pY;
      if (st.startsWith('greater')) pY = probAbove(spot, fl, sig, mins);
      else if (st.startsWith('less')) pY = 1 - probAbove(spot, cp, sig, mins);
      else if (st === 'between') pY = probAbove(spot, fl, sig, mins) - probAbove(spot, cp, sig, mins);
      else continue;
      if (!(pY >= 0 && pY <= 1)) continue;
      for (const s of [{ side: 'yes', p: pY, ask: d(m, 'yes_ask') }, { side: 'no', p: 1 - pY, ask: d(m, 'no_ask') }]) {
        if (!(s.ask >= CFG.MIN_PRICE && s.ask <= CFG.MAX_PRICE)) continue;
        const edge = s.p - s.ask - (0.07 * s.ask * (1 - s.ask) + 0.005);
        if (edge >= CFG.MIN_EDGE && edge <= CFG.MAX_EDGE) cands.push({ m, product, spot, sig, mins, ...s, edge });
      }
    }
  }
  cands.sort((x, y) => y.edge - x.edge);
  const used = new Set(); let sent = 0;
  for (const c of cands) {
    if (sent >= CFG.MAX_ALERTS_PER_RUN) break;
    if (used.has(c.m.event_ticker)) continue;
    const budget = Math.min(a.tradeCap, remaining);
    let count = Math.floor(budget / c.ask);
    while (count > 0 && count * c.ask + feeTotal(count, c.ask) > budget) count--;
    if (count < 1) continue;
    used.add(c.m.event_ticker); S.recentAlerts[c.m.ticker] = Date.now(); sent++;
    const cost = count * c.ask + feeTotal(count, c.ask);
    const coin = c.product.split('-')[0];
    const st = String(c.m.strike_type);
    const strike = st === 'between' ? `${money(num(c.m.floor_strike))}–${money(num(c.m.cap_strike))}` : st.startsWith('less') ? `below ${money(num(c.m.cap_strike))}` : `${money(num(c.m.floor_strike))} or above`;
    const info = `${coin} ${c.m.yes_sub_title || strike} at ${timeCT(c.m.close_time)} (closes in ${Math.round(c.mins)} min)\n\n` +
      `👉 BUY ${c.side.toUpperCase()}: ${count} @ ${cents(c.ask)} = ${money(cost)}\n` +
      `Win: +${money(count - cost)} · Lose: −${money(cost)}\n` +
      `Bot ${(c.p * 100).toFixed(0)}% vs market ${(c.ask * 100).toFixed(0)}% (edge ${(c.edge * 100).toFixed(1)}¢)\n` +
      `${coin} now ${money(c.spot)} · Today ${money(a.spent)}/${money(a.dayCap)} · Profit ${money(a.profit)}`;
    if (S.unlocked) {
      const r = await placeBuy({ ticker: c.m.ticker, side: c.side, count, price: c.ask });
      remaining -= r.total;
      await say(`🤖 AUTO ${r.filled ? 'BOUGHT' : 'NOT FILLED'} ${r.filled}/${count}\n\n` + info);
    } else {
      const id = crypto.randomBytes(4).toString('hex');
      S.pending[id] = { ticker: c.m.ticker, side: c.side, price: c.ask, count, created: Date.now() };
      await say(`🔔 TRADE IDEA — tap within ${CFG.ALERT_TTL_MIN} min\n\n` + info, {
        reply_markup: { inline_keyboard: [[{ text: `✅ Buy ${money(cost)}`, callback_data: `ok|${id}` }, { text: '❌ Skip', callback_data: `no|${id}` }]] },
      });
    }
  }
}

async function applySetting(name, raw) {
  name = String(name || '').toLowerCase();
  if (name === 'coins') {
    const list = String(raw || '').toUpperCase().split(',').map(c => COIN_SERIES[c.trim()]).filter(Boolean);
    if (!list.length) return 'Usage: /set coins btc,eth,sol';
    CFG.SERIES = list; await saveSettings(); return '✅ coins = ' + String(raw).toUpperCase();
  }
  const x = SETTINGS[name]; let v = Number(String(raw ?? '').replace(/[$%¢]/g, ''));
  if (['edge', 'minprice', 'maxprice', 'autotrade', 'autoday'].includes(name) && v >= 1 && v <= 100) v = v / 100; // /set edge 8 = 8¢
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
    const p = S.pending[id];
    const done = async (toast, line) => { await tg('answerCallbackQuery', { callback_query_id: q.id, text: toast }); await tg('editMessageText', { chat_id: chat, message_id: mid, text: (q.message.text || '') + '\n\n' + line }); };
    if (!p) return done('Expired', '⏹ No longer active.');
    delete S.pending[id];
    if (act === 'no') return done('Skipped', '❌ Skipped.');
    if (Date.now() - p.created > CFG.ALERT_TTL_MIN * 60e3) return done('Expired', '⌛ Too late — price may have moved.');
    const a = await account();
    if (a.spent + p.count * p.price + feeTotal(p.count, p.price) > a.dayCap + 0.001) return done('Daily limit hit', `🛑 Daily limit ${money(a.dayCap)} reached.`);
    const m = (await kalshi('GET', `/markets/${p.ticker}`)).market || {};
    const ask = d(m, p.side + '_ask');
    if (!(ask > 0) || ask > p.price + CFG.MAX_SLIPPAGE) return done('Price moved', `⚠️ Price moved to ${cents(ask)}. Not bought.`);
    const r = await placeBuy({ ticker: p.ticker, side: p.side, count: p.count, price: Math.min(p.price + CFG.MAX_SLIPPAGE, 0.99) });
    return done(r.filled ? 'Bought!' : 'Not filled', r.filled ? `✅ BOUGHT ${r.filled}/${p.count} for ${money(r.total)}` : '⚠️ Not filled.');
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
  if (t.startsWith('/auto')) { S.manualLock = false; await saveSettings(); return say(`Auto-trading will turn on at +$${CFG.UNLOCK_PROFIT} profit.`); }
  if (t.startsWith('/scan')) { await say('🔎 Scanning now…'); await tick(); return say(S.lastError ? '⚠️ ' + S.lastError : '✅ Scan done. No alert = no good trade right now.'); }
  if (t.startsWith('/settings')) return say('⚙️ Current settings\n' + settingsText() + '\n\nChange one: /set trade 3\nCoins: /set coins btc,eth,sol');
  if (t.startsWith('/help')) return say('Commands\n/claude <anything> – talk to Claude (or just type)\n/status – money & mode\n/settings – see all settings\n/set <name> <value> – change one live\n/scan – scan right now\n/pause /resume\n/lock – stay in confirm mode\n/auto – allow auto-trading\n/rollback – undo the last code change\n\nSettings you can change:\n' + Object.entries(SETTINGS).map(([n, x]) => `${n} – ${x.desc}`).join('\n') + '\ncoins – btc,eth,sol');
  if (t.startsWith('/set')) { const [, name, raw] = t.split(/\s+/); return say(await applySetting(name, raw)); }
  if (t.startsWith('/rollback')) return rollback();
  if (t.startsWith('/claude') || !t.startsWith('/')) {
    const q = msg.text.replace(/^\/claude(@\w+)?\s*/i, '').trim();
    if (!q) return say('Ask me anything or tell me what to change, e.g.\n/claude only trade ETH and raise trades to $3\n\n(You can also just type without /claude.)');
    return askClaude(q);
  }
  try {
    const a = await account();
    return say(`📊 Status\nMode: ${S.paused ? 'PAUSED' : S.unlocked ? 'AUTO' : 'CONFIRM (you tap to buy)'}\nCash: ${money(a.cash)}\nProfit since start: ${money(a.profit)} (auto at ${money(CFG.UNLOCK_PROFIT)})\nToday: ${money(a.spent)} of ${money(a.dayCap)} · max ${money(a.tradeCap)}/trade\nLast scan: ${S.lastScan ? timeCT(S.lastScan) : 'not yet'}${S.lastError ? '\nLast error: ' + S.lastError : ''}\n\n/help for all commands`);
  } catch (e) { return say('⚠️ Can\'t reach Kalshi: ' + e.message.slice(0, 200)); }
}

// ---------- server ----------
const HOOK_SECRET = crypto.createHash('sha256').update('wh:' + TG_TOKEN + KEY_ID).digest('hex');
const HOOK = '/tg/' + crypto.createHash('sha256').update(TG_TOKEN || 'x').digest('hex').slice(0, 24);
http.createServer((rq, rs) => {
  if (rq.method === 'POST' && rq.url === HOOK) {
    if (rq.headers['x-telegram-bot-api-secret-token'] !== HOOK_SECRET) { rs.statusCode = 403; return rs.end(); }
    let b = ''; rq.on('data', c => { b += c; if (b.length > 1e6) rq.destroy(); }); rq.on('end', () => { rs.end('ok'); try { onUpdate(JSON.parse(b)).catch(e => log('update err', e.message)); } catch (e) {} });
    return;
  }
  rs.setHeader('Content-Type', 'text/plain'); rs.end('ok'); // reveal nothing publicly
}).listen(env.PORT || 10000, async () => {
  log('listening', env.PORT || 10000);
  if (TG_TOKEN && PUBLIC_URL) { const r = await tg('setWebhook', { url: PUBLIC_URL + HOOK, secret_token: HOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true }); log('webhook', JSON.stringify(r)); }
  if (TG_TOKEN) await tg('setMyCommands', { commands: [
    { command: 'claude', description: 'Talk to Claude / ask for changes' }, { command: 'status', description: 'Money, profit & mode' },
    { command: 'settings', description: 'See all settings' }, { command: 'set', description: 'Change a setting: /set trade 3' },
    { command: 'scan', description: 'Scan for trades now' }, { command: 'pause', description: 'Stop trading' }, { command: 'resume', description: 'Start again' },
    { command: 'lock', description: 'Stay in confirm mode' }, { command: 'auto', description: 'Allow auto-trading' }, { command: 'rollback', description: 'Undo last code change' },
    { command: 'help', description: 'All commands' }] });
  await loadSettings(); schedule();
  try { const me = await tg('getMe', {}); log('SELFCHECK telegram', me.ok ? 'OK @' + me.result.username : 'FAILED'); } catch (e) { log('SELFCHECK telegram FAILED', e.message); }
  try { const b = await kalshi('GET', '/portfolio/balance'); log('SELFCHECK kalshi OK balance', JSON.stringify(b)); }
  catch (e) {
    log('SELFCHECK kalshi FAILED', e.message);
    if (/INCORRECT_API_KEY_SIGNATURE/.test(e.message) && env.KEY_REPAIR === '1') await repairKey();
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

async function tick() {
  try { await scan(); S.lastScan = new Date().toISOString(); S.lastError = null; }
  catch (e) { S.lastError = e.message.slice(0, 200); log('scan error', e.message); }
}
setTimeout(tick, 15000);
// keep the free Render instance awake
if (PUBLIC_URL) setInterval(() => fetch(PUBLIC_URL + '/').catch(() => {}), 4 * 60e3);
