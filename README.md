# Kalshi crypto prediction bot

Fully automatic Kalshi crypto bot: BTC, ETH, SOL, XRP, DOGE, BNB, HYPE, NEAR and ZEC on 15-minute, hourly and daily (5 PM ET) markets. Prices from Coinbase, Kraken, Bitstamp, Gemini and Hyperliquid; learns from 72h of price history every 6h and from its own real wins/losses per market type (losing types must show a bigger edge or sit out 6h). Reports everything in Telegram (/coins, /learn, /why, /report).

Runs on Render (`npm start`). Secrets live only in Render environment variables:
`KALSHI_KEY_ID`, `KALSHI_PRIVATE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO`, `BOT_START_TS`.

## Disclaimer
Trading on Kalshi risks losing money. This bot's model has no guaranteed edge; past results don't predict future ones. Use small amounts. Not financial advice.

See SECURITY.md.
