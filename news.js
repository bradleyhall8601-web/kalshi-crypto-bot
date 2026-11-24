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
const CRITICAL = /\b(hack(ed)?|exploit(ed)?|drain(ed)?|stolen|breach|outage|halt(s|ed)?|suspend(s|ed)? (withdrawals|trading)|insolven|bankrupt|depeg|emergency|liquidation cascade|flash crash|sec (sues|charges)|crackdown|ban(s|ned)? (bitcoin|crypto))\b/i;
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
const VENUE = /\b(binance|coinbase|kraken|okx|bybit|bitfinex|gemini|tether|usdt|usdc|circle|blackrock|etf|sec|cftc|us treasury|treasury (department|secretary)|white house)\b/i;
const CHAIN = /\b(bitcoin|ethereum|btc|eth) (network|blockchain|chain|core|mainnet|nodes?)\b/i;
const MAJOR = { test: t => VENUE.test(t) || CHAIN.test(t) };
// commentary, previews and explainers describe events, they aren't the event: log them, don't pause
const NOT_EVENT = /\b(analysis|analyst|inside|mystery|explained|explainer|week ahead|what|why|how|could|may|might|warns?|warning|concerns?|calls? for|opinion|preview|prediction|forecast|outlook|lessons|report on|case study|maps|risks?|expects?|monitors?|awaits?|awaited|eyed|in focus|forfeiture|seizes?|seizure|recover(?:y|ing|s)?|replacement|working with)\b|\?/i;
// a macro pause needs US policy itself in the headline (not gold prices in India or a fund manager's view)
const US_POLICY = /\b(fed|fomc|federal reserve|powell|warsh|cpi|payrolls|nonfarm|jobs report|treasury yields?)\b/i;
const POLICY_SHOCK = /\b(raises|cuts|hikes|surprise|unexpected(ly)?|hotter|cooler|emergency|shock|jumps|surges|plunges)\b/i;
const headline = title => String(title).replace(/\s+[-–|]\s+[^-–|]+$/, '').replace(/\(\s*[A-Z]{2,6}\s*:\s*[A-Z0-9.]{1,6}\s*\)/g, ''); // drop the " - Outlet" suffix and stock tickers like (ASX:HACK)
function classify(title) {
  const h = headline(title), event = !NOT_EVENT.test(h);
  if (CRITICAL.test(h)) return MAJOR.test(h) && event ? { level: 'critical', pauseMin: 15 } : { level: 'critical-minor', pauseMin: 0 };
  if (MACRO.test(h)) return POLICY_SHOCK.test(h) && US_POLICY.test(h) && event ? { level: 'macro', pauseMin: 10 } : { level: 'macro-minor', pauseMin: 0 };
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
  if (!['Sat', 'Sun'].includes(e.wd) && e.mins >= 8 * 60 + 25 && e.mins < 8 * 60 + 45) return 'US economic data release (8:30 AM ET)';
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
function sameStory(title, recent) {
  const a = words(title), v = CRITICAL.test(headline(title)) ? venuesOf(title) : new Set();
  return (recent || []).some(r => {
    if (v.size && CRITICAL.test(headline(r)) && [...venuesOf(r)].some(x => v.has(x))) return true; // follow-ups on the same venue's hack/halt ("DoJ seeks to recover…", "…moves tied to the Binance hack")
    let n = 0; for (const w of words(r)) if (a.has(w)) n++; return n >= 2;
  });
}
module.exports = { poll, parse, classify, calendarPause, sameStory, FEEDS };
