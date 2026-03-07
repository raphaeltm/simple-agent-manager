# Documentation Site with Astro Starlight

## Problem

SAM needs a public-facing documentation site. Internal developer docs exist in `docs/` but aren't published. Users and self-hosters need accessible documentation for getting started, architecture understanding, and self-hosting guides.

## Approach

Add [Astro Starlight](https://starlight.astro.build/) to the existing `apps/www` Astro site. Starlight is the leading documentation framework for Astro with:

- **Built-in Pagefind search** — zero-config, static, chunked index loading, WASM-based
- **Dark mode** — matches SAM's dark theme
- **Sidebar navigation** — auto-generated or manual
- **Code highlighting** — Shiki built-in
- **Accessible** — meets WCAG standards out of the box
- **Performance** — zero client-side JS by default (except search)

Docs will live at `/docs/` on the www site, alongside the existing marketing pages and blog.

## Research Findings

- **Existing site**: `apps/www/` — Astro 5.17.3, Cloudflare Pages deployment (`sam-www`)
- **Existing content**: `docs/` has ~40 markdown files (guides, architecture, ADRs, API docs)
- **Content collections**: Blog already uses `astro:content` with glob loader
- **Deployment**: `deploy-www.yml` builds and deploys to Cloudflare Pages
- **Search choice**: Pagefind (built into Starlight) > Fuse.js/FlexSearch for static docs sites — auto-indexes at build time, chunked loading, no manual index management

## Checklist

- [ ] Install `@astrojs/starlight` in `apps/www`
- [ ] Update `astro.config.mjs` with Starlight integration
- [ ] Create docs content structure at `src/content/docs/`
  - [ ] Getting Started guide (adapted from `docs/guides/getting-started.md`)
  - [ ] Self-Hosting guide (adapted from `docs/guides/self-hosting.md`)
  - [ ] Architecture Overview (adapted from `docs/architecture/walkthrough.md`)
  - [ ] Concepts page (workspaces, nodes, providers, projects)
  - [ ] Local Development guide
- [ ] Configure sidebar navigation
- [ ] Customize Starlight theme to match SAM's dark green design
- [ ] Add "Docs" link to marketing site Header component
- [ ] Verify Pagefind search works at build time
- [ ] Run `pnpm build` successfully
- [ ] Update deploy workflow if needed

## Acceptance Criteria

- [ ] `/docs/` serves a Starlight documentation site with sidebar, search, and dark theme
- [ ] Pagefind search indexes all docs content and works client-side
- [ ] At least 5 documentation pages with real content
- [ ] Marketing site header includes a "Docs" link
- [ ] Existing marketing pages and blog continue to work
- [ ] `pnpm build` passes in `apps/www`
- [ ] Theme is visually consistent with SAM's dark green brand

## References

- Starlight docs: https://starlight.astro.build/
- Pagefind: https://pagefind.app/
- Existing site: `apps/www/`
- Internal docs: `docs/`
