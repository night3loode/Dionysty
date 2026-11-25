# DIONYSTY handoffs

Six briefs for an agent that can push to `night3loode/Dionysty`. Each stands on its own: paste **Shared context** first, then one handoff. Run them in this order, one branch and pull request each, so you can check each change before the next.

Line numbers refer to `index.html` at commit `386c81e` (12 Nov 2026). If the file has changed since, find the same spots by their selectors.

---

## Shared context (paste this before any handoff)

```
Repo: night3loode/Dionysty (branch main). The whole site is one file, index.html (~2.2 MB, 695 lines).
It is the public site for DIONYSTY, a private 18+ members' club in Delhi NCR. The site is non-explicit
(sculpture/illustration style) and sits behind an 18+ age gate. Its only call to action is a floating
"Meet" button that opens the Telegram bot @DionystyBot.

Layout of index.html:
- L13–422   one <style> block. Several redesign layers stacked on top of each other (desert treatment,
            three versions of the age gate, "deep darkness" etc.); later rules override earlier ones,
            26 uses of !important.
- L425–428  inline SVG <symbol>s: #wm (wordmark) and #mono (monogram), reused via <use>.
- L431      #gate.g2 age gate (fixed overlay; body has class "locked" until Enter is clicked).
- L449      sticky <nav> with .links (hidden under 760px) and a .navfrieze strip.
- L462      header.hero3 (hero photo + glow overlay).
- Sections: #club L480, band L496, .fifty L507, #charter L518, #safeguards L563, #temples L581,
            #membership L599, #questions L618, .close L633.
- L648–675  .fab#meet button + script: tries tg://resolve?domain=DionystyBot, falls back to
            telegram.me after 1.6 s and shows #meethelp.
- L678–693  age-gate script (sessionStorage key "dio18").
- 24 images are embedded as base64 data URIs (2.1 MB of the 2.2 MB).

Rules for all work:
- Do not change any wording, policy text, or the look of the site unless the handoff says so.
  The copy (Charter, Safeguards, privacy statements) is deliberate and legally sensitive.
- Before and after any change, screenshot the page at 390×844 and 1440×900, both behind the gate
  and after clicking Enter, and compare. Report any visual difference.
- Work on a branch, commit with descriptive messages (not "Add files via upload"), open a PR,
  and do not merge without the owner's approval.
- Never add analytics, trackers, third-party scripts or anything that sends visitor data anywhere.
```

---

## Handoff 1: Make the site load fast on mobile

```
Goal: cut the page from ~2.2 MB of HTML to a small HTML file plus separately cached images,
with no visible change.

1. Extract every base64 data URI in index.html into files under /assets/ with descriptive names
   (e.g. frieze-1.webp, frieze-2.webp, gate-butterfly.webp, gate-butterfly-glow.webp, hero.webp,
   hero-glow.webp, seal.jpg, band.jpg, niche-consent.webp … niche-autonomy.webp, sanctum.webp,
   lotus.webp, vine.webp, bg-req.webp, bg-safeguards.webp, bg-membership.webp, bg-close.webp,
   favicon.webp). Keep the original encodings and quality; do not recompress yet.
   Known image locations: L106 & L107 friezes (311 KB, 303 KB), L274–281 CSS ornaments/backgrounds,
   L433 gate butterfly + glow, L464–465 hero + glow, L490 seal, L497 band, L527–533 seven niches,
   L604 sanctum, L639 closing relief + glow, L9 favicon.
2. Deduplicate: L433 and L639 embed the same butterfly (238 KB) and the same glow (38 KB);
   L277 and L278 embed the same 8 KB background. Each should become one file referenced twice.
3. Loading: keep the gate butterfly and hero eager (add width/height attributes and
   fetchpriority="high" on the gate image). Everything below the fold gets loading="lazy"
   (most already do; the seal at L490 and the gate glow do not need to be eager).
   The two friezes are CSS backgrounds, so they still load immediately. Leave them unless you can
   defer them without changing the look.
4. Optional, separate commit: offer recompressed versions (e.g. WebP/AVIF at ~1600 px max width for
   the large reliefs) with before/after sizes and side-by-side screenshots, for the owner to approve.

Done when: index.html is under ~100 KB, total transfer for the first screen is a fraction of before,
the page looks identical at both screenshot sizes, and the PR description lists each file and its size.
```

---

## Handoff 2: Fix the Meet button and mobile navigation

```
Three functional bugs. Fix each in its own commit.

1. Meet button fallback (script at L653–675). After trying tg://, the fallback calls window.open(...)
   inside a 1.6 s setTimeout. That is no longer tied to the user's tap, so Safari (and other browsers
   with strict popup rules) is likely to block it. On iOS Safari without Telegram installed, tg:// also
   shows a "Cannot open page" alert first.
   Fix: keep the tg:// attempt and the #meethelp message, but in the fallback navigate the current tab
   with location.href = 'https://telegram.me/DionystyBot' (or t.me; the comment says some Indian
   networks break t.me, so keep telegram.me) instead of window.open. Test on iOS Safari and Android
   Chrome, with and without Telegram installed, and on desktop Chrome/Safari/Firefox. Report what
   happens in each case.

2. No navigation on phones. nav .links is display:none under 760px (L337) with no replacement,
   so mobile visitors, likely most of them, cannot jump to Charter, Safeguards, Membership or Questions.
   Add a small, accessible menu toggle in the same visual language (Michroma, sand colour, 10px tracking),
   with aria-expanded and keyboard support, closing after a link is tapped.

3. #temples (L581) is missing from the nav. Add "Temples" between Safeguards and Membership.

Done when: all three work on a real phone-sized viewport, nothing else on the page changes,
and the PR includes screenshots of the open mobile menu.
```

