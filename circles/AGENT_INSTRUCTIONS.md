# Agent instructions: Circles, Stars and Starlight

You are shipping a finished, tested feature for the Dionysty web app. The code is written. Your job is to place it in the repo, deploy it to the **lab only**, verify it, and report back. Read `SPEC.md` for the product rules. Do the steps in order and stop at any step that fails.

## Where this lives

Two branches in `night3loode/Dionysty`, each with its own pull request:

- **`feature/circles`**: this package in `circles/`. Part A ships it to the lab through a separate staging Worker. Nothing live changes.
- **`feature/circles-worker`** (built on top of the first): the same feature wired into the live Worker (`worker/worker.js`) and the app (`app/index.html`, `app/circles.js`). Part B. Merging never deploys, and it must not be deployed until Dhairya says so.

Follow the repo's own `README.md` rules as well: never commit secrets or member data (the repo is public), keep `RETENTION_START` unchanged, and follow the Worker deployment contract.

## Non-negotiable rules

1. **Lab first.** Nothing in this package goes to the live site or the live Worker without Dhairya's explicit go-ahead in writing. Part A never touches live. Part B is only for after his approval.
2. **Do not change the live bot Worker or the live database in Part A.** Part A uses a separate staging Worker with its own D1 database.
3. **Do not edit the app's existing code.** The client is one extra script tag. Nothing else in `/app/index.html` changes.
4. **No em dashes in any copy you add.** Members are shown by alias only.
5. **One branch, one pull request.** Never push to `main` directly.
6. If anything here conflicts with what you find in the repo, stop and report it rather than guessing.

## What is in this package

| Path | What it is |
|---|---|
| `worker/circles/circles.js` | The whole backend: rules, presence, knocks, Starlight, stars, dimming, deletion. Pure module, no framework. |
| `migrations/0001_circles.sql` | New tables, all prefixed `c_`. Additive only. `0001_circles.down.sql` removes them. |
| `worker/staging/` | A small standalone Worker (`dionysty-circles-lab`) that serves `/api/sq/c/*` for the lab, with its own D1. |
| `app/circles.js` | The client. Adds a Circles button and screen to the app. Talks only to `/api/sq/c/*`. |
| `tests/circles.test.js` | 24 backend tests, one or more per acceptance check in the spec. |
| `tests/e2e.py` | Two real browsers (Asha and Bilal) on a phone-sized screen, end to end. |
| `tests/live_worker_test.py` | Circles running inside the real live Worker code, locally, with its real sign-in check. |
| `scripts/patch-worker.mjs` | Inlines the backend into `worker/worker.js` (used for Part B). |
| `scripts/dev-server.js` | Local server: runs the backend on Node's SQLite and serves a test page. |

## Part A: ship to the lab (no live changes)

### A1. Check out the branch

`git fetch && git checkout feature/circles`. Everything is in `circles/`.

### A2. Run the tests locally

Requires Node 22.13 or newer (uses the built-in `node:sqlite`).

```bash
cd circles
npm test                      # 24 backend tests, expect: pass 24, fail 0
```

End-to-end in a browser (needs Python 3 and Playwright):

```bash
pip install playwright && python -m playwright install chromium
node --no-warnings scripts/dev-server.js &      # http://localhost:8787/?as=a
python3 tests/e2e.py                            # expect: e2e passed
kill %1
```

Screenshots land in `tests/shots/`. Open them and check they look right.

### A3. Test the staging Worker in Cloudflare's runtime (local)

This runs the real Worker in workerd with a local D1, before deploying anything.

```bash
cd circles/worker/staging
npm i -D wrangler@3
cp wrangler.toml wrangler.local.toml
# In wrangler.local.toml set: database_id = "local-test", MAIN_API = "http://127.0.0.1:8787/api/", ALLOWED_ORIGINS = ""
npx wrangler d1 migrations apply dionysty-circles-lab --local -c wrangler.local.toml
npx wrangler dev --local --port 8788 -c wrangler.local.toml &
cd ../.. && CIRCLES_API=http://localhost:8788/api/ node --no-warnings scripts/dev-server.js &
CIRCLES_API=http://localhost:8788/api/ python3 tests/e2e.py     # expect: e2e passed
```

The dev server stands in for the live Worker's `sq/v2/me` here, so nothing real is called.

### A4. Create and deploy the staging Worker

