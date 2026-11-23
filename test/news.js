// News pause rules, checked against real headlines from the night of 2026-11-22.
'use strict';
const news = require('../news');
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name); } };
const pauses = t => (news.classify(t) || {}).pauseMin > 0;

console.log('News pause rules');
// real events still pause
ok(pauses('Major exchange Bybit hacked, $1.4B drained'), 'major exchange hack pauses');
ok(pauses('Binance suspends withdrawals after exploit - CoinDesk'), 'Binance suspends withdrawals pauses');
ok(pauses('Fed unexpectedly raises rates by 50bp - Reuters'), 'surprise Fed hike pauses');
ok(pauses('CPI comes in hotter than expected, Treasury yields jump - Bloomberg'), 'hot CPI pauses');
ok(!pauses('Chainflip Hack : $12M Stolen In Bitcoin, Ethereum And Stablecoins, 10% Bounty Offered - Crowdfund Insider'), 'small bridge hack that merely mentions bitcoin does not pause');
ok(pauses('Bitcoin network halted after consensus bug - CoinDesk'), 'bitcoin network halt pauses');
ok(!pauses('Strong Security Isn’t Enough to Keep Your Crypto Safe: CoinRabbit Report on the Binance Hack - Blockonomi'), 'report about an old hack does not pause');
ok(!pauses('Bill Ackman Fed Rate Hike Warning Raises US Recession Concerns - TronWeekly'), 'opinion "warning ... concerns" does not pause');
ok(!pauses("Halted food company's Bitcoin losses swell to $51M - www.thestreet.com"), 'a company holding bitcoin is not a market event');
ok(!pauses("CoinRabbit maps 5 layers of crypto platform risk with Binance's $6.4 billion hack as case study - Cryptopolitan"), 'case study does not pause');
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

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
