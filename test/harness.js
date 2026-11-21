// Test harness: fake Kalshi + Telegram + exchanges, then loads server.js unmodified.
const crypto = require('crypto');
const http = require('http');

const W = global.W = {
  now: () => Date.now(),
  shards: { 0: 7.44, 2: 0.32 },
  markets: {},          // ticker -> market
  fills: [], settlements: [], positions: [],
  orders: [], transfers: [], tg: [],
  btc: 60000, eth: 1680, vol: 0.0005, // per-minute vol used to generate candles
  candleLag: 30,        // seconds since newest candle start
  stale: {},            // exchange -> true to return old timestamp
  down: {},             // exchange -> true to fail
  shock: null,          // { coin, pct } sudden move in last 5 minutes
  fail429: 0,           // next N kalshi calls return 429
  transferFails: false,
  pinned: null,         // pinned settings text
  orderFill: 'full',    // 'full' | 'none'
  msgId: 100, pinnedId: 9,
};

const pubKeys = {};
function genCandles(px, vol, shock) {
  const out = []; let p = px; const nowS = Math.floor(W.now() / 1000) - W.candleLag;
  for (let i = 0; i < 300; i++) { // alternating ±vol returns: exact, deterministic volatility
    const t = nowS - i * 60;
    out.push([t, p, p, p, p, 1]);
    p = p * Math.exp(i % 2 ? vol : -vol);
  }
  if (shock) for (let i = 5; i < 300; i++) out[i] = out[i].map((v, j) => j === 0 || j === 5 ? v : v / (1 + shock));
  return out;
}
const J = (x, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(x) });