```bash
cd circles/worker/staging
npx wrangler d1 create dionysty-circles-lab
```

1. Copy the `database_id` it prints into `wrangler.toml`.
2. `MAIN_API` is already set to the live Worker's API base (`https://dionysty-bot.night3loode.workers.dev/api/`, the same as `var API` in `app/index.html`).
3. Keep `ALLOWED_ORIGINS = "https://lab.dionysty.pages.dev"`.
4. For the first round, set `CIRCLES_PIDS` to the team's own pids (comma separated) so only the team can use it. Leave empty later to open it to everyone on the lab.

```bash
npx wrangler d1 migrations apply dionysty-circles-lab --remote
npx wrangler deploy
```

This creates a new Worker and a new database. It does not touch the live Worker or its data. The staging Worker only **reads** from the live Worker, through `sq/v2/me`, to learn who is signed in.

Check it:

```bash
curl -s -X POST https://dionysty-circles-lab.<your-subdomain>.workers.dev/api/sq/c/sky -H 'content-type: application/json' -d '{}'
# expect: {"ok":false,"error":"Please sign in again."}
```

### A5. Build the lab site folder

Pages takes a direct upload of a whole folder, and the repo root also holds `worker/` and `circles/`, which must never be uploaded. Build a clean folder:

```bash
rm -rf /tmp/lab-site && mkdir -p /tmp/lab-site
cp -r assets app house /tmp/lab-site/
```

Then add the lab's **current homepage** as `/tmp/lab-site/index.html`. The repo's root `index.html` is the live homepage, not the lab's redesigned one, so do not use it. Use the latest lab homepage from the homepage redesign work (confirm with Dhairya which file is current if unsure). Deploying the wrong one would overwrite the lab redesign.

Then in that folder:

1. Copy `circles/app/circles.js` to `/tmp/lab-site/app/circles.js`.
2. In `/tmp/lab-site/app/index.html`, immediately before `</body>`, add these two lines and nothing else:

```html
<script>window.DY_CIRCLES={api:'https://dionysty-circles-lab.<your-subdomain>.workers.dev/api/'}</script>
<script src="/app/circles.js" defer></script>
```

Do not commit these lab-only edits. They point the app at the staging Worker.

### A6. Deploy the lab

```bash
npx wrangler pages deploy /tmp/lab-site --project-name dionysty --branch lab
```

Then open https://lab.dionysty.pages.dev/ and confirm the homepage is still the redesigned one.

Never pass `--branch main` or omit `--branch`.

### A7. Verify on the lab

Use two phones (or two browsers) signed in as two team members. Do not use real members' accounts. Tick each item and screenshot anything that fails.

Phase 1, circle modes and knocks:
- [ ] The Circles button appears on the app's main screens (wherever the tab bar shows).
- [ ] Open circle: the second person comes straight in.
- [ ] Knock circle: the second person knocks; the founder sees "X is knocking" and lets them in; the second person flies in without tapping again.
- [ ] Invite only: no knock button for outsiders; outsiders see only the name and theme, never who is inside.
- [ ] Someone other than the founder invites a third person into a knock or invite circle: the founder sees "X wants to bring Y"; nothing happens until answered.
- [ ] Founder leaves the app for over 2 minutes: the others can now answer knocks. Founder comes back: only the founder answers again.
- [ ] Founder changes the mode inside the circle; the other phone sees it within a few seconds.

Phase 2, presence:
- [ ] Switching to the app's Messages and back keeps you in the circle.
- [ ] Leaving the app for under 2 minutes and returning keeps you in.
- [ ] Closing the app removes you after about 2 minutes. When the last person goes, the circle disappears.

Phase 3, Starlight and stars:
- [ ] Each person can give 5 Starlight a day; the 6th is refused politely. No more than 3 to the same circle or star.
- [ ] A circle with 10 light from 5 different people becomes a star when everyone leaves. With less, it disappears.
- [ ] A star shows its name, theme, Temple and pinned line, never who was there.
- [ ] Only people who were in the circle can read what was said in its star.

Phase 4, dimming:
- [ ] A star's brightness falls over a day; giving it light raises it. (To see it disappear quickly, temporarily set `STAR_DECAY_PER_DAY = "200"` in the staging Worker's vars, redeploy, wait an hour for the cron, then set it back.)

