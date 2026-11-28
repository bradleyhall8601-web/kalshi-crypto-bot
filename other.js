// Weather + sports practice bets (Brad 11/26 8:30 PM CT: "place bets on sports, crypto, weather ASWELL" → he chose "practice first";
// 8:32 PM: "pull all news/post/information that will help with or change the bet"; 8:43 PM: "ALWAYS CHECK SOURCES BEFORE & AFTER EACH BET",
// "Profit 10$ then go to REAL FUNDS OVER ALL MARKETS").
// Every rule practices with paper bets. Once the weather+sports practice bets have made +$10 together, real money follows every rule that is itself
// in profit (20+ trades, recent results not negative) — a rule that loses keeps practicing, so one good rule can't drag real money into a bad one.
// Information each bet uses (re-fetched right before the bet, then checked against the source after Kalshi settles it):
//   weather — NWS forecast high + hourly forecast, the station's observed high so far, active NWS alerts (they widen the uncertainty)
//   sports  — live score + ESPN's live win %, sportsbook moneylines (via ESPN), and ESPN league news (fresh injury news blocks the bet)
'use strict';

const NWS = 'https://api.weather.gov', ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const UA = { 'User-Agent': 'kalshi-crypto-bot/1.0 (practice bets; github.com/bradleyhall8601-web/kalshi-crypto-bot)', Accept: 'application/geo+json, application/json' }; // NWS asks for an identifying User-Agent
const UA_ESPN = UA; // ESPN: the browser-style "Mozilla/5.0 (compatible; …)" header got every league a 403 (live 11/26 11:17 PM CT); the plain bot name works
const WX_SERIES = ['KXHIGHNY', 'KXHIGHCHI', 'KXHIGHMIA', 'KXHIGHLAX', 'KXHIGHAUS', 'KXHIGHDEN', 'KXHIGHPHIL', 'KXHIGHHOU'];
const CITY = { KXHIGHNY: 'NYC', KXHIGHCHI: 'Chicago', KXHIGHMIA: 'Miami', KXHIGHLAX: 'LA', KXHIGHAUS: 'Austin', KXHIGHDEN: 'Denver', KXHIGHPHIL: 'Philadelphia', KXHIGHHOU: 'Houston' };
const LEAGUES = [
  { k: 'NFL', series: 'KXNFLGAME', espn: 'football/nfl', last: 4, lateSec: 300, icon: '🏈' },
  { k: 'NCAAF', series: 'KXNCAAFGAME', espn: 'football/college-football', q: '?groups=80&limit=300', last: 4, lateSec: 300, icon: '🏈' },
  { k: 'NBA', series: 'KXNBAGAME', espn: 'basketball/nba', last: 4, lateSec: 240, icon: '🏀', wpSummary: true },
  { k: 'NCAAB', series: 'KXNCAAMBGAME', espn: 'basketball/mens-college-basketball', q: '?groups=50&limit=400', last: 2, lateSec: 240, icon: '🏀', wpSummary: true },
  { k: 'NHL', series: 'KXNHLGAME', espn: 'hockey/nhl', last: 3, lateSec: 300, icon: '🏒' },
];
const RULES = [
  { k: 'wxf', name: 'weather · forecast vs price', icon: '🌡️' },
  { k: 'wxl', name: 'weather · late-day observed high', icon: '🌡️' },
  { k: 'spp', name: 'sports · pre-game sportsbook line', icon: '🏟️' },
  { k: 'spl', name: 'sports · late-game leader (live win %)', icon: '🏟️' },
];
const LIVE_MIN_N = 20; // a rule needs this many practice trades of its own before real money follows it
const EDGE = { wxf: 0.06, wxl: 0.05, spp: 0.04, spl: 0.03 }; // after the taker fee
const TEMP_ALERT = /heat|freeze|frost|winter|wind chill|cold|blizzard|ice storm|snow/i; // alerts that make a high-temperature forecast less certain (wind/fog alerts don't)
const MAX_GAP = 0.15; // the model may differ from the market's own price by at most 15¢: a bigger gap almost always means the model is missing something (live 11/26 9:17 PM: it wanted NO at 9¢ on Chicago's 44–45° with the high already at 45°F)
const CITY_S = { KXHIGHMIA: 0.6, KXHIGHLAX: 0.8 }; // steadier climates: smaller forecast errors
const INJURY = /\b(injur\w*|ruled out|out for|won'?t play|will not play|not playing|questionable|doubtful|suspend\w*|ejected|illness|scratch\w*|inactive|day-to-day|carted|concussion|placed on|sidelined|game-time decision)\b/i;
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const ALIAS = { WAS: 'WSH', JAC: 'JAX', GSW: 'GS', NYK: 'NY', SAS: 'SA', NOP: 'NO', UTA: 'UTAH', TBL: 'TB', NJD: 'NJ', SJS: 'SJ', LAK: 'LA', LA: 'LAR' }; // Kalshi codes ESPN spells differently (names are matched too)

const num = v => (v === undefined || v === null || v === '') ? NaN : Number(v);
const r2 = x => Math.round(x * 100) / 100;
const cToF = c => c * 9 / 5 + 32;
function Phi(x) { if (x === Infinity) return 1; if (x === -Infinity) return 0; const t = 1 / (1 + 0.2316419 * Math.abs(x)), k = 0.3989422804014327 * Math.exp(-x * x / 2); const p = k * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x > 0 ? 1 - p : p; }
const evDate = ev => { const m = String(ev).match(/-(\d\d)([A-Z]{3})(\d\d)/); return m && MON[m[2]] !== undefined ? `20${m[1]}-${String(MON[m[2]] + 1).padStart(2, '0')}-${m[3]}` : null; };
function tzParts(tz, ms) { return Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value])); }
const tzOffsetMin = (tz, ms) => { const p = tzParts(tz, ms); return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / 60e3; };
const localDate = (tz, ms) => { const p = tzParts(tz, ms); return `${p.year}-${p.month}-${p.day}`; };
function dayStart(date, tz) { const [y, m, d] = date.split('-').map(Number), g = Date.UTC(y, m - 1, d); return g - tzOffsetMin(tz, g + 12 * 3600e3) * 60e3; } // local midnight
const isoDur = s => { const m = String(s || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/); return m ? ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60) * 1000 : 3600e3; };
const spans = (q, toF) => ((q && q.values) || []).map(v => { const [s, dd] = String(v.validTime).split('/'), a = Date.parse(s); return { a, b: a + isoDur(dd), v: toF ? cToF(num(v.value)) : num(v.value) }; }).filter(x => x.a === x.a && x.v === x.v);
const isF = q => /degF/i.test(String((q && q.uom) || ''));
const amer = o => { const x = num(String(o).replace(/[^\d+\-.]/g, '')); return x === x && x !== 0 ? (x < 0 ? -x / (-x + 100) : 100 / (x + 100)) : NaN; }; // American odds → implied probability (with the book's margin)
const nrm = s => String(s || '').toLowerCase().replace(/\bst\.?(?=\s|$)/g, 'state').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// YES covers whole °F from lo to hi (inclusive); open-ended at the ends
function bracket(m) {
  const st = m.strike_type, f = num(m.floor_strike), c = num(m.cap_strike), b = String(m.ticker).match(/-B(\d+(?:\.\d+)?)$/);
  if (st === 'greater' && f === f) return [Math.floor(f) + 1, Infinity];
  if (st === 'less' && c === c) return [-Infinity, Math.ceil(c) - 1];
  if (st === 'between' && f === f && c === c) return [f, c];
  if (b) { const mid = Number(b[1]); return [mid - 0.5, mid + 0.5]; }
  return null;
}
// the day's official high V (whole °F): P(V ≤ t) = F(t + 0.5). L = observed high so far: a floor — the official high is never below it and only
// sometimes a degree above (it counts the minutes between hourly readings); mu/s = the forecast for what's still to come. No observations yet: just the forecast.
const cdf = ({ L, mu, s }) => t => (mu === mu && mu > -Infinity ? Phi((t - mu) / s) : 1) * (L > -Infinity ? (t < L ? 0 : 2 * Phi((t - L) / 0.35) - 1) : 1);
function probYes(br, F) { const [lo, hi] = br; return Math.max(0, Math.min(1, (hi === Infinity ? 1 : F(hi + 0.5)) - (lo === -Infinity ? 0 : F(lo - 0.5)))); }
const brText = br => br[1] === Infinity ? `${br[0]}°+` : br[0] === -Infinity ? `${br[1]}° or below` : `${br[0]}–${br[1]}°`;
const inBr = (br, v) => v >= br[0] && v <= br[1];