---

## Handoff 3: Remove dead CSS and flatten the override layers

```
Do this after Handoffs 1 and 2 are merged. No visual change allowed.

The <style> block (L13–422) is several redesigns stacked up. These selectors match nothing
in the page and can go, after you double-check each one:
  .stage .gart .iota .b18 .q .fine .yes .no .pillar .left .right .drop .yoni   (gate v1, L196–233)
  .pil .L .R .sharp .tall                                                       (gate v2/v3 leftovers)
  .card .row .btn .ghost                                                        (oldest gate, L319–328)
  .hero .bg .sub .rule .sr                                                      (old hero/utilities)
Also #gate.opening/.unveil rules that only target removed elements.

Then merge rules that set the same property on the same selector several times (e.g. .eyebrow,
.rule, #gate.g2 .gwrap, #gate.g2 .gtxt margin-top, .close background, .hero3 height) into a single
final rule each, and remove the !important flags that are only there to beat earlier layers.

Method: take reference screenshots first (390×844 and 1440×900, gated and ungated, plus the mobile
menu and an open FAQ item), make changes in small commits, and pixel-diff against the references
after each commit. Any diff means revert that commit.

Done when: the CSS is noticeably shorter, !important is used only where truly needed, and the
screenshots match.
```

---

## Handoff 4: Check the site's claims against what it shows (copy review; report only)

```
Report only. Do not edit text; the owner decides on wording.

The Safeguards section (L575) says: "This website shows sculpture and illustration, nothing explicit
appears before you confirm you are 18." The hero (L464, alt "A woman in an ornate headpiece and
choker, draped in dark satin…") and the band image (L497, alt "Three people embracing among red
silk…") appear to be photographs, not sculpture or illustration.

1. Look at every image and say whether the sentence is accurate. If not, propose either a wording
   change or an image swap.
2. Confirm nothing behind the gate is visible before Enter is clicked, including with JavaScript
   disabled, on slow connections while the page is loading, and in link previews (check whether
   Open Graph tags exist; there are none now, which is probably right for this site).
3. List any other statement on the page that depends on how the Telegram bot behaves
   (see Handoff 5) so it can be checked there.

Deliver: a short written report with screenshots, no code changes.
```

---

## Handoff 5: Check the bot against the site's privacy promises (needs the bot's repository)

```
The site makes specific promises about @DionystyBot. Find the bot's code and confirm each one is true,
citing file:line for each verdict (TRUE / FALSE / PARTLY / CAN'T TELL). Do not change behaviour
without approval; report first.

From #safeguards "Your information" (L576), #membership (L608–612) and #questions (L625):
 1. Stored per person: alias, Telegram handle and account number, optional Reddit handle,
    gender (woman/man/non-binary), how they'd come (solo/with someone), temples, personal code,
    who vouched, booked call time, application status, the two short answers, and messages
    they send to the team. Nothing else.
 2. Never stored or asked for: sexual preferences, orientation, health details, ID numbers.
    ID checks record only that the check happened.
 3. Voting: members see alias, temples, the two answers, how they'd come and voucher, never the
    Telegram account or messages. Only totals are shared, never who voted how.
    Rule: more yes than no, with most members taking part; a vouch counts as that member's yes.
 4. Member-to-member messages are relayed by alias; contents are not stored, only who wrote to whom,
    unless a message is reported.
 5. Data is deleted if not admitted, on leaving, or on request; /forget deletes everything
    (check backups, logs, and copies in any channel or admin chat too).
 6. Everything is kept in "one protected account". Say where it actually lives and who can access it.
 7. Men join only with a member's vouch; women, non-binary people and couples can say hello directly.
 8. No one is added to any channel without their yes.

Also flag: secrets in the repo, logging of message contents, admin commands without access checks,
and anything that would conflict with India's DPDP Act as the site describes it.
```

---

## Handoff 6: Decide whether the repository should be public (owner decision)

This one is for you, not the agent. `night3loode/Dionysty` is public, so anyone can see the whole site source, every image at full size and the edit history on GitHub, gate or not. `noindex` only keeps the site out of search results. That sits awkwardly with a club built on discretion.

Your options:
- **Make the repository private and host it on GitHub Pages.** Private Pages needs a paid GitHub plan; the site itself stays public.
- **Make it private and host it on Cloudflare Pages or Netlify.** Both deploy free from a private repository.
- **Leave it public** as a deliberate choice.

If you go private, check where the site is hosted now first. The repository has no `CNAME` file, so it may not be served from GitHub Pages at all.