Phase 5, Temple rooms:
- [ ] Room chips filter the sky. A circle started in a room shows in that room.

### A8. Open the pull request and report

Comment on the existing PR for `feature/circles`. In the description include: the A7 checklist with results, screenshots, the staging Worker URL, and the open decisions table from `SPEC.md`. Then tell Dhairya it is ready on the lab for him to try, and wait.

## Part B: production (only after Dhairya's written go-ahead)

Branch `feature/circles-worker` already contains the integration. Recommended over a separate production Worker because the invite list then includes every member.

What it changes:
- `worker/worker.js`: one generated block (between `CIRCLES START` and `CIRCLES END`) that routes `/api/sq/c/*` through the Worker's existing sign-in (`tgWebAppUser`, `tgLoginUser`), reads aliases from the existing `people` table, and stores everything in new `c_*` tables in the existing `D1` binding. Tables are created on first use. One call added to the existing `scheduled()` for sweeps. No new bindings, so the binding list in the deployment contract does not change.
- `app/circles.js` and two lines at the end of `app/index.html`, pointing at the main Worker's API.

To regenerate the block after changing `circles/worker/circles/circles.js`: `node circles/scripts/patch-worker.mjs worker/worker.js` (safe to run repeatedly).

Test before deploying (runs the real Worker locally with throwaway values):

```bash
npm test --prefix circles
mkdir -p /tmp/live && cp worker/worker.js /tmp/live/ && cp circles/tests/live-wrangler.toml /tmp/live/wrangler.toml
(cd /tmp/live && npx wrangler dev --local --port 8790) &
sleep 10 && python3 circles/tests/live_worker_test.py        # expect: live worker circles test passed
```

Deploy, following the README's deployment contract exactly:
1. Read the live Worker's current settings and save the binding list.
2. Upload the new `worker/worker.js` with the complete binding metadata, as the contract lists.
3. Read the settings back and compare. They must match.
4. Call `/api/sq/c/sky` without signing in; expect a 401. Then check `/api/me` still works from the app.
5. Deploy the app change to the **lab** first (A5 and A6, but with the branch's `app/index.html` and `app/circles.js`, no staging lines). Only after Dhairya checks it, deploy the same app files to live.

Optional Worker vars (not required; leaving them out keeps the binding list unchanged): `CIRCLES_ON` (set to `"0"` to switch circles off), `CIRCLES_PIDS` (limit to certain pids), and the tuning vars in the table below. If you add any, add them to the deployment contract in the README in the same PR.

**Rollback:** remove the two script lines from `app/index.html` and redeploy Pages. To switch the backend off, set `CIRCLES_ON = "0"` (staging: in its `wrangler.toml`; live: as a plain_text var, following the contract) or redeploy the previous `worker.js`. To remove all circles data, run `migrations/0001_circles.down.sql` against that database.

## Settings you can change without code

All are Worker vars (strings). Defaults in brackets.

| Var | Meaning |
|---|---|
| `CIRCLES_ON` [on] | Master switch. Anything but "1" turns circles off. |
| `CIRCLES_PIDS` [""] | Comma-separated pids allowed to use circles. Empty means everyone signed in. |
| `FOUNDER_IDLE_MS` [120000] | After this long without the founder, anyone inside can answer knocks. |
| `PRESENCE_GRACE_MS` [120000] | How long after leaving the app you stay in a circle. |
| `STARLIGHT_DAILY` [5] | Starlight per person per day (resets at midnight India time). |
| `STARLIGHT_PER_TARGET` [3] | Most a person can give one circle or star in a day. |
| `STAR_MIN_LIGHT` [10] / `STAR_MIN_GIVERS` [5] | What a circle needs to become a star. |
| `STAR_DECAY_PER_DAY` [2] | How fast stars dim. |
| `CIRCLE_CAP` [8] | Seats per circle. |

## Known limits (tell Dhairya, do not fix without asking)

- Circles live on their own Circles screen, opened from a button, drawn in the Space style. Drawing them inside the app's main Space canvas is a follow-up that needs changes to the app's own code.
- The app's existing circles ("light a star") keep working beside the new ones. Retiring them is a separate decision.
- Temple rooms exist as places (filters, and circles belong to them). Each room's own ritual (Gallery, Introductions and so on) is not built yet and needs Dhairya's go-ahead per room.
- No message rate limit beyond 500 characters per message.
