# Dionysty homepage, round 2: match the web app's Space rendering, motion and interaction

Continue from the handover you already have (00_START_HERE and files 1 to 7). The founder's feedback on the current lab homepage (file 1): it looks similar to the web app's Space view but is below it in definition, in rotation and in interaction. The task this round is to close that gap, not to redecorate. Return a full replacement `index.html` as before. Same founder requirements and engineering notes as START_HERE, plus the one extra file in this message:

- 8-web-app-space-interaction-code.js.txt : the web app's own camera, drag, wheel and pinch handling, tap-to-fly, warp transition, layered background stars, and statue-inside-flower drawing, extracted as shipped (minified). Read it alongside file 4.

## What the app does that the lab does not (read the code, do not guess)

1. Definition. The app draws at the device's full pixel ratio, never capped (`window.devicePixelRatio`), with hairline strokes (0.5 to 1.2 px), 600 background stars of three sizes and three colours (sand, blush, a few ember), and layered glow. The lab caps pixel ratio at 1.5, draws one canvas as tall as the whole hero, and lowers flower alpha, so lines look soft and the sun reads as a smudge. Fix: use a viewport-sized canvas (sticky or fixed) at full devicePixelRatio (allow up to 3 on phones if frame time stays under 16 ms, otherwise drop one step automatically), keep the same stroke weights and glow stops as the app, and keep the Temple flowers large enough that the petal rings and dot rings are legible.
2. Rotation and depth. In the app the sky is a world 3200 by 3200 units with a camera (x, y, zoom). Background stars sit on parallax layers (p between 0.25 and 0.65), so they slide at different speeds when the camera moves. Each flower has several rings turning at different speeds and directions, breathing scale, orbiting dots. In the lab everything rotates as one rigid sheet at one speed, so it feels flat. Fix: port the camera model (`skyW2S`, world coordinates, zoom clamp 0.3 to 3), parallax layers, and the per-ring rotation, and add a very slow ambient camera drift so the sky is alive even when untouched.
3. Interaction. The app responds to drag (pan), wheel and pinch (zoom), and tap. Tapping a star flies the camera there with an ease-in-out cubic over about 750 ms; entering a village runs a 900 ms warp (stars streak outward while the camera zooms to 2.6). Lab has none of that. Fix, for the hero:
   - drag or swipe to pan the sky with a little inertia, wheel and pinch to zoom, all clamped so the arch frame and the headline never leave the screen (the frame stays fixed, the sky moves behind it);
   - the seven Temples are tappable flowers in world space. Tapping one flies the camera to it (same easing) and opens a small panel with that Temple's name and line from the existing copy and a "Come say hello" button linking to `/app/#meet`. Tapping empty sky closes it. Hover or keyboard focus brightens the flower; each Temple must also be reachable with Tab and Enter, and the same names and lines must exist as real text for screen readers and no-JS;
   - the main call to action keeps linking to `/app/#meet`; you may run the 900 ms warp before navigating, but navigation must still work if the animation fails;
   - do not break vertical page scrolling on touch: a vertical swipe that starts on the hero must still scroll the page unless the user has clearly started a horizontal or two-finger gesture. Give it a clear affordance, for example a faint "drag to explore" hint that fades after the first interaction.
4. Statues in the Temple flowers. The app draws a Temple's statue inside its flower (see the STATUES code in file 8). The homepage already has the statue images at `/assets/niche-1.webp` to `/assets/niche-7.webp` (the Artists also has `/assets/statue-artists.webp`). Use them inside the Temple flowers at a size where they can be recognised, with the app's petal-and-glow treatment around them.

## Keep from the current lab

All copy, all links, the arch frame with pilasters and lotus corners (taken from the app, see file 4), the dark palette, the Temple card section below the hero (you may give those cards the same sky treatment), reduced-motion support (still sky, no drift, no inertia), and pausing when off-screen. The hero headline and paragraph stay above the canvas and must stay readable (keep the dark text shadow or add a soft vignette behind the text).

## How to check your own work before replying

- Run the page at 390 by 844 and at 1440 by 900 in a real browser if you can, record that no horizontal scroll appears, and say what frame rate you saw.
- State which of the above you did not manage, and what you would change next. Do not claim a behaviour you did not exercise.

Return: the full `index.html`, then a short list of what changed against the three gaps (definition, rotation and depth, interaction), and anything in the app code you chose not to port and why.