function teamMatch(km, c) {
  const code = String(km.ticker).split('-').pop().toUpperCase(), t = (c && c.team) || {}, ab = String(t.abbreviation || '').toUpperCase();
  if (code && (code === ab || ALIAS[code] === ab)) return true;
  const sub = nrm(km.yes_sub_title), loc = nrm(t.location);
  if (sub && (sub === loc || sub === nrm(t.displayName) || sub === nrm(t.shortDisplayName))) return true;
  const one = sub.match(/^(.*) ([a-z])$/); return !!(one && one[1] === loc && nrm(t.name).startsWith(one[2])); // "Los Angeles C" = Chargers/Clippers
}

function create(deps) {
  const { kalshi, req, log, say, feeTotal, money, cents, cfg, save, realBuy, quote } = deps, sayP = deps.sayP || say; // sayP: practice news (left out of a clean Telegram)
  const now = () => (deps.now ? deps.now() : Date.now());
  const O = { r: {}, p: [], live: { n: 0, w: 0, sum: 0, pos: [] }, e: {} };
  for (const x of RULES) O.r[x.k] = { n: 0, w: 0, sum: 0, b: [0, 0, 0, 0] };
  const mem = { st: {}, grid: {}, obs: {}, al: {}, sb: {}, news: {}, wp: {}, prevMu: {}, wxAt: 0, gradeAt: 0, warned: {}, sumAt: {} };
  const fetch1 = async url => { const espn = url.startsWith(ESPN); try { return await req(url, { headers: espn ? UA_ESPN : UA }); } catch (e) { if (!espn || !/-> 403/.test(e.message)) throw e; await new Promise(r => setTimeout(r, deps.retryMs === undefined ? 1500 : deps.retryMs)); return req(url, { headers: UA_ESPN }); } }; // ESPN's CDN sometimes answers 403 once: one retry
  const get = (url, ttl, box, key) => { const c = box[key]; if (c && now() - c.at < ttl) return c.p; const p = fetch1(url).catch(e => { delete box[key]; throw e; }); box[key] = { at: now(), p }; return p; };
  const fee1 = px => feeTotal(1, px);
  const recent = R => { const n = R.b[0] + R.b[2]; return { n, avg: n ? (R.b[1] + R.b[3]) / n : 0 }; };
  const total = () => r2(RULES.reduce((a, x) => a + O.r[x.k].sum, 0));
  const goal = () => (cfg().OT_GOAL > 0 ? cfg().OT_GOAL : 10);
  const ruleOk = k => { const R = O.r[k], rc = recent(R); return R.n >= LIVE_MIN_N && R.sum > 0 && rc.avg >= 0; };
  const liveOn = k => cfg().OT_LIVE === 1 && total() >= goal() && ruleOk(k); // Brad 11/26: "Profit 10$ then go to REAL FUNDS"
  const has = (ev, k) => O.p.some(o => o.ev === ev && o.k === k) || O.live.pos.some(o => o.ev === ev && o.k === k);
  const sig = k => { const e = O.e[k]; return e && e[0] >= 8 ? Math.min(5, Math.max(1.2, Math.sqrt(e[1] / e[0]))) : null; }; // learned forecast error (°F)

  // ---------- weather ----------
  async function station(id) {
    if (mem.st[id]) return mem.st[id];
    const s = await req(`${NWS}/stations/${id}`, { headers: UA }), [lon, lat] = (s.geometry && s.geometry.coordinates) || [];
    if (!(lat === lat && lon === lon)) throw new Error('no coordinates for ' + id);
    const p = await req(`${NWS}/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { headers: UA }), pr = p.properties || {};
    if (!pr.forecastGridData) throw new Error('no forecast grid for ' + id);
    return (mem.st[id] = { id, lat, lon, tz: pr.timeZone || 'America/New_York', grid: pr.forecastGridData });
  }
  async function obsMax(st, ds, fresh) {
    if (fresh) delete mem.obs[st.id + ds];
    const o = (await get(`${NWS}/stations/${st.id}/observations?start=${new Date(ds).toISOString()}`, 10 * 60e3, mem.obs, st.id + ds)) || {}; let mx = -Infinity;
    for (const f of o.features || []) { const p = f.properties || {}, v = num(p.temperature && p.temperature.value), at = Date.parse(p.timestamp); if (v === v && at >= ds && at < ds + 24 * 3600e3) mx = Math.max(mx, /degF/i.test(String(p.temperature.unitCode)) ? v : cToF(v)); }
    return mx;
  }
  async function wxInfo(st, ds, fresh = false) {
    if (fresh) { delete mem.grid[st.id]; delete mem.al[st.id]; }
    const g = ((await get(st.grid, 30 * 60e3, mem.grid, st.id)) || {}).properties || {};
    const max = spans(g.maxTemperature, !isF(g.maxTemperature)), temp = spans(g.temperature, !isF(g.temperature));
    const obs = now() >= ds ? await obsMax(st, ds, fresh) : -Infinity;
    let alerts = []; try { const a = (await get(`${NWS}/alerts/active?point=${st.lat.toFixed(4)},${st.lon.toFixed(4)}`, 10 * 60e3, mem.al, st.id)) || {}; alerts = (a.features || []).map(f => String((f.properties || {}).event || '')).filter(Boolean); }
    catch (e) { if (fresh) throw new Error('NWS alerts unavailable'); log('OTHER wx alerts failed', st.id, e.message); } // the check right before a bet must have them
    return { max, temp, obs, alerts };
  }
  function wxModel(k, info, ds, t, series) {
    const de = ds + 24 * 3600e3, dayMax = info.max.filter(x => x.a >= ds - 6 * 3600e3 && x.a < de).sort((a, b) => Math.abs(a.a - ds - 12 * 3600e3) - Math.abs(b.a - ds - 12 * 3600e3))[0];
    const rest = info.temp.filter(x => x.b > t && x.a < de), restMax = rest.length ? Math.max(...rest.map(x => x.v)) : -Infinity;
    const alert = [...new Set(info.alerts.filter(a => TEMP_ALERT.test(a)))], wide = alert.length ? 1.3 : 1;
    if (k === 'wxf') { if (!dayMax) return null; const lead = (ds + 15 * 3600e3 - t) / 3600e3; return { L: info.obs, mu: dayMax.v, s: (sig('wxf') || (lead > 24 ? 2.6 : 2.0) * (CITY_S[series] || 1)) * wide, alert, restMax }; }
    if (!(info.obs > -Infinity)) return null;
    return { L: info.obs, mu: restMax, s: (sig('wxl') || 1.5) * wide, alert, restMax };
  }
  const wxDesc = (k, md) => `${k === 'wxf' ? `NWS high ${Math.round(md.mu)}°F` : `high so far ${Math.round(md.L)}°F${md.restMax > -Infinity ? `, still to come ≤${Math.round(md.restMax)}°F` : ''}`} (±${md.s.toFixed(1)}°F)${md.alert.length ? ` · ⚠️ NWS: ${md.alert.slice(0, 2).join(', ')}` : ''}`;
  async function weather(out) {
    for (const series of WX_SERIES) {
      let ms; try { ms = ((await kalshi('GET', `/markets?series_ticker=${series}&status=open&limit=200`)) || {}).markets || []; } catch (e) { log('OTHER wx markets failed', series, e.message); continue; }
      const byEv = {}; for (const m of ms) (byEv[m.event_ticker] = byEv[m.event_ticker] || []).push(m);
      for (const [ev, mk] of Object.entries(byEv)) {
        const date = evDate(ev), code = (String(mk[0].rules_primary || '').match(/\(CLI([A-Z]{3})\)/) || [])[1];
        if (!date || !code) { if (!mem.warned[series]) { mem.warned[series] = 1; log('OTHER wx skip', ev, 'no date/station in rules'); } continue; }
        let st, info; try { st = await station('K' + code); } catch (e) { log('OTHER wx station failed', code, e.message); continue; }
        const ds = dayStart(date, st.tz), t = now(), hr = (t - ds) / 3600e3;
        const k = t < ds + 11 * 3600e3 && t > ds - 36 * 3600e3 ? 'wxf' : hr >= 16 ? 'wxl' : null; // forecast rule: up to 11 AM local that day; late rule: from 4 PM local (the high is usually in)
        if (!k || has(ev, k)) continue;
        try { info = await wxInfo(st, ds); } catch (e) { log('OTHER wx data failed', st.id, e.message); continue; }
        const model = wxModel(k, info, ds, t, series); if (!model) continue;
        const F = cdf(model), notes = [];
        const pm = mem.prevMu[ev + k]; if (k === 'wxf' && pm !== undefined && Math.abs(pm - model.mu) >= 2) notes.push(`forecast moved ${Math.round(pm)}→${Math.round(model.mu)}°F`); mem.prevMu[ev + k] = model.mu;
        let best = null;
        for (const m of mk) {
          const br = bracket(m); if (!br) continue;
          const p = probYes(br, F), ya = num(m.yes_ask_dollars), na = num(m.no_ask_dollars), yb = num(m.yes_bid_dollars), nb = num(m.no_bid_dollars);
          for (const [side, ask, bid, q] of [['yes', ya, yb, p], ['no', na, nb, 1 - p]]) {
            if (!(ask >= 0.08 && ask <= 0.94) || !(bid > 0) || ask - bid > 0.12 || Math.abs(q - (ask + bid) / 2) > MAX_GAP) continue; // skip lottery tickets, sure things, empty books and wild disagreements
            const edge = q - ask - fee1(ask); if (!best || edge > best.edge) best = { m, side, px: ask, q, edge, br };
          }
        }
        if (!best || best.edge < EDGE[k]) continue;
        out.push({ k, m: best.m, ev, side: best.side, px: best.px, q: best.q, mu: model.mu, c: Date.parse(best.m.expected_expiration_time || best.m.close_time) || ds + 36 * 3600e3, src: { st: st.id, ds, br: best.br },
          // right before the bet: fresh NWS forecast, observations and alerts, and the same probability again
          recheck: async () => { const i2 = await wxInfo(st, ds, true), m2 = wxModel(k, i2, ds, now(), series); if (!m2) return { ok: false, why: 'NWS data changed' };
            const p2 = probYes(best.br, cdf(m2)); return { ok: true, q: best.side === 'yes' ? p2 : 1 - p2, why: wxDesc(k, m2) + (notes.length ? ' · ' + notes.join(', ') : '') }; },
          text: (px, q, why) => `${RULES.find(x => x.k === k).icon} ${CITY[series] || series} high · ${date.slice(5)} · ${best.side.toUpperCase()} on ${brText(best.br)} @ ${cents(px)} · model ${Math.round(q * 100)}% · ${why}` });
      }
    }
  }

  // ---------- sports ----------
  async function leagueNews(L, fresh) { if (fresh) delete mem.news[L.k]; try { const r = (await get(`${ESPN}/${L.espn}/news?limit=50`, 5 * 60e3, mem.news, L.k)) || {}; return r.articles || []; } catch (e) { log('OTHER news failed', L.k, e.message); return null; } }
  function newsFor(arts, comps, sinceMs) { // fresh injury/lineup headlines about either team
    const names = comps.map(c => c.team || {}).flatMap(t => [t.displayName, t.shortDisplayName && t.shortDisplayName.length > 4 ? t.shortDisplayName : null, t.location && t.name ? `${t.location} ${t.name}` : null]).filter(Boolean).map(s => s.toLowerCase());
    return (arts || []).filter(a => { const at = Date.parse(a.published || a.lastModified); if (!(at >= sinceMs)) return false;
      const txt = `${a.headline || ''} ${a.description || ''} ${((a.categories || []).map(c => c.description || '')).join(' ')}`.toLowerCase();
      return INJURY.test(txt) && names.some(n => txt.includes(n)); });
  }
  const gameOf = e => { const c = (e.competitions || [])[0] || {}, s = e.status || c.status || {}, ty = s.type || {}; return { e, c, state: ty.state, period: num(s.period), clock: num(s.clock), start: Date.parse(e.date), comps: c.competitors || [] }; };
  async function scoreboard(L, fresh) { if (fresh) delete mem.sb[L.k]; return ((await get(`${ESPN}/${L.espn}/scoreboard${L.q || ''}`, 50e3, mem.sb, L.k)) || {}).events || []; }
  // one sports bet, judged from the data in hand: { m, i, px, q, why } or { skip }
  async function sportsEval(L, g, hit, k, arts, fresh) {
    const t = now(), home = g.comps.findIndex(c => c.homeAway === 'home'); if (home < 0) return { skip: 'no home team' };
    if (arts === null) return { skip: 'news unavailable' }; // no news check, no bet
    if (k === 'spp') {
      if (!(g.state === 'pre' && g.start - t <= 90 * 60e3 && g.start - t >= 3 * 60e3)) return { skip: 'not 3–90 min before the start' };
      const od = (g.c.odds || [])[0] || {}, ml = od.moneyline || {}, line = s => s && ((s.close && s.close.odds) || (s.current && s.current.odds) || (s.open && s.open.odds));
      const ih = amer(line(ml.home) || (od.homeTeamOdds && od.homeTeamOdds.moneyLine)), ia = amer(line(ml.away) || (od.awayTeamOdds && od.awayTeamOdds.moneyLine));
      if (!(ih > 0 && ia > 0)) return { skip: 'no sportsbook line' };
      const fresh3h = newsFor(arts, g.comps, t - 3 * 3600e3); if (fresh3h.length) return { skip: 'fresh news: ' + fresh3h[0].headline }; // the line may not have caught up
      const pHome = ih / (ih + ia); let best = null;
      for (const i of [0, 1]) { const m = hit.mk[i], ask = num(m.yes_ask_dollars), bid = num(m.yes_bid_dollars), q = i === home ? pHome : 1 - pHome;
        if (!(ask >= 0.15 && ask <= 0.9) || !(bid > 0) || ask - bid > 0.06 || Math.abs(q - (ask + bid) / 2) > MAX_GAP) continue; const edge = q - ask - fee1(ask); if (!best || edge > best.edge) best = { m, i, ask, q, edge }; }
      if (!best) return { skip: 'no usable book' };
      return { m: best.m, i: best.i, px: best.ask, q: best.q, why: `sportsbooks ${Math.round(best.q * 100)}%${od.provider && od.provider.name ? ` (${od.provider.name})` : ''} · 📰 no injury news in 3 h` };
    }
    if (!(g.state === 'in' && g.period === L.last && g.clock <= L.lateSec)) return { skip: 'not the late game anymore' };
    if (num(g.comps[0].score) === num(g.comps[1].score)) return { skip: 'tied' };
    const lead = num(g.comps[0].score) > num(g.comps[1].score) ? 0 : 1;
    let wpHome = num(((g.c.situation || {}).lastPlay || {}).probability && g.c.situation.lastPlay.probability.homeWinPercentage);
    if (!(wpHome === wpHome) && L.wpSummary) { if (fresh) delete mem.wp[g.e.id]; try { const s = (await get(`${ESPN}/${L.espn}/summary?event=${g.e.id}`, 50e3, mem.wp, g.e.id)) || {}; const w = (s.winprobability || []).slice(-1)[0]; wpHome = num(w && w.homeWinPercentage); } catch (e) { log('OTHER win% failed', L.k, e.message); } }
    if (!(wpHome >= 0 && wpHome <= 1)) return { skip: 'no live win %' };
    const fresh30 = newsFor(arts, [g.comps[lead]], t - 30 * 60e3); if (fresh30.length) return { skip: 'fresh news: ' + fresh30[0].headline };
    const m = hit.mk[lead], q = lead === home ? wpHome : 1 - wpHome;
    return { m, i: lead, px: num(m.yes_ask_dollars), q, why: `${(g.comps[lead].team || {}).shortDisplayName || m.yes_sub_title} leads ${g.comps.map(c => c.score).join('–')}, ${Math.max(0, Math.round(g.clock / 6) / 10)} min left · ESPN win ${Math.round(q * 100)}%` };
  }
  async function sports(out) {
    for (const L of LEAGUES) {
      let evs; try { evs = await scoreboard(L); } catch (e) { log('OTHER scoreboard failed', L.k, e.message); continue; }
      const t = now(), games = evs.map(gameOf).filter(g => g.comps.length === 2);
      const want = games.flatMap(g => [g.state === 'pre' && g.start - t <= 90 * 60e3 && g.start - t >= 3 * 60e3 ? 'spp' : null, g.state === 'in' && g.period === L.last && g.clock <= L.lateSec ? 'spl' : null].filter(Boolean).map(k => ({ g, k })));
      const note = (n, m) => { if (n || now() - (mem.sumAt[L.k] || 0) > 30 * 60e3) { mem.sumAt[L.k] = now(); log('OTHER sports', L.k, `${games.length} games on ESPN, ${n} in a betting window, ${m} matched to Kalshi`); } };
      if (!want.length) { note(0, 0); continue; }
      let ms; try { ms = ((await kalshi('GET', `/markets?series_ticker=${L.series}&status=open&limit=1000`)) || {}).markets || []; } catch (e) { log('OTHER sports markets failed', L.k, e.message); continue; }
      const byEv = {}; for (const m of ms) (byEv[m.event_ticker] = byEv[m.event_ticker] || []).push(m);
      const arts = await leagueNews(L);
      const find = g => { const gd = Date.parse(localDate('America/New_York', g.start)), hits = []; // same two teams AND the same day (old unsettled games stay listed for days)
        for (const [ev, mk] of Object.entries(byEv)) { if (mk.length !== 2) continue;
          const a = g.comps.findIndex(c => teamMatch(mk[0], c)), b = g.comps.findIndex(c => teamMatch(mk[1], c)), kd = Date.parse(evDate(ev) || '');
          if (a >= 0 && b >= 0 && a !== b && Math.abs(kd - gd) <= 86400e3) hits.push({ ev, mk: { [a]: mk[0], [b]: mk[1] }, off: Math.abs(kd - gd) }); }
        return hits.sort((x, y) => x.off - y.off)[0] || null; };
      const tag = g => `${L.icon} ${L.k} · ${g.comps.map(c => (c.team || {}).shortDisplayName || (c.team || {}).abbreviation).join(' vs ')}`;
      note(want.length, want.filter(({ g }) => find(g)).length);
      for (const { g, k } of want) {
        const hit = find(g); if (!hit || has(hit.ev, k)) continue;
        const r = await sportsEval(L, g, hit, k, arts, false); if (r.skip) { if (/news/.test(r.skip)) log('OTHER', k, 'skip', hit.ev, r.skip); continue; }
        const ask = r.px, bid = num(r.m.yes_bid_dollars);
        if (!(ask >= (k === 'spl' ? 0.55 : 0.15) && ask <= (k === 'spl' ? 0.95 : 0.9)) || !(bid > 0) || ask - bid > 0.06 || Math.abs(r.q - (ask + bid) / 2) > MAX_GAP || r.q - ask - fee1(ask) < EDGE[k]) continue;
        out.push({ k, m: r.m, ev: hit.ev, side: 'yes', px: ask, q: r.q, c: Date.parse(r.m.expected_expiration_time || r.m.close_time) || g.start + 4 * 3600e3, src: { lg: L.espn, id: g.e.id, ab: String(((g.comps[r.i] || {}).team || {}).abbreviation || '') },
          // right before the bet: a fresh scoreboard, win %, sportsbook line and news, and the same judgment again
          recheck: async () => { const e2 = (await scoreboard(L, true)).find(e => e.id === g.e.id); if (!e2) return { ok: false, why: 'game not on the scoreboard' };
            const g2 = gameOf(e2), a2 = await leagueNews(L, true), r2_ = await sportsEval(L, g2, hit, k, a2, true);
            if (r2_.skip) return { ok: false, why: r2_.skip }; if (r2_.m.ticker !== r.m.ticker) return { ok: false, why: 'leader changed' }; return { ok: true, q: r2_.q, why: r2_.why }; },
          text: (px, q, why) => `${tag(g)} · ${r.m.yes_sub_title} @ ${cents(px)} · ${why}` });
      }
    }
  }

  // ---------- entries (checked twice), grading (checked against the source), reports ----------
  async function tick({ force = false } = {}) {
    if (cfg().OTHER !== 1) return;
    if (force) for (const k of ['sb', 'news', 'wp', 'grid', 'obs', 'al']) mem[k] = {}; // a forced run (tests, /scan) reads every source fresh
    const out = [];
    if (force || now() - mem.wxAt >= 10 * 60e3) { mem.wxAt = now(); await weather(out).catch(e => log('OTHER weather failed', e.message)); }
    await sports(out).catch(e => log('OTHER sports failed', e.message));
    const lines = []; let real = 0;
    for (const x of out) {
      if (has(x.ev, x.k)) continue;
      let c; try { c = await x.recheck(); } catch (e) { c = { ok: false, why: e.message }; }
      if (!c.ok) { log('OTHER recheck: no bet', x.k, x.m.ticker, c.why); continue; }
      let ask = x.px, bid = NaN; if (quote) { try { const qb = await quote(x.m), ya = num(qb.yes_ask_dollars), yb = num(qb.yes_bid_dollars); ask = x.side === 'yes' ? ya : num(qb.no_ask_dollars); bid = x.side === 'yes' ? yb : 1 - ya;
        if (!(ask > 0)) { log('OTHER recheck: no bet', x.m.ticker, 'empty book'); continue; } } catch (e) { log('OTHER recheck: no bet', x.m.ticker, 'book unavailable', e.message); continue; } }
      const edge = c.q - ask - fee1(ask), gap = bid > 0 ? Math.abs(c.q - (ask + bid) / 2) : 0;
      if (!(edge >= EDGE[x.k]) || ask > 0.95 || gap > MAX_GAP) { log('OTHER recheck: no bet', x.k, x.m.ticker, gap > MAX_GAP ? 'model too far from the market' : 'edge gone', `p ${c.q.toFixed(3)} ask ${ask}`); continue; }
      const line = x.text(ask, c.q, c.why);
      O.p.push({ k: x.k, t: x.m.ticker, ev: x.ev, side: x.side, px: ask, c: x.c, l: line.split(' · ').slice(0, 3).join(' · '), src: x.src, ...(typeof x.mu === 'number' && isFinite(x.mu) ? { mu: Math.round(x.mu * 10) / 10 } : {}) });
      lines.push(line + ' · ✔️ checked twice'); log('OTHER PAPER', x.k, x.m.ticker, x.side, ask, 'p', c.q.toFixed(3));
      if (liveOn(x.k) && realBuy) { try { const r = await realBuy(x.m, x.side, ask, RULES.find(y => y.k === x.k).name); if (r && r.n > 0) { O.live.pos.push({ k: x.k, t: x.m.ticker, ev: x.ev, side: x.side, px: r.px, n: r.n, cost: r.cost, c: x.c }); real++; } } catch (e) { log('OTHER LIVE failed', x.m.ticker, e.message); } }
    }
    if (lines.length) { await (real ? say : sayP)(`🧪 PRACTICE BETS (weather/sports)\n${lines.join('\n')}\n${real ? `💵 Real money on ${real} of them (practice made +$${goal()} and that rule is in profit)` : `📄 Paper only — real money starts once practice makes +$${goal()} (now ${total() >= 0 ? '+' : '−'}${money(Math.abs(total()))})`}`); await save(); }
    if (force || now() - mem.gradeAt >= 5 * 60e3) { mem.gradeAt = now(); await grade().catch(e => log('OTHER grade failed', e.message)); }
  }
  const payoutYes = m => { const r = String(m.result || '').toLowerCase(); if (r === 'yes') return 1; if (r === 'no') return 0; const st = String(m.status || '').toLowerCase(); const sv = num(m.settlement_value_dollars); return /settled|finalized/.test(st) && sv >= 0 && sv <= 1 ? sv : NaN; }; // a tied game pays 50¢ each
  // after the bet: does the source agree with Kalshi's YES result? (Kalshi's result is what pays; a disagreement is flagged for a look)
  async function sourceCheck(o, py) {
    const s = o.src; if (!s) return '';
    try {
      if (s.lg) { const sm = (await fetch1(`${ESPN}/${s.lg}/summary?event=${s.id}`)) || {}, cs = ((((sm.header || {}).competitions || [])[0] || {}).competitors) || [];
        if (!(cs.length === 2 && cs.some(c => c.winner === true))) return ' · source: no ESPN final yet';
        const mine = cs.find(c => String((c.team || {}).abbreviation || '').toUpperCase() === String(s.ab).toUpperCase()); if (!mine) return ' · source: team not found';
        const score = cs.map(c => `${(c.team || {}).abbreviation} ${c.score}`).join('–');
        return (mine.winner === true ? 1 : 0) === py ? ` · ✔️ ESPN final ${score}` : ` · ⚠️ ESPN final ${score} disagrees with Kalshi — flagged`; }
      if (s.st) { const st = mem.st[s.st]; if (!st) return ''; const mx = await obsMax(st, s.ds, true); if (!(mx > -Infinity)) return ' · source: no NWS readings';
        const v = Math.round(mx), near = inBr(s.br, v + 1) !== inBr(s.br, v) || inBr(s.br, v - 1) !== inBr(s.br, v); // the official high can run 1°F above the hourly readings
        return (inBr(s.br, v) ? 1 : 0) === py ? ` · ✔️ NWS readings high ${v}°F` : near ? ` · NWS readings high ${v}°F (within 1°F of the line)` : ` · ⚠️ NWS readings high ${v}°F disagree with Kalshi — flagged`; }
    } catch (e) { return ' · source check unavailable'; }
    return '';
  }
  async function grade() {
    const lines = [], notes = []; let changed = false; const wasOn = RULES.filter(x => liveOn(x.k)).map(x => x.k).join();
    for (const o of O.p.filter(o => now() > o.c).slice(0, 25)) {
      let m; try { m = ((await kalshi('GET', `/markets/${o.t}`)) || {}).market || {}; } catch (e) { continue; }
      const py = payoutYes(m); if (!(py === py)) { if (now() > o.c + 4 * 86400e3) { O.p = O.p.filter(y => y !== o); changed = true; } continue; }
      const pay = o.side === 'yes' ? py : 1 - py, pnl = r2(pay - o.px - fee1(o.px)), win = pnl > 0 ? 1 : 0, R = O.r[o.k];
      R.n += 1; R.w += win; R.sum = r2(R.sum + pnl); R.b[2] += 1; R.b[3] = r2(R.b[3] + pnl); if (R.b[2] >= 25) R.b = [R.b[2], R.b[3], 0, 0];
      O.p = O.p.filter(y => y !== o); changed = true;
      if (o.mu !== undefined && /^wx/.test(o.k)) { try { const evm = ((await kalshi('GET', `/markets?event_ticker=${o.ev}`)) || {}).markets || [], y = evm.find(x => String(x.result).toLowerCase() === 'yes'), br = y && bracket(y);
        if (br && br[0] > -Infinity && br[1] < Infinity) { const err = (br[0] + br[1]) / 2 - o.mu, e = O.e[o.k] || [0, 0]; O.e[o.k] = [Math.round((e[0] * 0.95 + 1) * 100) / 100, Math.round((e[1] * 0.95 + err * err) * 100) / 100]; } } catch (e) { /* learning is best-effort */ } }
      lines.push(`${win ? '✅' : '❌'} ${o.l || `${o.t} ${o.side.toUpperCase()} @ ${cents(o.px)}`} → ${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}${await sourceCheck(o, py)}`);
    }
    for (const o of O.live.pos.filter(o => now() > o.c).slice(0, 10)) {
      let m; try { m = ((await kalshi('GET', `/markets/${o.t}`)) || {}).market || {}; } catch (e) { continue; }
      const py = payoutYes(m); if (!(py === py)) continue; // real money: keep waiting for Kalshi's result
      const pay = o.side === 'yes' ? py : 1 - py, pnl = r2(pay * o.n - o.cost);
      O.live.n += 1; O.live.w += pnl > 0 ? 1 : 0; O.live.sum = r2(O.live.sum + pnl); O.live.pos = O.live.pos.filter(y => y !== o); changed = true;
      log('OTHER LIVE', o.t, o.side, o.px, pnl, `record n=${O.live.n} sum=${O.live.sum}`); // Kalshi's own settlement message already reports real wins/losses
    }
    const isOn = RULES.filter(x => liveOn(x.k)).map(x => x.k);
    if (isOn.join() !== wasOn) notes.push(isOn.length ? `🎉 Practice is up ${money(total())} (goal +$${goal()}). REAL money now follows: ${isOn.map(k => RULES.find(x => x.k === k).name).join(', ')}${RULES.length > isOn.length ? `. Still practicing (not in profit yet): ${RULES.filter(x => !isOn.includes(x.k)).map(x => x.name).join(', ')}` : ''}.` : `↩️ Weather/sports real money paused: practice is ${total() >= 0 ? '+' : '−'}${money(Math.abs(total()))} (needs +$${goal()} with the rule itself in profit). Back to practice only.`);
    if (changed) await save();
    if (lines.length || notes.length) await (notes.length ? say : sayP)(`📄 PRACTICE RESULTS (weather/sports)${lines.length ? '\n' + lines.join('\n') : ''}\n${recLines()}${notes.length ? '\n\n' + notes.join('\n') : ''}`);
  }
  const recLine = x => { const R = O.r[x.k], avg = R.n ? R.sum / R.n : 0, open = O.p.filter(o => o.k === x.k).length;
    return `${x.icon} ${x.name}: ${R.n} trades · ${R.w}W·${R.n - R.w}L · ${R.sum >= 0 ? '+' : '−'}${money(Math.abs(R.sum))} (${avg >= 0 ? '+' : ''}${(avg * 100).toFixed(1)}¢/contract) · ${open} open${liveOn(x.k) ? ' · 💵 REAL' : ''}`; };
  const recLines = () => `${RULES.map(recLine).join('\n')}\n🎯 Practice total ${total() >= 0 ? '+' : '−'}${money(Math.abs(total()))} — real money at +$${goal()}${cfg().OT_LIVE === 1 ? '' : ' (otlive is off)'}`;
  const lines = () => `🧪 Weather/sports practice (${cfg().OTHER === 1 ? 'on' : 'off'}):\n${recLines()}${O.live.n || O.live.pos.length ? `\n💵 Real weather/sports: ${O.live.n} trades · ${O.live.w}W·${O.live.n - O.live.w}L · ${O.live.sum >= 0 ? '+' : '−'}${money(Math.abs(O.live.sum))} · ${O.live.pos.length} open` : ''}`;
  const liveOpen = () => O.live.pos.reduce((a, o) => a + o.cost, 0);
  // what goes in the pinned settings (open practice bets compact; dropped first if the save is short of room)
  const blob = (keepOpen = true) => ({ r: Object.fromEntries(RULES.filter(x => O.r[x.k].n || O.r[x.k].b.some(v => v)).map(x => { const R = O.r[x.k]; return [x.k, [R.n, R.w, R.sum, ...R.b]]; })), ...(keepOpen && O.p.length ? { p: O.p.map(o => [o.k, o.t, o.side === 'yes' ? 1 : 0, Math.round(o.px * 1000), Math.round(o.c / 60e3), ...(o.mu !== undefined ? [o.mu] : [])]) } : {}), ...(O.live.n || O.live.pos.length ? { live: O.live } : {}), ...(Object.keys(O.e).length ? { e: O.e } : {}) });
  function load(b) {
    if (!b || typeof b !== 'object') return;
    for (const x of RULES) { const a = b.r && b.r[x.k]; if (Array.isArray(a) && a.length >= 7) O.r[x.k] = { n: a[0], w: a[1], sum: a[2], b: a.slice(3, 7) }; else if (a && typeof a.n === 'number') O.r[x.k] = { n: 0, w: 0, sum: 0, b: [0, 0, 0, 0], ...a }; }
    if (Array.isArray(b.p)) O.p = b.p.filter(a => Array.isArray(a) && a.length >= 5).map(a => ({ k: a[0], t: a[1], ev: String(a[1]).split('-').slice(0, -1).join('-'), side: a[2] ? 'yes' : 'no', px: a[3] / 1000, c: a[4] * 60e3, ...(a[5] !== undefined ? { mu: a[5] } : {}) }));
    if (b.live && Array.isArray(b.live.pos)) O.live = { n: 0, w: 0, sum: 0, ...b.live };
    if (b.e && typeof b.e === 'object') O.e = b.e;
  }
  return { tick, grade, lines, blob, load, liveOpen, liveOn, total, state: O, mem };
}
module.exports = { create, bracket, cdf, probYes, teamMatch, evDate, dayStart, amer, RULES, LEAGUES, WX_SERIES };
