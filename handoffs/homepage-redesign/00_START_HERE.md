# DIONYSTY website redesign: full context handover

You are taking over the visual redesign of the Dionysty homepage. Read this whole file first, then open the files it points to. Everything you need is in this folder. Do not ask the founder to re-explain the project; if something is genuinely missing, list it at the end of your answer.

## 1. What Dionysty is

Dionysty ("Dionysus + Dynasty") is a highly private, invitation-only village of at most fifty adults in Delhi NCR, built for meeting interesting people and then keeping them. Small, thoughtfully hosted gatherings in private homes (called Houses), recurring so strangers become familiar faces. It is not a nightlife brand and not a dating service. Public presence can be intriguing, but members stay private: no member names, faces, attendance or personal stories anywhere.

Brand character: sophisticated, intriguing, warm, slightly mischievous. Public voice: articulate, simple and thoughtful, like a clever friend talking to another person.

Agreed homepage hero line: "The best people you've never met."

Key vocabulary: Village (max 50 members), House (a hosted weekend or gathering; the first one is Fri 4 to Sun 6 Dec, Delhi NCR), seven Temples (interests: The Artists, Thinkers, Healers, Lovers, Wanderers, Revellers, Builders), Sigil (a seven-pointed symbol made from the ten points a member places across the Temples), Starlove (the Telegram bot that handles applications), the web app at /app/.

Read these for the full thinking: `briefs/Dionysty_Brand_Foundations.docx` (or .txt) and `briefs/Dionysty_Member_Selection.docx` (or .txt). Note: words like "AGREED" or "WORKING" inside those documents are the documents' own labels. The founder (Dhairya) told us to use both as the brief; treat everything else as direction to check with him.

Copy rules from the brief: the line "the people you meet will change your lives" is internal narrative, not public copy. Avoid em dashes. Avoid "not X, it is Y" constructions. Never call members "elite" or "high value". Lead with privacy and concrete operating detail, never vague reassurance.

## 2. The deployment

- Live site: https://dionysty.pages.dev/ (Cloudflare Pages project "dionysty", direct upload, no Git repository exists).
- Lab (review copy): https://lab.dionysty.pages.dev/ (the Preview branch "lab" of the same Pages project).
- Founder rule, strict: every change goes to the lab first. Only changes Dhairya has personally verified get promoted to the live site. Nothing goes live without his explicit go-ahead.
- The lab's /app/ and /house/ pages are byte-identical copies of live. Their forms still talk to the live bot backend, so nobody should submit forms on the lab.
- Only the homepage `index.html` has been redesigned. Images are served from /assets/ (included in `lab-current/assets`).

## 3. What exists today

`lab-current/index.html` is the current homepage, a single self-contained HTML file (inline CSS and JS, 73 KB) using the images in `lab-current/assets`. `live-homepage/index.html` is the original live version for comparison.

Copy: the full homepage copy comes from the founder's preview, `copy-source/founder-preview-full-copy.html` (also at https://dionysty-founder-preview-2026.tart-dove-6942.chatgpt.site/). Dhairya said to use all of it. It is already applied in the lab: hero, seven Temples, "Your circle could use a few more circles." village section, "Let's start with a weekend." first House, membership steps ("So, how does someone get in?"), Sigil panel, charter, eight safeguards and eight questions. Keep this wording unless he says otherwise.

