// Weather + sports practice bets (Brad 11/26 8:30–8:43 PM CT): NWS + ESPN data, news checks, checked twice before each bet and against the
// source after Kalshi settles it; real money only once practice is up +$10 and the rule itself is in profit. Run: node test/other.js
process.env.BOT_TEST = '1';
const { W, start } = require('./harness');
const zlib = require('zlib');
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x = '') => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, x); } };
const msgs = () => W.tg.filter(x => x.method === 'sendMessage' && !String(x.body.text).startsWith('⚙️ BOT SETTINGS')).map(x => x.body.text);
const since = i => msgs().slice(i).join('\n---\n');
const pinned = () => { const t = W.pinned, zi = t.indexOf('Z:'); return zi >= 0 ? JSON.parse(zlib.inflateRawSync(Buffer.from(t.slice(zi + 2).trim(), 'base64')).toString()) : JSON.parse(t.slice(t.indexOf('{'))); };
const until = async (f, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (f()) return true; } catch (e) {} await wait(200); } return false; };
const other = require('../other');

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const parts = (tz, ms) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
const dateOf = (tz, ms) => { const p = parts(tz, ms); return `${p.year}-${p.month}-${p.day}`; };
const code = date => `${date.slice(2, 4)}${MON[Number(date.slice(5, 7)) - 1]}${date.slice(8, 10)}`; // 2026-11-28 → 26NOV28
const C = f => Math.round((f - 32) * 5 / 9 * 1000) / 1000;
const iso = ms => new Date(ms).toISOString();
// a Kalshi market with a consistent book (NO ask = 1 − YES bid, like the real order book)
function mk(ticker, ev, ya, yb, extra = {}) { const m = { ticker, event_ticker: ev, yes_ask_dollars: ya.toFixed(4), yes_bid_dollars: yb.toFixed(4), no_ask_dollars: (1 - yb).toFixed(4), no_bid_dollars: (1 - ya).toFixed(4), status: 'open', exchange_index: 0, expected_expiration_time: iso(Date.now() + 15e3), close_time: iso(Date.now() + 86400e3), ...extra }; W.markets[ticker] = m; return m; }
const team = (ab, location, name, extra = {}) => ({ team: { abbreviation: ab, location, name, displayName: `${location} ${name}`, shortDisplayName: name }, ...extra });
const game = (id, state, startMs, home, away, more = {}) => ({ id, date: iso(startMs).replace(/:\d\d\.\d+Z$/, 'Z'), status: { period: more.period || 0, clock: more.clock || 0, type: { state } },
  competitions: [{ competitors: [{ homeAway: 'home', score: String(more.hs || 0), ...home }, { homeAway: 'away', score: String(more.as || 0), ...away }], ...(more.odds ? { odds: [more.odds] } : {}), ...(more.wp !== undefined ? { situation: { lastPlay: { probability: { homeWinPercentage: more.wp } } } } : {}) }] });

