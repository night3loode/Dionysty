# Dionysty

Live-code baseline of Dionysty, synced from production on 2026-11-25.

- `index.html`, `house/`, `app/`, `assets/`: the Cloudflare Pages site (https://dionysty.pages.dev). Pages deploys come from a direct upload, not from this repo, so changes here do not go live on their own.
- `worker/worker.js`: the Cloudflare Worker backend (D1 database, Telegram bot, cron).

## Rules for changes

- Work on a branch and open a pull request. Do not push to `main`.
- This repo is public. Never commit secrets, tokens, member data or message content.
- Keep the constant `RETENTION_START = 1795619418620` unchanged in `worker/worker.js` and `app/index.html`. It anchors the message-retention grace period. Changing it would reset or break retention.

## Worker environment (names only, values live in Cloudflare)

Secrets/vars the Worker reads: `BOT_TOKEN`, `WEBHOOK_SECRET`, `SHEET_URL`, `TEAM_CHAT_ID`, `INVITE_CHAT_ID`, `FOUNDER_IDS`, `GOD_SETUP_HASH`, plus optional settings (`CALL_LINK`, `CALL_HOURS`, `CALL_MINUTES`, `CALL_TIMES`, `CITY_NAME`, `DEFAULT_ROOM`, `BOND_TARGET`, `VOTE_HOURS`, `VOUCH_FOR`, `MEMBER_PHOTOS`, `LAB`) and the D1 binding `D1`. See the header comment of `worker/worker.js`.
