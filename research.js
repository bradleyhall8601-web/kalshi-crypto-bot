// Self-testing research: replays recent history of every traded coin through the bot's model to learn,
// from real data, whether short-term moves continue (momentum) or snap back (mean reversion),
// and how big price swings really are. Changes are adopted only if they also win on unseen data.
'use strict';

function normCdf(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const k = 0.3989422804014327 * Math.exp(-x * x / 2); const p = k * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x > 0 ? 1 - p : p; }
const sd = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };

// P(price at end >= K) with drift tilt: log-distance shifted by k * recent return * (time left / 10 min) (k>0 momentum, k<0 reversion)
function pUp(S, K, sig, T, recent, k) {
  const s = sig * Math.sqrt(Math.max(T - 2 / 3, 0.25));
  return normCdf((Math.log(S / K) + k * recent * Math.min(T, 15) / 10 - 0.5 * s * s) / s); // effect builds with time left
}

// closes: array of 1-minute closes, oldest -> newest, with t (unix seconds) per candle
function buildSamples(candles, windowMin, entries, lookback) {
  const byT = new Map(candles.map(c => [c.t, c.c]));
  const t0 = candles[0].t, t1 = candles[candles.length - 1].t;
  const rets = []; for (let i = 1; i < candles.length; i++) rets.push({ t: candles[i].t, r: Math.log(candles[i].c / candles[i - 1].c) });
  const retIdx = new Map(rets.map((x, i) => [x.t, i]));
  const out = [];
  const firstWin = Math.ceil((t0 + 310 * 60) / (windowMin * 60)) * windowMin * 60; // need 5h of history for vol
  for (let ws = firstWin; ws + windowMin * 60 <= t1; ws += windowMin * 60) {
    const K = byT.get(ws), end = byT.get(ws + (windowMin - 1) * 60); // settle ≈ last minute's price
    if (!(K > 0 && end > 0)) continue;
    const y = end >= K ? 1 : 0;
    for (const e of entries) {
      const te = ws + e * 60, S = byT.get(te), ri = retIdx.get(te), back = byT.get(te - lookback * 60);
      if (!(S > 0 && back > 0) || ri === undefined || ri < 300) continue;
      const r60 = rets.slice(ri - 59, ri + 1).map(x => x.r), r300 = rets.slice(ri - 299, ri + 1).map(x => x.r);
      const sig = Math.sqrt((sd(r60) ** 2 + sd(r300) ** 2) / 2);
      out.push({ S, K, sig, T: windowMin - e, recent: Math.log(S / back), y, ws });
    }
  }
  return out;
}

const brier = (samples, k, mult) => samples.reduce((a, x) => a + (pUp(x.S, x.K, x.sig * mult, x.T, x.recent, k) - x.y) ** 2, 0) / samples.length;

// grid-search on the older 2/3, confirm on the newest 1/3 (out-of-sample)
function fit(samples) {
  if (samples.length < 200) return { ok: false, reason: `only ${samples.length} samples` };
  samples.sort((a, b) => a.ws - b.ws);
  const cut = Math.floor(samples.length * 2 / 3), train = samples.slice(0, cut), test = samples.slice(cut);
  let best = { k: 0, mult: 1, b: brier(train, 0, 1) };
  for (let k = -1; k <= 1.0001; k += 0.1) for (let m = 0.5; m <= 1.6001; m += 0.05) {
    const b = brier(train, k, m); if (b < best.b) best = { k: Math.round(k * 10) / 10, mult: Math.round(m * 100) / 100, b };
  }
  const baseTest = brier(test, 0, 1), fitTest = brier(test, best.k, best.mult);
  const gain = (baseTest - fitTest) / baseTest; // relative Brier improvement on unseen data
  return { ok: true, n: samples.length, k: best.k, mult: best.mult, baseTest, fitTest, gain, adopt: gain > 0.005 };
}

// fetch ~3 days of 1-minute candles from Coinbase (300 per request)
async function history(req, product, hours = 72) {
  try { const c = await historyCoinbase(req, product, hours); if (c.length > 1000) return c; } catch (e) { /* coin not on Coinbase: use Hyperliquid */ }
  const coin = product.split('-')[0], end = Math.floor(Date.now() / 60000) * 60000;
  const rows = await req('https://api.hyperliquid.xyz/info', { method: 'POST', body: { type: 'candleSnapshot', req: { coin, interval: '1m', startTime: end - hours * 3600e3, endTime: end } } });
  return (rows || []).map(k => ({ t: Math.floor(k.t / 1000), c: Number(k.c) })).filter(x => x.c > 0).sort((a, b) => a.t - b.t);
}
async function historyCoinbase(req, product, hours) {
  const end = Math.floor(Date.now() / 60000) * 60, H = { 'User-Agent': 'kalshi-bot' };
  const out = new Map();
  for (let s = end - hours * 3600; s < end; s += 300 * 60) {
    const e = Math.min(end, s + 300 * 60);
    const rows = await req(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=60&start=${new Date(s * 1000).toISOString()}&end=${new Date(e * 1000).toISOString()}`, { headers: H });
    for (const r of rows) out.set(r[0], r[4]);
    await new Promise(r => setTimeout(r, 250)); // be polite to the API
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([t, c]) => ({ t, c }));
}

async function run(req, coins = ['BTC', 'ETH']) {
  const res = {};
  for (const coin of coins) {
    let c; try { c = await history(req, coin + '-USD'); } catch (e) { res[coin] = { m15: { ok: false, reason: 'no data' }, h1: { ok: false, reason: 'no data' }, minutes: 0 }; continue; }
    if (c.length < 400) { res[coin] = { m15: { ok: false, reason: 'no data' }, h1: { ok: false, reason: 'no data' }, minutes: c.length }; continue; }
    res[coin] = {
      m15: fit(buildSamples(c, 15, [3, 5, 7, 9, 11, 13], 5)),   // 15-min windows, momentum over last 5 min
      h1: fit(buildSamples(c, 60, [10, 20, 30, 40, 50], 15)),   // hourly windows, last 15 min
      minutes: c.length,
    };
  }
  return res;
}

module.exports = { run, fit, buildSamples, brier, pUp };
