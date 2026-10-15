# Marketing Website (apps/www)

## Purpose

Public marketing website, blog, and documentation at `simple-agent-manager.org`. Built with Astro + Starlight. This is NOT the authenticated app — see `apps/web/` for that.

## Key Files

| File | Purpose |
|------|---------|
| `astro.config.ts` | Astro/Starlight configuration, sidebar, integrations |
| `src/content/docs/` | Starlight documentation pages (MDX/MD) |
| `src/content/blog/` | Blog posts (MDX with frontmatter) |
| `src/pages/index.astro` | Landing page |
| `src/components/Hero.astro` | Homepage hero: copy, glass node floor (`@simple-agent-manager/ui/glass/node-field`), real-UI stage, pause control |
| `src/components/hero/` | Hero parts: `HeroStack` (desktop 3D stack), `HeroPhone` (mobile), `StreamingWindow` (transcript strip), `hero-motion.ts` (timeline, tilt, pause), `layers.ts` (themed layer styles) |
| `scripts/build-hero-layers.ts` | Crops the hero's real-UI layers (dark + light) from committed screenshots into `public/images/hero/` and `src/data/hero-layers.json` |
| `src/data/scenes/*.json` | One animated real-UI preview ("scene") per homepage feature section: crops, tiles, highlight rings, lights, step timings. Their order is the homepage tour order (`index.ts` validates them at load) |
| `src/components/scenes/` | `FeatureScene.astro` (renders a scene in the hero's glass language; markup is the final frame) and `scene-motion.ts` (loads layers near the viewport, plays the story once in view, rests) |
| `scripts/build-feature-scenes.ts` | Crops the scenes' layers (dark + light) into `public/images/scenes/` and `src/data/feature-scenes.json`; shares crop helpers with the hero script (`scripts/lib/real-ui-layers.ts`) |
| `src/lib/motion.ts` | Motion shared by the hero and the scenes: the page-wide pause flag behind the hero's pause control, the story budget (`MAX_STORY_MS`, `STEP_SETTLE_MS`), the timeline, and the pointer follower used for tilt |
| `src/pages/integrations/` | Integration showcase pages |
| `src/pages/presentations/` | Presentation/talk pages |
| `src/components/` | Astro/React components used in pages |
| `src/styles/` | Global styles and theme overrides |
| `src/scripts/` | Client-side scripts (analytics tracker, Mermaid) |
| `src/content/CLAUDE.md` | Content-specific instructions for content authoring |

## Commands

```bash
pnpm --filter @simple-agent-manager/www dev       # Local dev server
pnpm --filter @simple-agent-manager/www build     # Production build
pnpm --filter @simple-agent-manager/www preview   # Preview production build
pnpm --filter @simple-agent-manager/www build:hero-layers  # Rebuild hero layers after re-capturing hero screenshots
pnpm --filter @simple-agent-manager/www build:feature-scenes  # Rebuild feature scene layers after editing a scene or re-capturing its sources
```

## Conventions

- Blog posts use MDX with YAML frontmatter (`title`, `date`, `author`, `category`, `tags`, `excerpt`; optional `draft`)
- Documentation lives in `src/content/docs/` following Starlight conventions
- Assets are pre-built via `build:assets` (tracker script + blog Mermaid bundle)
- Diagrams in content use Mermaid code fences (rendered client-side via `blog-mermaid.js`)
- No authentication — this is a fully static public site

## Gotchas

- Hero layers are CSS backgrounds chosen by theme and breakpoint, so a visitor downloads one theme's set for one layout. After re-capturing `sam-hero-live-session`, `sam-hero-phone` or the crop sources (`apps/web/tests/playwright/marketing-shots-*.spec.ts`), re-run `build:hero-layers` and re-check the window geometry in the script if the captured layout moved.
- The hero's resting markup is its final frame (no JS, reduced motion); `hero-motion.ts` only animates toward it. Keep the pause control working: it must stop every hero animation (WCAG 2.2.2).
- Glass surfaces use the shared `.sam-glass*` classes from `@simple-agent-manager/ui/glass.css` (imported in `Base.astro`); buttons use `.sam-btn` in `global.css`.
- Feature scenes follow the same rules as the hero: every pixel comes from a committed capture, only timing is simulated, and the markup is the resting frame. A story's last step plus `STEP_SETTLE_MS` must end within 5 s (WCAG 2.2.2 without its own control; the loader rejects longer stories, and CSS transitions a step starts stay within `STEP_SETTLE_MS`), highlight rings must be gone by the last step, and a story rests early when its scene leaves the screen, the tab is hidden, or the hero's pause control is pressed (`src/lib/motion.ts`). Animate only opacity and transform: a moving highlight is one element per stop, not a box whose edges transition. Scene images are CSS backgrounds that load only when a scene is near the viewport; `Base.astro` has the `<noscript>` fallback.
- The visible caption under each scene is the section's existing screenshot caption (`src/data/features/<slug>.json` `details[0].screenshot.caption`); the scene JSON only adds the screen-reader description of the animation.
- Scene boxes are source pixels. After re-capturing a source screenshot, re-run `build:feature-scenes` and check the boxes still outline the same UI (look at each scene; `homepage-scenes.spec.ts` writes every resting frame to `.codex/tmp/playwright-screenshots/`). Chips float in front of the window and perspective enlarges them, so they stay within 96% of the stage width (the window within 99%); `homepage-scenes.spec.ts` measures every layer at 11 widths in the intro and at rest.

- `pnpm build:assets` runs before both `dev` and `build` — if you add new scripts, wire them there
- The analytics tracker (`scripts/build-tracker.ts`) is bundled at build time, not at runtime
- Do NOT confuse this with `apps/web/` — different stack (Astro vs React+Vite), different domain
- Starlight sidebar config lives in `astro.config.ts`, not in the content files
