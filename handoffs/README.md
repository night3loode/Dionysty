# Handoffs

Earlier handover material, kept here so work can continue from the repo.

- `homepage-redesign/`: the homepage redesign toward the web app's Space view.
  - `00_START_HERE.md`: full context (the original handover; file numbers in it refer to the upload set, mapped below).
  - `NEXT_PROMPT_fidelity.md`: round 2 brief (definition, rotation and depth, interaction).
  - `lab-current-index.html`: the lab homepage as of that handover (file 1). It uses `/assets/niche-*.webp` and `/assets/frieze-*.webp`, already in `assets/`. Check it against what is on https://lab.dionysty.pages.dev/ before deploying; the lab may be newer.
  - `founder-preview-full-copy.html`: source of all homepage copy (file 2).
  - `web-app-space-sky-code.js`, `web-app-space-interaction-code.js`: extracts from the app's Space view (files 4 and 8).
  - File 3 (original live homepage) is the repo's root `index.html`. Files 12 to 14 (app and house code) are `app/index.html` and `house/index.html`.
- `site-briefs/six-site-briefs.md`: six earlier briefs for the public site (speed, Meet button and mobile nav, CSS cleanup, copy review, bot privacy check, public repo decision). Status as of 26 Nov 2026:
  - Line numbers refer to `index.html` at commit `386c81e` (12 Nov), which has since changed; find spots by selector.
  - Handoff 1 (move embedded images to `assets/`) is covered by PR #5 (2.6 MB to 196 KB).
  - The privacy, security and speed fixes and the Starlove broadcast work that came with these briefs are already in PR #5 and PR #6.
  - Handoffs 2 to 5 have not been checked against the current site. Handoff 6 is an owner decision; the repository is still public.
- `webapp-notes/`: how the web app works (`09_WEBAPP_OVERVIEW.md`) and its API call sites (`10_endpoint_call_sites.md`).

Not included because this repo is public: the two briefs (Brand Foundations, Member Selection) and the screenshots PDF, which shows content from the Space prototype. Keep those in private storage.
