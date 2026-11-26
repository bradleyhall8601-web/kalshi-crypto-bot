// Live news + economic calendar: pauses new trades around market-moving events.
'use strict';
const FEEDS = [
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://cointelegraph.com/rss',
  'https://decrypt.co/feed',
  'https://news.google.com/rss/search?q=bitcoin+OR+ethereum+OR+crypto+when:1h&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=federal+reserve+OR+CPI+OR+inflation+OR+tariffs+when:1h&hl=en-US&gl=US&ceid=US:en',
];
// high impact: hacks, outages, regulation shocks, surprise policy
const CRITICAL = /\b(hack(ed)?|exploit(ed)?|drain(ed)?|stolen|breach|outage|halt(s|ed)?|suspend(s|ed)? (withdrawals|trading)|insolven(?:t|cy)|bankrupt(?:cy)?|depeg(?:s|ged|ging)?|emergency|liquidation cascade|flash crash|sec (sues|charges)|crackdown|ban(s|ned)? (bitcoin|crypto))\b/i;
const MACRO = /\b(fomc|federal reserve|fed (unexpectedly |surprisingly )?(raises|cuts|hikes|holds|decision)|powell|warsh|rate (hike|cut)|cpi|inflation (data|report)|jobs report|nonfarm|payrolls|tariff|recession|treasury yields? (jump|surge|spike))\b/i;
const MOVE = /\b(bitcoin|btc|ether(eum)?|eth|crypto)\b.*\b(plunge|plunges|crash|crashes|soar|soars|surge|surges|tumble|tumbles|spike|spikes|record high|all-time high)\b/i;

