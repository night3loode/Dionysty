# 09 DIONYSTY web app: what it is and how it works

Read this first, then the code files 12, 13a, 13b, 13c and 14. Everything below was read from the public app at /app/ and /house/ on dionysty.pages.dev (the same files the lab serves). Facts marked VERIFIED come from that code. Facts marked UNRESOLVED we could not see, so do not invent them.

## 1. What the app is (VERIFIED from the code)
- One static HTML file (about 396 KB, no build step, no framework) at /app/. Title "DIONYSTY · Starlove". The homepage links to it with /app/#meet.
- It is a Telegram Mini App and a normal web page. It loads telegram.org/js/telegram-web-app.js. Inside Telegram it signs in with Telegram's initData. Outside Telegram it uses a saved login object in localStorage ("dy_login").
- It talks to a separate backend, a Cloudflare Worker (host replaced with <BOT_WORKER_HOST> in the code files). Every call is POST JSON to <BOT_WORKER_HOST>/api/<path>. Body always carries initData, or login when there is no initData. Responses are JSON with ok true/false and an error string on failure. Network failure becomes {ok:false,error:"We couldn't reach Starlove..."}.
- Starlove is the in-world name of the host/bot voice ("Hey love, we hope you've been divine"). Members are shown only by alias and a Sigil.
- Third-party scripts: telegram-web-app.js, qrcode-generator 1.4.4 (jsdelivr), Google Fonts (Cormorant Garamond, Jost, Michroma).

## 2. Screens (each is a <section id="s-..."> toggled by show(id), with a history stack and Telegram BackButton)
s-load, s-out (sign in with Telegram), s-hello (18+ gate), s-minor (blocked under 18), s-name (alias), s-sigil (give 10 points across 7 temples, max 5 per temple), s-come (gender, and come alone / with partner / with friend plus a personal code), s-words (why here, what to do, who invited, reddit username, then "Say hello" which calls register), s-light (the moment members approve you), s-home (profile: personal code, door pass, settings, reshape Sigil, rename, sign out), s-edit, s-rename, s-pass (rotating QR door pass, changes every 30 s), s-doorres (team door scanner result), s-village (main Space view: The First House, circles, map places), s-dms (messages, village members, waitlist), s-thread, s-person, s-about (welcome/club text).

## 3. The seven Temples (VERIFIED, var T in the script)
id, name, trait, line: artists/The Artists/creative/make, perform or show work; revellers/The Revellers/magnetic/music, dance, celebration; lovers/The Lovers/loving/connection, romance, maybe love; healers/The Healers/kind/care, presence, holding space; wanderers/The Wanderers/fun/trips, adventures, the unfamiliar; thinkers/The Thinkers/smart/ideas, books, long arguments; builders/The Builders/bold/shaping the culture and its traditions. Constants: BUDGET=10 points, MAX=5 per temple. The Sigil is an SVG polygon drawn from the 7 point values.
Note: the homepage uses a different display order and Roman numerals (I Artists, II Thinkers, III Healers, IV Lovers, V Wanderers, VI Revellers, VII Builders) and its own copy lines. Keep the homepage copy as is.

## 4. Space view code (VERIFIED)
The in-app rotating sky ("sky*" functions: skyLoad, skyFly, skyWarp, skyArch, skyW2S, skyTap, slFlower, drawTempleStatue, camCruise, etc.) is what the homepage hero was ported from. Files 13a to 13c contain all of it. The homepage hero is a visual port: it has no members, rooms, or live data.

## 5. Backend endpoints called by the client (VERIFIED paths, UNRESOLVED server code)
All paths below are under /api/. Request bodies shown are what the client sends; response fields are only what the client reads. We do not have the Worker source, database schema, or validation rules.
- me, register, pass, door: profile state, onboarding submit (adult, alias, points{temple:int}, gender, mode, withCode, why, want, invite, reddit), door pass token (rendered as QR), team door check ({token} returns valid/verdict).
- sq/village, sq/sky, sq/map, sq/lab/ and sq/lab/count: village members and rooms, sky data, map places, lab counters.
- sq/h/state {vibe, near}, sq/h/join {id}, sq/h/knock {id}, sq/h/new {vibe, topic}, sq/h/say {text}, sq/h/unsay {id}, sq/h/answer {kid, a}, sq/h/leave, sq/h/hush {on}, sq/h/glad {pid}, sq/h/prefs {quiet}: House/circle activity. The client polls sq/h/state every 3 s when in a circle, 5 s otherwise.
- sq/h/dm/list, sq/h/dm/thread {pid, after}, sq/h/dm/send {pid, text}: private messages.
- sq/vouch {pid, on}, sq/vote {pid, v}, sq/bond {pid}: trust and bonding between members.
- sq/duty/new {title, body, kind}, sq/duty/list, sq/duty/<id>: The Duty Board; answering duties earns tokens (a token cap rule: duties between the same two people carry tokens at most twice a week).
- sq/pg/list, sq/pg/targets, sq/pg/draft {id}, sq/pg/start {pid}, sq/pg/meet {id, after}, sq/pg/say {id, text}, sq/pg/<id>: Wayside pilgrimages (member to member meetups, fuelled by tokens).
Raw call sites with surrounding client code are in file 10.

## 6. Storage on the device (VERIFIED)
localStorage keys: dy_login (non-Telegram sign-in object), dy_me (alias, room, timestamp; the homepage uses this only to greet a returning member), dy_sl (last 50 thread entries), dy_lit_<code> (marks that the "light" moment was shown). No cookies, no sessionStorage.

## 7. How the homepage connects
- Homepage CTAs link to /app/#meet (13 links) and /house/ (3 links). Do not change those paths.
- The homepage has a tiny script that reads dy_login/dy_me to greet returning members.
- /house/ is the static page for "The First House" (Fri 4 to Sun 6 Dec 2026, Delhi NCR, up to 50 people, invitation only). We found no form or fetch in that file; its calls to action lead into /app/. (File 14.)

## 8. Not included on purpose
No credentials, secrets, tokens, or member data are in these files. The backend host is replaced with a placeholder. There is no real member data in the client code.

## 9. UNRESOLVED (ask the user, do not guess)
- Worker source, database schema, rate limits, who can see what server-side.
- How members are approved (the "members said yes" flow) and the 18+ in-person check process.
- Whether the Telegram bot has other commands or webhooks.
- Exact response shapes beyond what file 10 shows.
- Whether a native/Telegram-store listing exists.

## 10. Rules for any change you propose
- Do not change /app/ or /house/ unless the user asks. Our test site shares the live backend, so never submit forms against it.
- Keep copy, the 7 temple names, and all link paths. No em dashes. Keep the privacy line: "Your conversation is private. Your membership is never public."
- Say what you could not verify.
