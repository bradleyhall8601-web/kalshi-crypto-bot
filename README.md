# Kalshi crypto prediction bot

Scans Kalshi hourly BTC/ETH markets, sends Telegram trade ideas with Buy/Skip buttons, and auto-trades once profit passes the unlock threshold. Talk to it with `/claude` in Telegram.

Runs on Render (`npm start`). Secrets live only in Render environment variables:
`KALSHI_KEY_ID`, `KALSHI_PRIVATE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO`, `BOT_START_TS`.

## Disclaimer
Trading on Kalshi risks losing money. This bot's model has no guaranteed edge; past results don't predict future ones. Use small amounts. Not financial advice.

See SECURITY.md.