function parse(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const get = tag => { const r = m[0].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')); return r ? r[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim() : ''; };
    const title = get('title'); if (!title) continue;
    items.push({ title, link: get('link'), at: Date.parse(get('pubDate')) || Date.now() });
  }
  return items;
}
// pause only when it can move BTC/ETH: major venues, stablecoins, BTC/ETH themselves, or real policy surprises
// what a hack/halt must hit to move the whole market: a big venue, a stablecoin, a regulator, or the BTC/ETH network itself
// (a headline that merely mentions bitcoin — "$12M stolen in bitcoin", "food company's bitcoin losses" — is not enough)
const VENUE = /\b(binance|coinbase|kraken|okx|bybit|bitfinex|gemini|tether|usdt|usdc|circle|blackrock|etfs?)\b/i;
const CHAIN = /\b(bitcoin|ethereum|btc|eth) (network|blockchain|chain|core|mainnet|nodes?)\b/i;
// a regulator only counts when crypto is what it's acting on (live 11/25 8:55 PM CT: "SEC Orders CARZIQO to Halt Unregistered Investment Scheme" paused trading 15 min)
const REGULATOR = /\b(sec|cftc|us treasury|treasury (department|secretary)|white house)\b/i;
const CRYPTO = /\b(bitcoin|btc|ether(eum)?|eth|crypto(currency|currencies)?|stablecoins?|etfs?|exchanges?)\b/i;
const MAJOR = { test: t => VENUE.test(t) || CHAIN.test(t) || (REGULATOR.test(t) && CRYPTO.test(t)) };
// commentary, previews and explainers describe events, they aren't the event: log them, don't pause
const NOT_EVENT = /\b(analysis|analyst|inside|mystery|explained|explainer|week ahead|what|why|how|could|may|might|warns?|warning|concerns?|calls? for|opinion|preview|prediction|forecast|outlook|lessons|report on|case study|maps|risks?|expects?|monitors?|awaits?|awaited|eyed|in focus|forfeiture|seeks?|seizes?|seizure|recover(?:y|ing|s)?|replacement|working with|behind|reckoning|victims?|lessons? from|aftermath|sought|fees? to (?:return|unfreeze)|courts?|judge|injunction|freezing order|docs|documents|filings?|phishing|scam(?:s|mers?)?|beware|bait(?:s|ed)?|asset freeze|secures?)\b|\?/i; // 11/25: 'Behind Binance hack, a reckoning…' and 'Tether … sought 20% fees from hack victims' paused trading; 11/26: 'Binance hack: court freezes $6.5bn, beware phishing', 'Binance Hack: Court Docs Reveal…' (the Oct 29 hack) and 'Scammers bait TRON users with frozen USDT, then drain…'
// a macro pause needs US policy itself in the headline (not gold prices in India or a fund manager's view)
const US_POLICY = /\b(fed|fomc|federal reserve|powell|warsh|cpi|payrolls|nonfarm|jobs report|treasury yields?)\b/i;
// a bank's or strategist's outlook on rates is a view, not a decision (live 11/25: "Goldman Sachs: The market has already priced in four Federal Reserve rate hikes…" and "BlackRock Sees Only Two Fed Hikes Ahead…" paused trading)
const OUTLOOK = /\b(goldman( sachs)?|jp ?morgan|morgan stanley|citi(group)?|ubs|barclays|deutsche bank|bank of america|bofa|wells fargo|hsbc|nomura|rabobank|td securities|soci[eé]t[eé] g[eé]n[eé]rale|bnp paribas|standard chartered|mizuho|commerzbank|ing|uob|mufg|danske( bank)?|scotiabank|natixis|nordea|westpac|anz|dbs|ocbc|bbh|cibc|rbc|economists?|strategists?|sees?|priced( in)?|prices? in|pricing in|odds|bets|room for|on the table|more (?:fed |rate )*(?:hikes|cuts))\b/i; // 11/25 9:10 & 9:34 AM: 'Raises Odds of More Fed Hikes', 'Adds Room for … Rate Hikes' were hours-old data reactions; 9:03 PM: '…Keeps Fed Hikes on the Table'; 11/26 8:55 AM: 'Federal Reserve: Gradual hikes priced – Commerzbank' (an FXStreet bank note)
const POLICY_SHOCK = /\b(raises|cuts|hikes|surprise|unexpected(ly)?|hotter|cooler|emergency|shock|jumps|surges|plunges)\b/i;
const headline = title => String(title).replace(/\s+[-–|]\s+[^-–|]+$/, '').replace(/\(\s*[A-Z]{2,6}\s*:\s*[A-Z0-9.]{1,6}\s*\)/g, ''); // drop the " - Outlet" suffix and stock tickers like (ASX:HACK)
// a data headline (PCE, CPI, jobs…) is news only right after its release; hours later it's a reaction story (live 11/25: PCE stories paused trading at 9:10, 9:34 and 10:38 AM CT, the release was 7:30 AM CT)
const DATA = /\b(pce|cpi|ppi|inflation (gauge|data|report|rate|reading|print|figures?)|preferred (inflation )?gauge|jobless claims|payrolls|nonfarm|jobs report|gdp|retail sales|consumer prices|producer prices)\b/i;
const FED_MOVE = /\b(fed|fomc|federal reserve)\s+(unexpectedly |surprisingly )?(raises|cuts|hikes)\s+(interest )?rates?\b/i;
// US federal holidays: no 8:30/10:00 AM ET data (live 11/26 Thanksgiving: the 8:30 pause cost the 7:30 and 7:45 AM CT windows)
const NO_DATA_DAYS = ['2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24'];
const dataDay = e => !['Sat', 'Sun'].includes(e.wd) && !NO_DATA_DAYS.includes(e.date);
function releaseWindow(ms = Date.now()) { const e = etParts(ms); return dataDay(e) && ((e.mins >= 8 * 60 + 30 && e.mins < 9 * 60 + 5) || (e.mins >= 10 * 60 && e.mins < 10 * 60 + 35)); } // 8:30 and 10:00 AM ET releases + 35 min
// the Fed only decides at its meetings: "Fed raises/holds/hikes…" is news from the decision (2 PM ET) through the next day; any other time it's an old story
// or an explainer (live 11/25 8:43 & 9:03 PM CT: "Fed Raises Rates as AI Spending Fuels Inflation" and "…Keeps Fed Hikes on the Table" paused trading, no meeting until 12/9)
const FED_DECIDES = /\b(fed|fomc|federal reserve)\s+(unexpectedly |surprisingly )?(raises|cuts|hikes|holds|lifts|lowers|decision)\b/i;
const FED_SURPRISE = /\b(emergency|unexpected(ly)?|surprise|surprisingly|inter-?meeting)\b/i; // a surprise move can come any day
function decisionWindow(ms = Date.now()) {
  const e = etParts(ms), prev = etParts(ms - 24 * 3600e3), last = FOMC_DECISIONS[FOMC_DECISIONS.length - 1];
  if (prev.date > last) return true; // past the listed meetings: never hide a real decision (add the next FOMC dates)
  return (FOMC_DECISIONS.includes(e.date) && e.mins >= 13 * 60 + 55) || FOMC_DECISIONS.includes(prev.date);
}
function classify(title, now = Date.now()) {
  const h = headline(title), event = !NOT_EVENT.test(h);
  const crit = CRITICAL.test(h), macro = MACRO.test(h) && POLICY_SHOCK.test(h) && US_POLICY.test(h) && event && !OUTLOOK.test(h) && !(DATA.test(h) && !FED_MOVE.test(h) && !releaseWindow(now))
    && !(FED_DECIDES.test(h) && !FED_SURPRISE.test(h) && !decisionWindow(now));
  if (crit && MAJOR.test(h) && event) return { level: 'critical', pauseMin: 15 };
  if (macro) return { level: 'macro', pauseMin: 10 }; // checked before critical-minor: 'Fed hikes rates … in emergency move' matched 'emergency' and was filed as a minor hack-type story
  if (crit) return { level: 'critical-minor', pauseMin: 0 };
  if (MACRO.test(h)) return { level: 'macro-minor', pauseMin: 0 };
  if (MOVE.test(title)) return { level: 'move', pauseMin: 0 };
  return null;
}
// scheduled releases (Eastern time). 8:30 ET data on weekdays; FOMC decisions at 2:00 PM ET.
const FOMC_DECISIONS = ['2026-12-09', '2027-01-27'];
function etParts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, mins: +p.hour * 60 + +p.minute, wd: p.weekday };
}
function calendarPause(ms = Date.now()) {
  const e = etParts(ms);
  if (dataDay(e) && e.mins >= 8 * 60 + 25 && e.mins < 8 * 60 + 45) return 'US economic data release (8:30 AM ET)';
  if (FOMC_DECISIONS.includes(e.date) && e.mins >= 13 * 60 + 50 && e.mins < 14 * 60 + 50) return 'Fed (FOMC) decision & press conference';
  return null;
}
async function poll(req, seen) {
  const fresh = [];
  const results = await Promise.allSettled(FEEDS.map(u => req(u, { headers: { 'User-Agent': 'Mozilla/5.0 kalshi-bot', Accept: 'application/rss+xml, text/xml' }, raw: true })));
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const it of parse(r.value)) {
      const key = it.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').slice(0, 90);
      if (seen.has(key)) continue; seen.add(key);
      if (Date.now() - it.at > 45 * 60e3) continue; // only news from the last 45 min
      const c = classify(it.title); if (c) fresh.push({ ...it, ...c });
    }
  }
  if (seen.size > 3000) { const arr = [...seen].slice(-1500); seen.clear(); arr.forEach(x => seen.add(x)); }
  return { fresh, sourcesOk: results.filter(r => r.status === 'fulfilled').length, sources: FEEDS.length };
}
// The same story gets re-published by many outlets for hours; it should pause trading once, not every time.
const GENERIC = new Set('the and for with from that this will into over after amid about than then they them their its are was were has have had been not but all new now just says said report reports news update live latest today week year price prices market markets crypto cryptocurrency bitcoin btc ethereum eth hack hacked hacks exploit stolen theft attack fed federal reserve rate rates hike hikes inflation recession data us u s world global million billion'.split(' '));
const words = title => new Set(headline(title).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w.length >= 3 && !GENERIC.has(w) && !/^\d+$/.test(w)));
const FIRM = /\b(binance|coinbase|kraken|okx|bybit|bitfinex|gemini|tether|usdt|usdc|circle)\b/gi; // exchanges/stablecoins (regulators act on many firms, so they don't identify a story)
const venuesOf = t => new Set((headline(t).match(FIRM) || []).map(x => x.toLowerCase()));
// recent: titles (fresh) or { title, at }. A venue's hack/halt follow-ups keep coming for weeks (11/26: Binance's Oct 29 hack paused trading 3 times in
// 12 h; the 6-hour memory let the third through), so those match for 7 days; any other same-story match is 6 hours.
const STORY_MS = 6 * 3600e3, VENUE_MS = 7 * 24 * 3600e3;
function sameStory(title, recent, now = Date.now()) {
  const a = words(title), v = CRITICAL.test(headline(title)) ? venuesOf(title) : new Set();
  return (recent || []).some(x => {
    const r = typeof x === 'string' ? x : x.title, age = typeof x === 'string' ? 0 : now - x.at;
    if (v.size && age < VENUE_MS && CRITICAL.test(headline(r)) && [...venuesOf(r)].some(y => v.has(y))) return true; // follow-ups on the same venue's hack/halt ("DoJ seeks to recover…", "…moves tied to the Binance hack")
    if (age >= STORY_MS) return false;
    let n = 0; for (const w of words(r)) if (a.has(w)) n++; return n >= 2;
  });
}
const usDataDay = (ms = Date.now()) => dataDay(etParts(ms)); // a US weekday that isn't a federal holiday
module.exports = { poll, parse, classify, calendarPause, releaseWindow, decisionWindow, usDataDay, sameStory, VENUE_MS, FEEDS };
