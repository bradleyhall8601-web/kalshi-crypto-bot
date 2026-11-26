// News pause rules, checked against real headlines from the night of 2026-11-22.
'use strict';
const news = require('../news');
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name); } };
const pauses = (t, ms) => (news.classify(t, ms) || {}).pauseMin > 0;
const AT_840 = Date.parse('2026-11-25T13:40:00Z'), AT_1138 = Date.parse('2026-11-25T16:38:00Z'); // 8:40 and 11:38 AM ET on a Wednesday

console.log('News pause rules');
// real events still pause
ok(pauses('Major exchange Bybit hacked, $1.4B drained'), 'major exchange hack pauses');
ok(pauses('Binance suspends withdrawals after exploit - CoinDesk'), 'Binance suspends withdrawals pauses');
ok(pauses('Fed unexpectedly raises rates by 50bp - Reuters'), 'surprise Fed hike pauses');
ok(!pauses('Northwestern Mutual Wealth Management: Expects continued volatility in tech stocks; monitors impact of Federal Reserve rate hikes - 富途牛牛'), 'adviser commentary ("expects… monitors") does not pause (live 11/23 false pause)');
ok(!pauses('Gold edges up on bargain buying after selloff; US inflation data awaited - Investify'), '"data awaited" preview does not pause');
ok(!pauses('REGULATION | Circle Agrees to Mint Over $1 Billion Replacement USDC Linked to the Binance Hack - BitKE'), 'old-hack aftermath (replacement USDC) does not pause (live 11/24 false pause)');
ok(!pauses('US seeks over $1B in crypto tied to Binance hack - Qazinform'), 'old-hack legal follow-up ("US seeks") does not pause (live 11/24 12:48 PM false pause)');
ok(!pauses('Binance working with DoJ on recovery of stolen crypto - Breakingthenews.net'), 'old-hack recovery story does not pause (live 11/24 false pause)');
ok(pauses("Kraken's BTC/CAD market flash crash caused by liquidity - Pluang"), 'a live exchange flash crash still pauses');
ok(!pauses('Betashares Cyber ETF (ASX:HACK) Seeks Footing as Fed Rate Bets Shift - Kalkine Media'), 'a stock ticker named HACK is not a hack (live 11/23 false pause)');
ok(pauses('Bybit hacked: $1.4 billion in ETH stolen - CoinDesk') || pauses('Bybit hack: $1.4 billion in ETH stolen - CoinDesk'), 'a real exchange hack still pauses');
ok(pauses('Fed raises rates more than expected, stocks tumble - Reuters', Date.parse('2026-12-09T19:05:00Z')), 'a real surprise hike still pauses ("expected" is not commentary; at the Dec 9 decision)');
ok(pauses('CPI comes in hotter than expected, Treasury yields jump - Bloomberg', AT_840), 'hot CPI pauses right after the 8:30 release');
ok(!pauses('CPI comes in hotter than expected, Treasury yields jump - Bloomberg', AT_1138), 'the same CPI story hours later does not pause again');
ok(!pauses("Fed's preferred inflation gauge jumps to 3.8% as Wall Street braces for rate hike - CNBC", AT_1138), 'PCE reaction at 11:38 AM ET does not pause (live 11/25 10:38 AM CT false pause)');
ok(pauses('Fed unexpectedly hikes rates after hot CPI print - Reuters', AT_1138), 'a real Fed move still pauses at any time, even when it mentions data');
ok(news.releaseWindow(AT_840) && !news.releaseWindow(AT_1138) && !news.releaseWindow(Date.parse('2026-11-28T13:40:00Z')), 'release window: weekday 8:30–9:05 ET only (not Saturday)');
ok(!pauses('Chainflip Hack : $12M Stolen In Bitcoin, Ethereum And Stablecoins, 10% Bounty Offered - Crowdfund Insider'), 'small bridge hack that merely mentions bitcoin does not pause');
ok(pauses('Bitcoin network halted after consensus bug - CoinDesk'), 'bitcoin network halt pauses');
ok(!pauses('Strong Security Isn’t Enough to Keep Your Crypto Safe: CoinRabbit Report on the Binance Hack - Blockonomi'), 'report about an old hack does not pause');
ok(!pauses('Bill Ackman Fed Rate Hike Warning Raises US Recession Concerns - TronWeekly'), 'opinion "warning ... concerns" does not pause');
ok(!pauses("Halted food company's Bitcoin losses swell to $51M - www.thestreet.com"), 'a company holding bitcoin is not a market event');
ok(!pauses("CoinRabbit maps 5 layers of crypto platform risk with Binance's $6.4 billion hack as case study - Cryptopolitan"), 'case study does not pause');
ok(!pauses('Goldman Sachs: The market has already priced in four Federal Reserve rate hikes, but Warsh will continue to raise rates in December. - 富途牛牛'), 'bank outlook ("Goldman Sachs: …priced in…") does not pause (live 11/25 7:07 AM false pause)');
ok(!pauses('BlackRock Sees Only Two Fed Hikes Ahead, While Markets Price In Three and Bitcoin Slides - Crypto Briefing'), 'asset-manager view ("Sees… Price In") does not pause (live 11/25 4:00 AM false pause)');
ok(pauses('Fed unexpectedly hikes rates by 50 basis points as Warsh fights inflation - Reuters'), 'a real surprise Fed hike still pauses after the outlook filter');
ok(pauses('BlackRock bitcoin ETF halts redemptions after custody breach - Bloomberg'), 'a BlackRock ETF breach still pauses (outlook filter only applies to rate views)');
ok(!pauses('Behind Binance hack, a reckoning over who controls crypto market - BusinessWorld Online'), 'feature about an old hack ("Behind … a reckoning") does not pause (live 11/25 5:19 AM false pause)');
ok(!pauses('Tether reportedly sought 20% fees from crypto hack victims to return frozen USDT - Crypto News'), 'hack-victim fee story does not pause (live 11/25 2:09 AM false pause)');
ok(!pauses('Tether News Today: Will it Really Charge 20% to Unfreeze Hacked Funds? - Coin Gabbar'), 'question about old hacked funds does not pause');
ok(pauses('Tether freezes withdrawals after USDT depeg - Reuters') || pauses('Tether halts withdrawals after exploit - Reuters'), 'a live Tether halt still pauses');
ok(!pauses("PCE Inflation Hits 3.8%. Strong GDP Growth Raises Odds of More Fed Hikes. - Barron's"), 'data reaction ("Raises Odds of More Fed Hikes") does not pause (live 11/25 9:10 AM; release was 8:30 and already paused by the calendar)');
ok(!pauses('U.S. Initial Jobless Claims Fall to 189,000 Last Week; Labor Market Stability Adds Room for Federal Reserve Rate Hikes - BigGo Finance'), 'data reaction ("Adds Room for … Rate Hikes") does not pause (live 11/25 9:34 AM false pause)');
ok(!pauses('Nasdaq plunges 3.8% as AI stocks slide and inflation fuels Fed rate hike bets - Invezz'), 'stock-move story about rate bets does not pause (price shocks are caught by the price checks)');
ok(pauses('Fed hikes rates by 50 basis points in emergency move - Reuters') && pauses('Fed unexpectedly cuts rates, Warsh signals more - Bloomberg'), 'real Fed moves still pause');
// commentary / non-US / explainers no longer pause
ok(!pauses('Bill Ackman calls for 3% US inflation target, warns Fed rate hikes could trigger recession - ANI News'), 'fund manager opinion does not pause');
ok(!pauses('MCX gold prices rise Rs 2,800/10g after 5-day fall, silver jumps Rs 3,600/kg despite increasing rate hike - The Economic Times'), 'Indian gold prices do not pause');
ok(!pauses('XRP Market Analysis Reveals Impact of Binance Hack - The Cryptonomist'), 'market analysis piece does not pause');
ok(!pauses('Bitcoin Crashes to $17,000 This Weekend: Inside the Bizarre Flash Crash Mystery - BeInCrypto'), 'feature/explainer does not pause');
ok(!pauses('Cyber Says It Blocked Hack, Will Cover All CYBER Minted During Attack From Foundation Treasury - bloomingbit'), 'small-token hack ("Foundation Treasury") does not pause');
ok(!pauses('Can Bitcoin (BTC) Sustain Recovery as US Inflation Data Looms? - Kalkine Media'), 'question headline does not pause');
// the same story re-published elsewhere pauses only once
const first = ['Chainflip Hack : $12M Stolen In Bitcoin, Ethereum And Stablecoins, 10% Bounty Offered - Crowdfund Insider'];
ok(news.sameStory('Chainflip Hack Losses Rise to $12M After 122.9 BTC Theft - Coin Gabbar', first), 'Chainflip follow-up recognized as the same story');
ok(news.sameStory('Chainflip Offers 10% Bounty After 122.86 BTC Vault Hack - Altcoin Buzz', first), 'Chainflip bounty story recognized as the same story');
ok(news.sameStory('Federal Reserve: Consecutive hikes and sticky inflation – TD Securities - www.tmgm.com', ['Federal Reserve: Consecutive hikes and sticky inflation – TD Securities - FXStreet']), 'same headline from another outlet recognized');
ok(!news.sameStory('Major exchange Bybit hacked, $1.4B drained', first), 'a different hack is a new story');
ok(!news.sameStory('Coinbase halts trading after outage', ['Binance suspends withdrawals after exploit']), 'different exchanges are different stories');
const binance = ['9,293 Ether moves between wallets tied to the 2026 Binance hack - Crypto Briefing'];
ok(news.sameStory('DoJ seeks to recover over $1B in crypto stolen in Binance hack - Breakingthenews', binance), 'Binance hack follow-up (DoJ) is the same story');
ok(news.sameStory('US prosecutors seek to forfeit $1.17 billion in stolen USDC from Binance hack - Reuters', binance), 'Binance hack follow-up (forfeit USDC) is the same story');
ok(news.sameStory('Analytics firm Elliptic detects movement of $247 mln after Binance crypto exchange hack - Reuters', binance), 'Binance hack follow-up (Elliptic) is the same story');
ok(!news.sameStory('Coinbase hacked, withdrawals halted - CoinDesk', binance), 'a hack at a different venue is a new story');
ok(!news.sameStory('SEC charges Kraken over staking', ['SEC sues Coinbase over listings']), 'the same regulator acting on different firms is a new story');

