# Brand and style guide on the marketing site

## Problem

The website had no brand or style guide. Brand decisions (mascot-forward identity, SAM Green
#16a34a, Chillax for the "SAM / Simple Agent Manager" lockup, the retired play-arrow mark, no em
dashes, plain-language writing) lived only in agent memory, scattered CSS and the SAM Glass guide.
Raphaël asked for one on the site, unlinked for now, "Awwwards quality" with sliding and layered
motion, shipped without waiting for review.

## Research findings

- No existing guide: `apps/www/src/pages/` has no brand/style route; no docs page covers it.
- Tokens live in `packages/ui/src/brand/brand.css` (site palette, type) and
  `packages/ui/src/glass/glass.css` + `tokens/sam-glass.css` (glass, void, people colours).
- Mascot colours sampled from `public/images/sam-head.png`; app icon tile #004222 from `public/favicon.png`.
- Existing easings: glide `cubic-bezier(0.2, 0.8, 0.2, 1)`, settle `cubic-bezier(0.32, 0.72, 0, 1)`.
- Hero motion rules (WCAG 2.2.2, final-frame markup, reduced motion) in `apps/www/AGENTS.md`.
- No dark-background lockup file existed (`logo.png` has a dark sub-line).

## Implementation checklist

- [x] `/brand/` page: hero, contents, 10 sections (essence, logo, colour, type, glass, motion, interface, voice, imagery, assets)
- [x] Palette data with token parity test against the CSS
- [x] Motion: word-mask reveals, scroll-linked parallax, pinned horizontal colour track, stacked principle cards, exploded glass stack, easing race
- [x] Reduced motion and no-JS render the final frame; nothing auto-plays longer than 5 s
- [x] Unlinked: `noindex`, excluded from sitemap, no nav/footer link
- [x] Downloadable lockups rendered in Chillax (`scripts/build-brand-lockups.ts`)
- [x] Unit + Playwright tests (axe, overflow, reveals, pin track, keyboard focus, copy, toggles) at 1280 and 375
- [x] `apps/www/AGENTS.md` updated

## Acceptance criteria

- [x] `/brand/` builds and renders on desktop and mobile with no overflow and no serious axe violations
- [x] Not linked from anywhere and not indexed
- [ ] Deployed and verified on staging, then production
