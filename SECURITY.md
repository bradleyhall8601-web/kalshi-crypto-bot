# Security

- No secrets are stored in this repository. All keys live only in Render environment variables.
- Only the owner's Telegram chat can control the bot. Claiming it requires a private one-time code; every other chat is ignored and logged.
- Telegram webhook calls are verified with a secret header; the public URL reveals nothing.
- Code changes requested through `/claude` deploy only after the owner taps Approve, and can be undone with `/rollback`.
- If a key is ever exposed: revoke it at its source (Kalshi, Telegram @BotFather `/revoke`, Anthropic console, GitHub tokens) and replace it in Render.