// live 11/25 evening: three false pauses cost the 9:00 and 9:15 PM CT windows
const AT_843PM = Date.parse('2026-11-26T02:43:00Z'), DEC9_205 = Date.parse('2026-12-09T19:05:00Z'), DEC10_10 = Date.parse('2026-12-10T15:00:00Z'), DEC11_10 = Date.parse('2026-12-11T15:00:00Z');
ok(!pauses('Fed Raises Rates as AI Spending Fuels Inflation - Wisevoter', AT_843PM), '"Fed Raises Rates…" with no Fed meeting today does not pause (live 8:43 PM CT)');
ok(!pauses('Gold Slips Toward $3,575 as Firm Inflation Keeps Fed Hikes on the Table - BigGo Finance', AT_843PM), '"…Keeps Fed Hikes on the Table" is speculation, not a decision (live 9:03 PM CT)');
ok(!pauses('SEC Orders CARZIQO to Halt Unregistered Investment Scheme, Pull Mobile App - BitPinas', AT_843PM), 'a regulator halting a small non-crypto scheme does not pause (live 8:55 PM CT)');
ok(pauses('Fed raises rates by 25 basis points, signals one more hike - Reuters', DEC9_205), 'the real decision (Dec 9, 2:05 PM ET) still pauses');
ok(pauses('Fed raises rates by 25 basis points, signals one more hike - Reuters', DEC10_10), '…and the morning after');
ok(!pauses('Fed raises rates by 25 basis points, signals one more hike - Reuters', DEC11_10), '…but not two days later');
ok(pauses('Fed hikes rates in emergency move - Reuters', AT_843PM), 'an emergency Fed move pauses any day');
ok(pauses('SEC halts trading in bitcoin ETF - Reuters', AT_843PM) && pauses('SEC sues Coinbase over unregistered exchange - CNBC', AT_843PM) && pauses('Binance halts withdrawals after hack - CoinDesk', AT_843PM), 'crypto regulator actions and exchange halts still pause');
ok(news.decisionWindow(Date.parse('2027-03-20T15:00:00Z')), 'past the listed FOMC dates the decision filter steps aside (never hides a real decision)');
// live 11/26 overnight: four more false pauses (5 windows)
const AT_1130PM = Date.parse('2026-11-26T05:30:00Z');
ok(!pauses('Binance hack: court freezes $6.5bn, beware phishing - CryptoTicker.io', AT_1130PM), 'court follow-up to the Oct 29 Binance hack does not pause (live 11:30 PM CT)');
ok(!pauses('Binance Hack: Court Docs Reveal 192 Crypto Assets Stolen - Daily Beirut', AT_1130PM), '"court docs reveal…" about the old hack does not pause (live 5:32 AM CT)');
ok(!pauses('Scammers bait TRON users with frozen USDT, then drain their TRX deposits - CryptoSlate', AT_1130PM), 'a scam draining users is not a market event (live 6:50 AM CT)');
ok(pauses('Binance hacked: $400M drained from hot wallet - CoinDesk', AT_1130PM) && pauses('Tether freezes redemptions as USDT depegs - Reuters', AT_1130PM), 'a fresh exchange hack / stablecoin depeg still pauses');
ok(pauses('Kraken files for bankruptcy - Reuters', AT_1130PM) && pauses('Coinbase insolvent, halts withdrawals - Bloomberg', AT_1130PM), '"bankruptcy" and "insolvent" match (they did not: the words were cut short)');
ok(!pauses('Federal Reserve: Gradual hikes priced – Commerzbank - FXStreet', AT_1130PM) && !pauses('Fed: Two more hikes likely – ING - FXStreet', AT_1130PM), 'bank analyst notes ("– Commerzbank", "– ING") do not pause (live 11/26 8:55 AM CT)');
ok(!news.calendarPause(Date.parse('2026-11-26T13:30:00Z')), 'no 8:30 AM ET data pause on Thanksgiving (live 7:25 AM CT)');
ok(news.calendarPause(Date.parse('2026-11-27T13:30:00Z')) && news.calendarPause(Date.parse('2026-11-25T13:30:00Z')), '…but the day before and after still pause at 8:30 ET');
ok(!news.releaseWindow(Date.parse('2026-12-25T13:40:00Z')) && news.releaseWindow(Date.parse('2026-12-24T13:40:00Z')), 'no release window on Christmas; there is one on Dec 24');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