global.fetch = async (url, o = {}) => {
  const u = String(url), b = o.body ? JSON.parse(o.body) : null;
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, o);
  // ---- Telegram ----
  if (u.includes('api.telegram.org')) {
    const method = u.split('/').pop();
    W.tg.push({ method, body: b });
    if (method === 'getChat') return J({ ok: true, result: W.pinned ? { pinned_message: { message_id: W.pinnedId, text: W.pinned } } : {} });
    if (method === 'editMessageText' && b.message_id === W.pinnedId) { if (W.pinned === b.text) return J({ ok: false, description: 'Bad Request: message is not modified' }, 400); W.pinned = b.text; }
    if (method === 'sendMessage' && String(b.text).startsWith('⚙️ BOT SETTINGS')) { W.pinned = b.text; W.pinnedId = ++W.msgId; W.settingsSends = (W.settingsSends || 0) + 1; return J({ ok: true, result: { message_id: W.pinnedId } }); }
    if (method === 'getMe') return J({ ok: true, result: { username: 'test_bot' } });
    return J({ ok: true, result: { message_id: ++W.msgId } });
  }
  // ---- Exchanges ----
  const coinOf = s => (/eth/i.test(s) ? 'eth' : 'btc');
  if (u.includes('api.exchange.coinbase.com')) {
    const coin = coinOf(u), px = W[coin] * (W.shock && W.shock.coin === coin ? 1 + W.shock.pct : 1);
    if (W.down.coinbase) return J({}, 500);
    if (u.includes('/candles')) return J(genCandles(W[coin], W.vol, 0));
    return J({ price: String(px), time: new Date(W.now() - (W.stale.coinbase ? 120e3 : 1000)).toISOString() });
  }
  if (u.includes('api.kraken.com')) { if (W.down.kraken) return J({}, 500); const coin = coinOf(u); const sh = W.shock && W.shock.coin === coin ? 1 + W.shock.pct : 1; return J({ result: { X: { c: [String(W[coin] * sh * (W.krakenSkew || 1))] } } }); }
  if (u.includes('bitstamp.net')) { if (W.down.bitstamp) return J({}, 500); const coin = coinOf(u); const sh = W.shock && W.shock.coin === coin ? 1 + W.shock.pct : 1; return J({ last: String(W[coin] * sh), timestamp: String(Math.floor(W.now() / 1000) - (W.stale.bitstamp ? 120 : 1)) }); }
  // ---- Kalshi ----
  if (u.includes('kalshi')) {
    const path = new URL(u).pathname, h = o.headers || {};
    // verify signature exactly like Kalshi would
    const ok = crypto.verify(null, Buffer.from(h['KALSHI-ACCESS-TIMESTAMP'] + o.method + path), pubKeys.kalshi, Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64'));
    if (!ok) return J({ error: { code: 'authentication_error', details: 'INCORRECT_API_KEY_SIGNATURE' } }, 401);
    if (W.fail429 > 0) { W.fail429--; return J({ error: { code: 'too_many_requests' } }, 429); }
    if (path.endsWith('/portfolio/balance')) {
      const total = Object.values(W.shards).reduce((a, x) => a + x, 0);
      return J({ balance: Math.round(total * 100), balance_dollars: total.toFixed(4), portfolio_value: 0, balance_breakdown: Object.entries(W.shards).map(([k, v]) => ({ exchange_index: Number(k), balance: v.toFixed(4) })) });
    }
    if (path.endsWith('/portfolio/settlements')) return J({ settlements: W.settlements, cursor: '' });
    if (path.endsWith('/portfolio/fills')) return J({ fills: W.fills, cursor: '' });
    if (path.endsWith('/portfolio/positions')) return J({ market_positions: W.positions });
    if (path.endsWith('/intra_exchange_instance_transfer')) {
      if (W.transferFails) return J({ error: { code: 'forbidden', message: 'missing scope write::transfer' } }, 403);
      const amt = b.amount / 10000; W.transfers.push(b);
      W.shards[b.source_exchange_shard] -= amt; W.shards[b.destination_exchange_shard] = (W.shards[b.destination_exchange_shard] || 0) + amt;
      return J({ transfer_id: 't' + W.transfers.length });
    }
    if (path.endsWith('/portfolio/orders')) return J({ error: { code: 'deprecated_v1_order_endpoint' } }, 410);
    if (path.endsWith('/portfolio/events/orders')) {
      const m = W.markets[b.ticker];
      const yesPx = Number(b.price), count = Number(b.count);
      const costPer = b.side === 'bid' ? yesPx : 1 - yesPx;
      const idx = b.exchange_index ?? 0;
      W.orders.push(b);
      // fills at the current ask (or better) if the limit allows
      const askYes = Number(m.yes_ask_dollars), askNo = Number(m.no_ask_dollars);
      const can = b.side === 'bid' ? askYes <= yesPx : (1 - askNo) >= yesPx - 1e-9;
      if (W.orderFill === 'none' || !can) return J({ order_id: 'o', fill_count: '0.00', remaining_count: '0.00', ts_ms: 1 }, 201);
      const fillYes = b.side === 'bid' ? askYes : 1 - askNo, pay = b.side === 'bid' ? fillYes : 1 - fillYes;
      const fee = Math.ceil(0.07 * count * pay * (1 - pay) * 100) / 100;
      if ((W.shards[idx] || 0) < count * pay + fee) return J({ error: { code: 'insufficient_balance', message: 'insufficient balance' } }, 400);
      W.shards[idx] -= count * pay + fee;
      W.fills.push({ ticker: b.ticker, side: 'yes', action: b.side === 'bid' ? 'buy' : 'sell', count_fp: count.toFixed(2), yes_price_dollars: fillYes.toFixed(4), no_price_dollars: (1 - fillYes).toFixed(4), fee_cost: fee.toFixed(4) });
      W.positions.push({ ticker: b.ticker, position: b.side === 'bid' ? count : -count });
      return J({ order_id: 'o' + W.orders.length, fill_count: count.toFixed(2), remaining_count: '0.00', average_fill_price: fillYes.toFixed(4), average_fee_paid: (fee / count).toFixed(4), ts_ms: 1 }, 201);
    }
    const mm = path.match(/\/markets\/([^/]+)$/);
    if (mm) return W.markets[mm[1]] ? J({ market: W.markets[mm[1]] }) : J({ error: 'not found' }, 404);
    if (path.endsWith('/markets')) {
      const series = new URL(u).searchParams.get('series_ticker');
      return J({ markets: Object.values(W.markets).filter(m => m.ticker.startsWith(series + '-') && m.status !== 'settled'), cursor: '' });
    }
    return J({ error: 'unmocked ' + path }, 404);
  }
  throw new Error('unmocked ' + u);
};
const realFetch = require('node:http') && (async (url, o) => { // tiny HTTP client for talking to the bot's own server
  return new Promise((res, rej) => {
    const r = http.request(url, { method: o.method || 'GET', headers: o.headers || {} }, x => { let d = ''; x.on('data', c => d += c); x.on('end', () => res({ status: x.statusCode, text: async () => d })); });
    r.on('error', rej); if (o.body) r.write(o.body); r.end();
  });
});

function start(env) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  pubKeys.kalshi = publicKey;
  Object.assign(process.env, {
    KALSHI_KEY_ID: 'test-key', KALSHI_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, ' '),
    TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '42', PORT: String(18000 + Math.floor(Math.random() * 1000)),
    RENDER_EXTERNAL_URL: 'http://127.0.0.1:1', BOT_START_TS: '1', ...env,
  });
  require('../server.js');
  const port = process.env.PORT;
  const HOOK = '/tg/' + crypto.createHash('sha256').update('123:abc').digest('hex').slice(0, 24);
  const SECRET = crypto.createHash('sha256').update('wh:' + '123:abc' + 'test-key').digest('hex');
  const post = async (update, headers = { 'x-telegram-bot-api-secret-token': SECRET }, path = HOOK) =>
    realFetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: JSON.stringify(update), headers });
  return { post, port, HOOK, SECRET };
}
module.exports = { W, start };
