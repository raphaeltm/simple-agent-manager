# Fix Blog Post Styling: Code Blocks and Tables

## Problem

Blog posts on `www.simple-agent-manager.org` have two styling issues:

1. **Code blocks are unreadable** — dark text on dark background. Expressive Code's dual-theme system uses CSS variables `--0` (dark theme) and `--1` (light theme). The blog's `Base.astro` layout lacks `data-theme="dark"` on `<html>`, so the CSS rule `:root:not([data-theme="dark"])` matches and applies light-theme colors (`--1`) — designed for white backgrounds — onto the dark blog background.

2. **Tables have no styling** — no borders, padding, or header differentiation. The `BlogPost.astro` layout has styles for headings, paragraphs, lists, blockquotes, and code blocks, but no table styles exist.

## Research Findings

- **Root cause (code blocks)**: Expressive Code generates spans with inline `--0` and `--1` CSS variables. CSS rule `color: var(--1, inherit)` wins when `:root:not([data-theme="dark"])` matches, which it does because the `<html>` tag has no `data-theme` attribute. Starlight pages are unaffected because Starlight manages its own theme attribute.
- **Root cause (tables)**: Simply missing CSS rules in the scoped `<style>` block of `BlogPost.astro`.
- **Key files**: `apps/www/src/layouts/Base.astro`, `apps/www/src/layouts/BlogPost.astro`
- **No other layouts affected**: Starlight docs use their own layout; the blog index page has no tables or code blocks.

## Implementation Checklist

- [x] Add `data-theme="dark"` to `<html>` in `Base.astro`
- [x] Add table styles (thead, th, td, hover, strong) to `BlogPost.astro`
- [x] Build www site (`pnpm --filter @simple-agent-manager/www build`)
- [x] Verify code blocks readable via Playwright
- [x] Verify tables styled via Playwright
- [x] Verify other blog posts not broken
- [x] Verify Starlight docs pages not affected

## Acceptance Criteria

- [ ] All code blocks on blog posts display with light/bright syntax highlighting colors readable on dark background
- [ ] Tables have visible header row, cell padding, row separators, and hover state
- [ ] Starlight docs pages render correctly (no theme regression)
- [ ] Site builds without errors