(async () => {
  console.log('\n0. Pieces: brackets, the temperature model, team matching, odds');
  ok(JSON.stringify(other.bracket({ ticker: 'X-T64', strike_type: 'greater', floor_strike: 64 })) === '[65,null]' && JSON.stringify(other.bracket({ ticker: 'X-T57', strike_type: 'less', cap_strike: 57 })) === '[null,56]'
    && JSON.stringify(other.bracket({ ticker: 'X-B62.5', strike_type: 'between', floor_strike: 62 })) === '[62,63]' && JSON.stringify(other.bracket({ ticker: 'X-B60.5', strike_type: 'between', floor_strike: 60, cap_strike: 61 })) === '[60,61]', 'Kalshi weather brackets: ">64" = 65°+, "<57" = 56° or below, B62.5 = 62–63°');
  const F = other.cdf({ L: 59, mu: 50, s: 1.5 }), pIn = other.probYes([58, 59], F), pAbove = other.probYes([62, Infinity], F);
  ok(pIn > 0.8 && pIn < 0.95 && pAbove < 0.01 && other.probYes([-Infinity, 57], F) === 0, 'late day: observed high 59°F, cooling to 50°F → 58–59° likely, 62°+ nearly impossible, 57° or below impossible', JSON.stringify({ pIn, pAbove }));
  ok(other.teamMatch({ ticker: 'KXNBAGAME-26NOV27BOSNYK-NYK', yes_sub_title: 'New York' }, team('NY', 'New York', 'Knicks')) && other.teamMatch({ ticker: 'X-LAC', yes_sub_title: 'Los Angeles C' }, team('LAC', 'Los Angeles', 'Chargers'))
    && !other.teamMatch({ ticker: 'X-LAC', yes_sub_title: 'Los Angeles C' }, team('LAR', 'Los Angeles', 'Rams')) && other.teamMatch({ ticker: 'X-ORST', yes_sub_title: 'Oregon St.' }, team('OSU', 'Oregon State', 'Beavers')), 'team matching: NYK=NY, "Los Angeles C" = Chargers not Rams, "Oregon St." = Oregon State');
  ok(Math.abs(other.amer('-200') - 2 / 3) < 1e-9 && Math.abs(other.amer('+170') - 100 / 270) < 1e-9, 'American odds to probability');
  { const mkO = () => other.create({ kalshi: async () => ({}), req: async () => ({}), log: () => {}, say: async () => {}, feeTotal: (c, p) => Math.ceil(0.07 * c * p * (1 - p) * 100 - 1e-9) / 100, money: x => '$' + x, cents: x => x * 100 + '¢', cfg: () => ({ OTHER: 1, OT_LIVE: 1 }), save: async () => {} });
    const a = mkO(); a.state.r.wxf = { n: 3, w: 2, sum: 0.4, b: [0, 0, 3, 0.4] }; a.state.p.push({ k: 'wxl', t: 'KXHIGHNY-26NOV27-B58.5', ev: 'KXHIGHNY-26NOV27', side: 'no', px: 0.815, c: 1795800000000, mu: 57.5 });
    const b2 = mkO(); b2.load(JSON.parse(JSON.stringify(a.blob()))); const q = b2.state.p[0];
    ok(b2.state.r.wxf.n === 3 && b2.state.r.wxf.sum === 0.4 && q && q.t === 'KXHIGHNY-26NOV27-B58.5' && q.ev === 'KXHIGHNY-26NOV27' && q.side === 'no' && q.px === 0.815 && q.c === 1795800000000 && q.mu === 57.5 && !a.blob(false).p, 'saved and restored after a restart (records + open practice bets; the open list can be dropped to save room)', JSON.stringify(b2.state)); }

  W.shards = { 0: 20, 2: 0 };
  const { post } = start({}); await wait(800);
  const send = t => post({ message: { chat: { id: 42 }, text: t } });
  const o0 = W.orders.length;

  console.log('\n1. Weather: NWS forecast + alerts (forecast rule) and the observed high (late-day rule), checked twice');
  const nyD = dateOf('America/New_York', Date.now() + 86400e3), nyEv = `KXHIGHNY-${code(nyD)}`; // tomorrow in New York
  const tzs = ['Etc/GMT+0', ...Array.from({ length: 12 }, (_, i) => `Etc/GMT+${i + 1}`), ...Array.from({ length: 14 }, (_, i) => `Etc/GMT-${i + 1}`)]; // a time zone where it's 5–10 PM now
  const lateTz = tzs.find(z => { const h = Number(parts(z, Date.now()).hour); return h >= 17 && h <= 21; });
  const chD = dateOf(lateTz, Date.now()), chEv = `KXHIGHCHI-${code(chD)}`;
  const nyDs = Date.parse(nyD + 'T05:00:00Z'); // ~NY midnight (EST)
  W.nws = { stations: {
    KNYC: { lat: 40.7789, lon: -73.9692, tz: 'America/New_York', max: [{ validTime: `${iso(nyDs + 7 * 3600e3)}/PT12H`, value: C(58) }], temp: [], obs: [{ t: iso(nyDs + 14 * 3600e3), c: C(57) }], alerts: ['Winter Weather Advisory'] },
    KMDW: { lat: 41.786, lon: -87.7524, tz: lateTz, max: [], temp: [{ validTime: `${iso(Date.now() - 30 * 60e3)}/PT3H`, value: C(50) }], obs: [{ t: iso(Date.now() - 3 * 3600e3), c: C(59) }, { t: iso(Date.now() - 5 * 3600e3), c: C(55) }], alerts: [] } } };
  const nyR = { rules_primary: 'If the maximum temperature recorded at New York City (CLINYC) for the day…' }, chR = { rules_primary: 'If the maximum temperature recorded at Chicago Midway (CLIMDW) for the day…' };
  const ny64 = mk(`${nyEv}-T64`, nyEv, 0.12, 0.11, { strike_type: 'greater', floor_strike: 64, ...nyR }); mk(`${nyEv}-B58.5`, nyEv, 0.27, 0.26, { strike_type: 'between', floor_strike: 58, cap_strike: 59, ...nyR }); mk(`${nyEv}-T57`, nyEv, 0.36, 0.35, { strike_type: 'less', cap_strike: 57, ...nyR });
  const ch58 = mk(`${chEv}-B58.5`, chEv, 0.74, 0.72, { strike_type: 'between', floor_strike: 58, cap_strike: 59, ...chR }); mk(`${chEv}-B60.5`, chEv, 0.20, 0.18, { strike_type: 'between', floor_strike: 60, cap_strike: 61, ...chR }); mk(`${chEv}-T61`, chEv, 0.10, 0.08, { strike_type: 'greater', floor_strike: 61, ...chR });

  console.log('\n2. Sports: sportsbook line before the game, live win % late in the game, injury news blocks a bet, no news = no bet');
  const t0 = Date.now(), etc = ms => code(dateOf('America/New_York', ms));
  const g1 = game('g1', 'pre', t0 + 60 * 60e3, team('DET', 'Detroit', 'Lions'), team('CHI', 'Chicago', 'Bears'), { odds: { provider: { name: 'DraftKings' }, moneyline: { home: { close: { odds: '-200' } }, away: { close: { odds: '+170' } } } } });
  const g2 = game('g2', 'in', t0 - 3 * 3600e3, team('KC', 'Kansas City', 'Chiefs'), team('DEN', 'Denver', 'Broncos'), { period: 4, clock: 180, hs: 24, as: 17, wp: 0.93 });
  const det = mk(`KXNFLGAME-${etc(t0 + 3600e3)}CHIDET-DET`, `KXNFLGAME-${etc(t0 + 3600e3)}CHIDET`, 0.56, 0.55, { yes_sub_title: 'Detroit' }); mk(`KXNFLGAME-${etc(t0 + 3600e3)}CHIDET-CHI`, det.event_ticker, 0.45, 0.44, { yes_sub_title: 'Chicago' });
  const kc = mk(`KXNFLGAME-${etc(t0 - 3 * 3600e3)}DENKC-KC`, `KXNFLGAME-${etc(t0 - 3 * 3600e3)}DENKC`, 0.86, 0.85, { yes_sub_title: 'Kansas City' }); mk(`KXNFLGAME-${etc(t0 - 3 * 3600e3)}DENKC-DEN`, kc.event_ticker, 0.15, 0.14, { yes_sub_title: 'Denver' });
  // an old unsettled Lions–Bears game from 9 days ago must not be confused with today's
  mk(`KXNFLGAME-${etc(t0 - 9 * 86400e3)}CHIDET-DET`, `KXNFLGAME-${etc(t0 - 9 * 86400e3)}CHIDET`, 0.30, 0.29, { yes_sub_title: 'Detroit' }); mk(`KXNFLGAME-${etc(t0 - 9 * 86400e3)}CHIDET-CHI`, `KXNFLGAME-${etc(t0 - 9 * 86400e3)}CHIDET`, 0.71, 0.70, { yes_sub_title: 'Chicago' });
  const g3 = game('g3', 'pre', t0 + 45 * 60e3, team('NY', 'New York', 'Knicks'), team('BOS', 'Boston', 'Celtics'), { odds: { provider: { name: 'DraftKings' }, moneyline: { home: { close: { odds: '-150' } }, away: { close: { odds: '+130' } } } } });
  const nyk = mk(`KXNBAGAME-${etc(t0 + 45 * 60e3)}BOSNYK-NYK`, `KXNBAGAME-${etc(t0 + 45 * 60e3)}BOSNYK`, 0.50, 0.49, { yes_sub_title: 'New York' }); mk(`KXNBAGAME-${etc(t0 + 45 * 60e3)}BOSNYK-BOS`, nyk.event_ticker, 0.51, 0.50, { yes_sub_title: 'Boston' });
  const g4 = game('g4', 'pre', t0 + 30 * 60e3, team('BOS', 'Boston', 'Bruins'), team('TOR', 'Toronto', 'Maple Leafs'), { odds: { moneyline: { home: { close: { odds: '-180' } }, away: { close: { odds: '+155' } } } } });
  const bru = mk(`KXNHLGAME-${etc(t0 + 30 * 60e3)}TORBOS-BOS`, `KXNHLGAME-${etc(t0 + 30 * 60e3)}TORBOS`, 0.52, 0.51, { yes_sub_title: 'Boston' }); mk(`KXNHLGAME-${etc(t0 + 30 * 60e3)}TORBOS-TOR`, bru.event_ticker, 0.49, 0.48, { yes_sub_title: 'Toronto' });
  W.espn = { 'football/nfl': { events: [g1, g2], news: [{ headline: 'Packers star questionable for Sunday', published: iso(t0 - 20 * 60e3), categories: [{ description: 'Green Bay Packers' }] }] },
    'basketball/nba': { events: [g3], news: [{ headline: "Knicks' Jalen Brunson ruled out vs. Celtics", published: iso(t0 - 30 * 60e3), categories: [{ description: 'New York Knicks' }] }] },
    'hockey/nhl': { events: [g4], newsDown: true } };

  let m0 = msgs().length;
  await send('/_other'); await until(() => /PRACTICE BETS/.test(since(m0)), 15000);
  const bet = since(m0);
  ok(/🌡️ NYC high · \d\d-\d\d · NO on 65°\+ @ 89¢ · model \d+% · NWS high 58°F \(±\d\.\d°F\) · ⚠️ NWS: Winter Weather Advisory · ✔️ checked twice/.test(bet), 'NYC forecast rule: NWS says 58°F → NO on 65°+ at 89¢, the NWS alert shown (and widening the range)', bet);
  ok(/🌡️ Chicago high · \d\d-\d\d · YES on 58–59° @ 74¢ · model \d+% · high so far 59°F, still to come ≤50°F \(±1\.5°F\) · ✔️ checked twice/.test(bet), 'late-day rule: observed high 59°F, cooling → YES 58–59° at 74¢', bet);
  ok(/🏈 NFL · Lions vs Bears · Detroit @ 56¢ · sportsbooks 64% \(DraftKings\) · 📰 no injury news in 3 h/.test(bet), 'pre-game: sportsbooks 64% vs Kalshi 56¢ → Detroit (today\'s game, not the old one)', bet);
  ok(/🏈 NFL · Chiefs vs Broncos · Kansas City @ 86¢ · Chiefs leads 24–17, 3 min left · ESPN win 93%/.test(bet), 'late game: Chiefs up 7 with 3 min left, ESPN 93% vs 86¢', bet);
  ok(!/B60\.5|60–61°|T61|62°\+/.test(bet), 'the model never bets far from the market price (max 15¢ apart)', bet);
  ok(!/Knicks|New York @/.test(bet) && !/Bruins|Boston @/.test(bet), 'fresh "ruled out" news blocks the Knicks bet; NHL news down → no Bruins bet (no news check, no bet)', bet);
  ok(/Paper only — real money starts once practice makes \+\$10/.test(bet) && W.orders.length === o0, 'practice only: no real orders', W.orders.slice(o0).map(o => o.ticker).join());
  m0 = msgs().length; await send('/_other'); await wait(2500);
  ok(!/PRACTICE BETS/.test(since(m0)), 'one practice bet per market and rule (no repeats)', since(m0));

  console.log('\n3. Checked right before the bet: a game that ties up, or a Kalshi price that jumps, gets no bet');
  let calls = 0; const g5 = game('g5', 'in', t0 - 3 * 3600e3, team('BUF', 'Buffalo', 'Bills'), team('MIA', 'Miami', 'Dolphins'), { period: 4, clock: 200, hs: 21, as: 14, wp: 0.92 }), g5t = JSON.parse(JSON.stringify(g5));
  g5t.competitions[0].competitors[1].score = '21';
  const buf = mk(`KXNFLGAME-${etc(t0 - 3 * 3600e3)}MIABUF-BUF`, `KXNFLGAME-${etc(t0 - 3 * 3600e3)}MIABUF`, 0.84, 0.83, { yes_sub_title: 'Buffalo' }); mk(`KXNFLGAME-${etc(t0 - 3 * 3600e3)}MIABUF-MIA`, buf.event_ticker, 0.17, 0.16, { yes_sub_title: 'Miami' });
  W.espn['football/nfl'].events = () => (++calls === 1 ? [g1, g2, g5] : [g1, g2, g5t]); // the fresh scoreboard right before the bet shows 21–21
  const g6 = game('g6', 'pre', t0 + 50 * 60e3, team('PHI', 'Philadelphia', '76ers'), team('MIL', 'Milwaukee', 'Bucks'), { odds: { moneyline: { home: { close: { odds: '-160' } }, away: { close: { odds: '+140' } } } } });
  const phi = mk(`KXNBAGAME-${etc(t0 + 50 * 60e3)}MILPHI-PHI`, `KXNBAGAME-${etc(t0 + 50 * 60e3)}MILPHI`, 0.52, 0.51, { yes_sub_title: 'Philadelphia' }); mk(`KXNBAGAME-${etc(t0 + 50 * 60e3)}MILPHI-MIL`, phi.event_ticker, 0.49, 0.48, { yes_sub_title: 'Milwaukee' });
  W.espn['basketball/nba'].events = [g3, g6]; W.live = { [phi.ticker]: { ...phi, yes_ask_dollars: '0.6200', yes_bid_dollars: '0.6100' } }; // the live book: 62¢, not 52¢
  m0 = msgs().length; await send('/_other'); await wait(3000);
  ok(!/Bills|Buffalo/.test(since(m0)) && !/76ers|Philadelphia/.test(since(m0)), 'no bet: the score tied on the fresh check; the live Kalshi price (62¢) left no edge', since(m0));
  delete W.live[phi.ticker]; W.espn['football/nfl'].events = [g1, g2];

  console.log('\n4. After Kalshi settles: graded, and checked against the source (ESPN final, NWS readings)');
  await wait(Math.max(0, Date.parse(det.expected_expiration_time) - Date.now()) + 500);
  Object.assign(ny64, { status: 'settled', result: 'no' }); Object.assign(ch58, { status: 'settled', result: 'yes' }); Object.assign(det, { status: 'settled', result: 'yes' }); Object.assign(kc, { status: 'settled', result: 'no' });
  W.espn['football/nfl'].summ = { g1: { header: { competitions: [{ competitors: [{ team: { abbreviation: 'DET' }, score: '27', winner: true }, { team: { abbreviation: 'CHI' }, score: '20', winner: false }] }] } },
    g2: { header: { competitions: [{ competitors: [{ team: { abbreviation: 'KC' }, score: '24', winner: true }, { team: { abbreviation: 'DEN' }, score: '17', winner: false }] }] } } };
  m0 = msgs().length; await send('/_other'); await until(() => /PRACTICE RESULTS/.test(since(m0)), 15000);
  const res = since(m0);
  ok(/✅ 🌡️ NYC high · \d\d-\d\d · NO on 65°\+ @ 89¢ → \+\$0\.10 · ✔️ NWS readings high 57°F/.test(res) && /✅ 🌡️ Chicago high · \d\d-\d\d · YES on 58–59° @ 74¢ → \+\$0\.24 · ✔️ NWS readings high 59°F/.test(res), 'weather graded (+$0.10, +$0.24) and confirmed by NWS readings', res);
  ok(/✅ 🏈 NFL · Lions vs Bears · Detroit @ 56¢ → \+\$0\.42 · ✔️ ESPN final DET 27–CHI 20/.test(res), 'Detroit win graded and confirmed by ESPN\'s final', res);
  ok(/❌ 🏈 NFL · Chiefs vs Broncos · Kansas City @ 86¢ → −\$0\.87 · ⚠️ ESPN final KC 24–DEN 17 disagrees with Kalshi — flagged/.test(res), 'a Kalshi result that disagrees with ESPN is flagged', res);
  ok(/weather · forecast vs price: 1 trades · 1W·0L · \+\$0\.10/.test(res) && /sports · late-game leader \(live win %\): 1 trades · 0W·1L · −\$0\.87/.test(res) && /🎯 Practice total −\$0\.11 — real money at \+\$10/.test(res), 'each rule keeps its own record; practice total −$0.11', res);
  await until(() => (pinned().OT || {}).r && pinned().OT.r.wxf.n === 1);
  const P = pinned().OT; ok(P && P.r.wxf.n === 1 && P.r.wxl.n === 1 && P.r.spp.n === 1 && P.r.spl.n === 1 && !(P.p || []).some(x => [ny64, ch58, det, kc].some(m => m.ticker === x[1])), 'records saved in the pinned settings (survive restarts); graded bets leave the open list', JSON.stringify(P));

  console.log('\n5. Practice up +$10 and the rule in profit → real money (re-quoted before, position verified after)');
  await send('/_otherprove spl'); await wait(100);
  const g7 = game('g7', 'in', t0 - 3 * 3600e3, team('BUF', 'Buffalo', 'Bills'), team('MIA', 'Miami', 'Dolphins'), { period: 4, clock: 200, hs: 21, as: 14, wp: 0.94 });
  W.espn['football/nfl'].events = [g7];
  const o5 = W.orders.length; m0 = msgs().length; await send('/_other'); await until(() => /REAL BUY/.test(since(m0)), 15000);
  const r5 = since(m0);
  ok(W.orders.slice(o5).some(o => o.ticker === buf.ticker) && /Real money on 1 of them/.test(r5) && /💵 REAL BUY \(sports · late-game leader \(live win %\)\)/.test(r5), 'late-game rule proven + practice up $10 → real buy of Buffalo, reported', r5);
  await until(() => ((pinned().OT || {}).live || {}).pos && pinned().OT.live.pos.length === 1);
  ok(((pinned().OT || {}).live || {}).pos.length === 1, 'the real position is saved', JSON.stringify(pinned().OT));
  m0 = msgs().length; await send('/paper'); await wait(500);
  ok(/🧪 Weather\/sports practice \(on\)/.test(since(m0)) && /sports · late-game leader \(live win %\): 60 trades.*💵 REAL/.test(since(m0)) && /Real weather\/sports: 0 trades .* 1 open/.test(since(m0)), '/paper shows every weather/sports rule, which one has real money, and the open real bet', since(m0));
  await send('/set otlive 0'); await wait(200);
  const g8 = game('g8', 'in', t0 - 3 * 3600e3, team('SF', 'San Francisco', '49ers'), team('SEA', 'Seattle', 'Seahawks'), { period: 4, clock: 100, hs: 28, as: 20, wp: 0.97 });
  const sf = mk(`KXNFLGAME-${etc(t0 - 3 * 3600e3)}SEASF-SF`, `KXNFLGAME-${etc(t0 - 3 * 3600e3)}SEASF`, 0.90, 0.89, { yes_sub_title: 'San Francisco' }); mk(`KXNFLGAME-${etc(t0 - 3 * 3600e3)}SEASF-SEA`, sf.event_ticker, 0.11, 0.10, { yes_sub_title: 'Seattle' });
  W.espn['football/nfl'].events = [g8];
  const o6 = W.orders.length; m0 = msgs().length; await send('/_other'); await until(() => /PRACTICE BETS/.test(since(m0)), 15000);
  ok(/San Francisco @ 90¢/.test(since(m0)) && !W.orders.slice(o6).length, '/set otlive 0: practice continues, no real money', since(m0));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('TEST CRASH', e); process.exit(1); });