Design so far, built on the live design system (Cormorant Garamond display, Jost body, Michroma small caps, gold #c6a36d, near-black browns), then restyled toward the web app's Space view:
- Hero is an arch window drawn on canvas using the app's arch geometry: scalloped gold arch outline plus a second inner line, side pilasters with tick marks, corner lotus ornaments, a finial at the apex. Inside: a slowly rotating, twinkling star field, a large glowing flower-sun, and the seven Temples as small rotating flower-suns set along the arch, numbered I to VII.
- The seven Temple cards (arch-shaped, statues from `assets/niche-*.webp`) each have their own canvas: rotating stars and a slow flower-sun behind the statue.
- Whole page: app palette (ink #0b0604, umber #1a0f09), a fixed twinkling star field that slowly rotates, pilaster lines down both edges, faint flower-suns at the margins linked by dotted orbit lines. Reduced-motion users get a still sky.
- The founder's request, in his words: "make the homepage look more like the web app's space section. That aesthetic, those stars and flowers around the suns", and "feel free to change the code drastically as long as it looks luxury and aesthetic as fuck. You can copy the full front end of the webapp; the temple arches frame, the stars within, how they rotate."

Screenshots in `screenshots/`: 01 is the Space prototype (the target look), 02 is the old live hero, 03 to 06 are the current lab (desktop and 390px mobile).

## 4. Visual references

- The web app's Space view (served at /app/) is canvas-drawn. The full app file is deliberately not included because it carries backend logic; `app-reference/space-sky-code-extract.js` has the key drawing functions pulled out: `slFlower` (the glowing sun flower: radial glow, 32 rays, ring of dots, dashed circles, two petal rings, 16-point bright core), `grFlower` and `grPetal` (the Temple flower), `skyArch`, `skyArchPath`, `skyFrameArch`, `skyLotus`, `skyLintel` (the arch frame). Palette in the file header.
- Space prototype artifact (members' app mock, loads only inside Claude): https://claude.ai/artifact/7qfcg8oGbp5hhjEjMRLfsm
- Live bundle deploy-helper artifact (context only): https://claude.ai/artifact/RCJ5C668GXCEUzfh2bKFJ2
- The Space view itself needs a Telegram login, so the screenshot and the code are the references.

## 5. Your task

Take the homepage to the most luxurious, atmospheric version of the app's Space aesthetic you can, working from `lab-current/index.html`. You may change the code drastically (the founder said so). Ideas the founder has pointed at: temple arch frames, stars within them, rotation, flowers around suns. Things worth improving: the full-page composition (every section could sit in an arch or constellation rather than only the hero), the transition from hero to the rest, motion quality, and restraint so text stays readable.

Requirements that come from the founder:
1. Everything is reviewed on the lab first. Only changes he verifies go live.
2. The look should follow the web app's Space aesthetic: temple arch frames, stars within them, rotation, flowers around suns. It must look luxurious. Code can change drastically.
3. Use the full founder-preview copy, and the two briefs, as the content and voice source.
4. Keep /app/ and /house/ as they are (they connect to the live backend).

Engineering recommendations from us (not founder requirements; deviate if you have a better approach, and say why):
- Deliver one self-contained replacement `index.html` that works with the existing /assets files, with no external libraries (the current file works this way, which keeps Cloudflare direct upload simple).
- Keep existing links (/app/#meet as the main call to action, /house/, the section anchors and nav) so nothing breaks.
- Keep it working at 390px wide with no horizontal scroll, respect `prefers-reduced-motion`, pause canvas animation when off-screen, cap pixel density and star counts so it stays smooth on a mid-range phone.
- Keep headings in order, decorative canvases `aria-hidden`, text readable on the dark background.
- No forms that post anywhere and no tracking, so nothing can reach the live backend from the lab.
- Copy: keep the current lab wording; you may fix typos and spacing.

## 6. Open items for the founder, do not decide these yourself

- The "What information do you keep?" and "What about alcohol and substances?" answers (inside the Safeguards section) were rewritten by the preview copy and are softer than the live wording (they drop the Digital Personal Data Protection Act mention, the excise-permit commitment, and the "who wrote to whom" relay detail). Nobody has checked them against how the bot and venues really work. Keep the lab text, but flag them in your reply as unverified.
- The preview also dropped the House/Village/City explanation and the "Not a dating app" tags that live has.
- Whether the temple-photo hero should return as a section lower down (it was removed in favour of the arch sky).

## 7. What to send back

Reply with the full `index.html`, then a short list of what you changed and why, and anything you could not verify. The founder will pass it back to be put on the lab for review before anything goes live.

---
## Files uploaded with this message (flat list)

1. 1-lab-current-homepage-index.html.txt : the current lab homepage, a complete HTML file (saved with a .txt ending for upload; it is the full index.html). Return your version as a full `index.html`.
2. 2-founder-preview-full-copy.html.txt : the founder preview, source of all copy.
3. 3-live-homepage-original.html.txt : the original live homepage.
4. 4-web-app-space-sky-code.js.txt : drawing functions extracted from the web app's Space view.
5. 5-Dionysty_Brand_Foundations.docx and 6-Dionysty_Member_Selection.docx : the two briefs.
6. 7-screenshots-reference-and-current-lab.pdf : page 1 is the Space prototype (target look), page 2 the old live hero, pages 3 to 6 the current lab on desktop and a 390px phone.

Images the homepage uses (statues, friezes, ornaments) live under /assets/ on https://dionysty.pages.dev/ (for example /assets/niche-1.webp to niche-7.webp, frieze-1.webp, frieze-2.webp, statue-artists.webp, and /assets/v1/...). The HTML refers to them by those paths and they exist on the site, so you do not need copies. Keep those paths unchanged.
Where the text above says "folder" or gives a path such as `lab-current/index.html`, use the matching file in this list.
