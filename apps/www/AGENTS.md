# Marketing Website (apps/www)

## Purpose

Public marketing website, blog, and documentation at `simple-agent-manager.org`. Built with Astro + Starlight. This is NOT the authenticated app — see `apps/web/` for that.

## Key Files

| File                       | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `astro.config.ts`          | Astro/Starlight configuration, sidebar, integrations |
| `src/content/docs/`        | Starlight documentation pages (MDX/MD)               |
| `src/content/blog/`        | Blog posts (MDX with frontmatter)                    |
| `src/pages/index.astro`    | Landing page                                         |
| `src/pages/integrations/`  | Integration showcase pages                           |
| `src/pages/presentations/` | Presentation/talk pages                              |
| `src/components/`          | Astro/React components used in pages                 |
| `src/styles/`              | Global styles and theme overrides                    |
| `src/scripts/`             | Client-side scripts (analytics tracker, Mermaid)     |
| `src/content/CLAUDE.md`    | Content-specific instructions for content authoring  |

## Commands

```bash
pnpm --filter @simple-agent-manager/www dev       # Local dev server
pnpm --filter @simple-agent-manager/www build     # Production build
pnpm --filter @simple-agent-manager/www preview   # Preview production build
```

## Conventions

- Blog posts use MDX with YAML frontmatter (`title`, `date`, `description`, `author`)
- Documentation lives in `src/content/docs/` following Starlight conventions
- Assets are pre-built via `build:assets` (tracker script + blog Mermaid bundle)
- Diagrams in content use Mermaid code fences (rendered client-side via `blog-mermaid.js`)
- No authentication — this is a fully static public site

## Gotchas

- `pnpm build:assets` runs before both `dev` and `build` — if you add new scripts, wire them there
- The analytics tracker (`scripts/build-tracker.ts`) is bundled at build time, not at runtime
- Do NOT confuse this with `apps/web/` — different stack (Astro vs React+Vite), different domain
- Starlight sidebar config lives in `astro.config.ts`, not in the content files
- Astro 7's rolldown pipeline resolves dynamic imports inside **processed** `<script>` blocks. A
  `<script type="module">` that lazy-loads a `build:blog-mermaid` output by URL (e.g.
  `import('/scripts/blog-mermaid.js')` in `src/layouts/BlogPost.astro`) must be marked `is:inline`,
  or the build fails with `[UNRESOLVED_IMPORT] Could not resolve '/scripts/...'` — those files are
  emitted into `public/` at build time and are runtime URLs, not bundleable modules
- `@astrojs/starlight` and `astro` majors move together: Starlight declares a hard `astro` peer
  range, so a Starlight major bump generally requires the matching Astro major in the same change
