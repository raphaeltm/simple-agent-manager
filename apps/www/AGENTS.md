# Marketing Website (apps/www)

## Purpose

Public marketing website, blog, and documentation at `simple-agent-manager.org`. Built with Astro + Starlight. This is NOT the authenticated app — see `apps/web/` for that.

## Key Files

| File | Purpose |
|------|---------|
| `astro.config.ts` | Astro/Starlight configuration, sidebar, integrations |
| `src/content/docs/` | Starlight documentation pages (MDX/MD) |
| `src/content/blog/` | Blog posts (Markdown with frontmatter) |
| `src/pages/index.astro` | Landing page |
| `src/components/factory/` | Homepage (`FactoryHome.astro`): hero, "the floor" (infrastructure over the glass node floor), the six-stage "how work moves" line with its sticky rail, roles, questions and CTA. `Shot.astro` renders one real SAM screen in the active theme and loads it near the viewport |
| `src/data/factory-shots.ts`, `src/data/factory-stages.ts` | The homepage's real screens (sizes, alt text) and its stages (copy, highlight rings). `SINGLE_VM_INSTALL_SHIPPED` labels the single-VM control plane "soon" until it ships |
| `public/images/factory/README.md` | How each homepage screen was captured and cropped (dark + light, desktop + phone) |
| `src/lib/motion.ts` | Motion helpers shared by the brand guide: reduced-motion and fine-pointer queries, and the pointer follower used for tilt |
| `src/pages/brand/index.astro` | Brand and style guide (`/brand/`). Published but not launched: `noindex`, excluded from the sitemap in `astro.config.ts`, linked from nowhere |
| `src/components/brand/` | Brand guide sections, the `Lockup` component and `brand-motion.ts` (reveals, scroll progress `--p`, the pinned colour track, copy buttons) |
| `src/data/brand-content.json`, `src/data/brand.ts` | Brand guide content (palette, type scale, easings, copy examples, glossary) and its load-time validation and colour helpers. Token-backed swatches are checked against the CSS by `tests/brand-guide.test.ts` |
| `scripts/build-brand-lockups.ts` | Renders the downloadable lockup PNGs in `public/images/brand/` with Chillax embedded; fails if the font does not load |
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
pnpm --filter @simple-agent-manager/www compress:screenshots public/images/blog/<slug>  # Palette-compress committed docs/blog screenshots
```

## Conventions

- Blog posts are Markdown (`.md`; the collection does not load `.mdx`) with YAML frontmatter (`title`, `date`, `author`, `category`, `tags`, `excerpt`; optional `draft` and `socialImage`). Posts about UI embed renders of the real app from `public/images/blog/<slug>/`; see "UI Renders" in `src/content/CLAUDE.md`
- Code blocks in docs and blog are rendered by Expressive Code: plugins (line numbers, language tab) in `src/lib/expressive-code.ts`, registered in `astro.config.ts`. Blog pages give it Starlight's theme variables in `src/styles/blog-code.css`
- Documentation lives in `src/content/docs/` following Starlight conventions
- Assets are pre-built via `build:assets` (tracker script + blog Mermaid bundle)
- Diagrams in content use Mermaid code fences (rendered client-side via `blog-mermaid.js`)
- No authentication — this is a fully static public site

## Gotchas

- Glass surfaces use the shared `.sam-glass*` classes from `@simple-agent-manager/ui/glass.css` (imported in `Base.astro`); buttons use `.sam-btn` in `global.css`.
- Write or change homepage copy with the SAM skills `homepage-copy` (lead with the visitor's need, verify every claim in code or docs) and `humanizer` (remove AI-writing tells).

- Astro caches rendered Markdown, including each code block's `<link>` to the hashed `ec.*.css`, in `node_modules/.astro/data-store.json`. After changing Expressive Code settings, delete that file before building or previewing, or code blocks link a stylesheet that no longer exists and render unstyled. CI builds start clean.
- Brand guide motion: markup is the final frame, `html.bg-motion` (set only when motion is allowed) gates every hidden or scroll-linked state, and nothing plays on its own for more than 5 s. A `data-reveal="wipe"` element starts clipped to nothing, so it uses its own threshold-0 observer; IntersectionObserver measures the clipped box. When a brand colour, font or rule changes, update `src/data/brand.ts` and the guide in the same PR.
- `pnpm build:assets` runs before both `dev` and `build` — if you add new scripts, wire them there
- The analytics tracker (`scripts/build-tracker.ts`) is bundled at build time, not at runtime
- Do NOT confuse this with `apps/web/` — different stack (Astro vs React+Vite), different domain
- Starlight sidebar config lives in `astro.config.ts`, not in the content files
