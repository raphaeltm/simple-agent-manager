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

- `pnpm build:assets` runs before both `dev` and `build` — if you add new scripts, wire them there
- The analytics tracker (`scripts/build-tracker.ts`) is bundled at build time, not at runtime
- Do NOT confuse this with `apps/web/` — different stack (Astro vs React+Vite), different domain
- Starlight sidebar config lives in `astro.config.ts`, not in the content files
