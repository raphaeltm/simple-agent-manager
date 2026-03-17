# Fix Light Mode in Docs (www)

## Problem

The Starlight docs site at `apps/www/` has broken light mode. When users toggle to light theme in the docs, colors don't switch properly because:

1. **`starlight-custom.css`** overrides Starlight's color variables in `:root` (dark mode) but provides no `[data-theme='light']` overrides — so in light mode, either SAM's dark brand colors persist or Starlight's default (blue) accent colors take over instead of SAM's green brand
2. **`.expressive-code` border** uses `--sl-color-gray-4` which points to a dark color in `:root` without light mode mapping
3. **Code block theme** — the `markdown.shikiConfig.theme: 'night-owl'` in `astro.config.mjs` forces a dark-only code theme for non-Starlight pages (blog)

## Research Findings

### Starlight Theming Mechanism
- Starlight uses `[data-theme='light']` and `[data-theme='dark']` selectors on `<html>`
- Default props are in `node_modules/@astrojs/starlight/style/props.css`
- Dark mode defaults are in `:root`, light overrides in `:root[data-theme='light']`
- Custom CSS loaded via `customCss` in `astro.config.mjs` can override both

### Key Variables to Override
- `--sl-color-accent-low`, `--sl-color-accent`, `--sl-color-accent-high` — SAM green brand
- `--sl-color-white` through `--sl-color-black` — gray scale for SAM brand
- `.expressive-code` border color

### Files to Modify
- `apps/www/src/styles/starlight-custom.css` — add `[data-theme='light']` block
- `apps/www/astro.config.mjs` — possibly add dual shiki themes for blog pages

## Implementation Checklist

- [ ] Use Playwright to screenshot current light mode state and identify all issues
- [ ] Add `[data-theme='light']` overrides in `starlight-custom.css` with SAM-branded light colors
- [ ] Fix `.expressive-code` border for light mode
- [ ] Verify code blocks render correctly in light mode
- [ ] Use Playwright to verify all fixes across multiple docs pages
- [ ] Verify dark mode still works correctly after changes

## Acceptance Criteria

- [ ] Starlight docs pages render correctly in light mode with SAM brand green accents
- [ ] Text is readable (dark text on light background)
- [ ] Code blocks have appropriate light-mode styling
- [ ] Navigation, sidebar, and search look correct in light mode
- [ ] Dark mode continues to work as before (no regressions)
- [ ] Playwright screenshots confirm visual correctness in both modes
