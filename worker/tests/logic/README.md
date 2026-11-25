# Logic tests (stub only)

Run from a scratch folder: copy `worker/worker.js` there as `worker.mjs`, add this line at the end, copy the `*.test.mjs` files next to it, then `node --no-warnings <file>`:

    export { sweepExpiry, forgetAll, v2Api, recByCode, readPass, RETENTION_START, V2_MEDIA_OK, sweepOrphans, onPrivate, mediaDrop, mediaPurgeSweep, notify, ntExpiring, bcPump, ntButton };

They use an in-memory SQLite database built from the worker's own CREATE TABLE statements and a fake Drive bridge. They are not proof of live behaviour (no real Telegram, D1, KV or phone). `app-dm-thread.playwright.js` is a headless-browser check with mocked API responses and needs a local copy of the app with a test hook.

`notify.test.mjs` (notifications, `/notifications`, disappearing-message reminders) and `broadcast-console.playwright.js` (drives the Starlove console's Broadcast tab, served by the worker itself) also need `notify-env.mjs` next to them. Run the Playwright one with `node`; it writes two screenshots into the folder.
