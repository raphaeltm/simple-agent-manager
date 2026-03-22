# Replace SVG Logo/Icon with PNG Favicon

## Problem

The app uses an inline SVG logo in the www header and plain "SAM" text in the web app navbar. The user wants to use the PNG backpack favicon icon (already in `apps/web/public/favicon.png` and `apps/www/public/favicon.png`) consistently everywhere instead.

## Research Findings

### Current State

1. **`apps/web/src/components/AppShell.tsx`** — Shows plain text "SAM" in both mobile header (line 91-92) and desktop sidebar (line 142). No logo image at all.
2. **`apps/www/src/components/Header.astro`** — Uses inline SVG (32x32, terminal prompt icon) next to "SAM" text (lines 17-23).
3. **`apps/www/astro.config.mjs`** — Starlight docs config references `./src/assets/logo.svg` for the docs site logo (line 16).
4. **`apps/web/public/icons/icon.svg`** — SVG icon file exists but is not directly referenced in app code.

### Target PNG

- `apps/web/public/favicon.png` — Backpack with terminal screen, used as web app favicon
- `apps/www/public/favicon.png` — Same image, used as www favicon
- Both are the correct icon to use everywhere

## Implementation Checklist

- [ ] **Web app navbar (AppShell.tsx)**: Replace "SAM" text with `<img src="/favicon.png">` in both mobile header and desktop sidebar
- [ ] **WWW header (Header.astro)**: Replace inline SVG with `<img src="/favicon.png">`
- [ ] **Starlight docs config (astro.config.mjs)**: Change logo from `./src/assets/logo.svg` to PNG version (copy favicon.png to `src/assets/logo.png`)
- [ ] **Cleanup**: Remove `apps/www/src/assets/logo.svg` (no longer referenced) and `apps/web/public/icons/icon.svg` (unused)
- [ ] **Tests**: Run existing tests to ensure no regressions

## Acceptance Criteria

- [ ] Web app navbar shows the backpack PNG icon instead of "SAM" text (mobile + desktop)
- [ ] WWW site header shows the backpack PNG icon instead of inline SVG
- [ ] Starlight docs site shows the backpack PNG icon
- [ ] No broken images or layout issues
- [ ] Existing tests pass
