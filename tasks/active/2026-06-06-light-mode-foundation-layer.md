# Light Mode Foundation Layer (Phase 0)

**Status:** ready for draft PR
**Branch:** sam/implement-foundation-layer-light-01kten
**Date:** 2026-06-06

## Problem Statement

The SAM control-plane app (`apps/web`) is dark-only. We are adding light mode in a
multi-agent effort. This task builds the FOUNDATION layer (Phase 0) that downstream
agents branch from: an additive light token layer, glass re-tuning, body/form
tokenization, and a runtime theme switcher. This task does NOT convert page
components beyond proving the system works end-to-end.

### PRIME DIRECTIVE — Zero Dark-Mode Delta
Dark mode is default and must remain pixel-for-pixel identical. Every light value is
ADDITIVE behind the new `[data-ui-theme='sam-light']` selector. Any hardcoded literal
converted to a token MUST keep its dark value byte-for-byte identical.

## Research Findings

- **`packages/ui/src/tokens/theme.css`** (source of truth): `:root` holds dark
  `--sam-color-*` tokens. Glass backgrounds already exist as CSS vars
  (`--sam-glass-bg-chrome/surface/modal`, `--sam-glass-border-color`,
  `--sam-glass-glow-color`, `--sam-glass-backdrop-dim`). Theme selector at
  `[data-ui-theme='sam']` sets color+bg. Shadows are dark-tuned (lines ~124-133).
  Tokyo Night (`--sam-color-tn-*`) must stay dark in both themes.
- **`apps/web/src/app.css`**: Tailwind v4 `@theme` maps `--color-*`/`--shadow-*`/
  `--blur-*` to `var(--sam-*)`. `@custom-variant dark` is bound to
  `[data-ui-theme="sam"]`, so `dark:` utilities correctly stop matching in light
  mode AND light token overrides flow automatically through the `@theme` var refs.
- **`apps/web/src/index.css`**: Has hardcoded literals that need tokenizing:
  - Body radial gradients (lines ~55-61): `rgba(16,185,129,.15)`, `rgba(34,197,94,.10)`, `rgba(6,78,59,.12)`.
  - Form elements (lines ~64-115): `rgba(8,15,12,.5)` bg, `rgba(34,197,94,.10/.18/.35)` borders, focus box-shadows.
  - Nested-glass override (line ~195): `rgba(8,15,12,.5)`.
  - `@media prefers-reduced-transparency`, `@media prefers-contrast`,
    `@supports not(backdrop-filter)` fallbacks: `rgb(8,15,12)`, `rgb(13,24,20)`, `rgb(0,0,0)`.
  - Glass message bubbles (lines ~337-384): `.glass-msg-user` / `.glass-msg-assistant`.
- **`apps/web/src/main.tsx`** (line ~14): hardcodes
  `setAttribute('data-ui-theme', 'sam')` — replace with localStorage-aware init.
- **`apps/web/src/components/UserMenu.tsx`**: dropdown via `createPortal`; add
  sun/moon toggle between user-info block and Sign out button.
- **`apps/web/src/App.tsx`**: provider nesting
  `ErrorBoundary > AuthProvider > ToastProvider > GlobalAudioProvider > BrowserRouter`.
  Wrap ThemeProvider near the top.
- **`packages/ui/src/tokens/semantic-tokens.ts`**: CONFIRMED DEAD — zero runtime
  consumers in apps/web (grep shows only self-refs + barrel re-export). DELETE per
  rule 01 (no legacy/dead code) and remove barrel export in `packages/ui/src/index.ts`.

## Implementation Checklist

- [x] Add `[data-ui-theme='sam-light']` (+ `*` descendant) block in theme.css:
      override every semantic `--sam-color-*` with warm greenish-white light values,
      light glass vars, softer light shadows. Do NOT override `--sam-color-tn-*`.
- [x] Convert hardcoded glass rgb() fallbacks in index.css to new `--sam-glass-*`
      fallback vars (dark = exact current literals), add light values.
- [x] Tokenize body gradients into `--sam-*` vars (dark = current literals) + light.
- [x] Tokenize form bg/border/focus into `--sam-*` vars (dark = current) + light.
- [x] Add light `.glass-msg-user` / `.glass-msg-assistant` variants.
- [x] Build ThemeProvider (React context) + useTheme hook. State 'dark'|'light',
      default dark, persist localStorage key 'sam-theme', apply attribute on <html>.
- [x] Pre-paint init in main.tsx: read localStorage, fall back to dark, before render.
- [x] Add sun/moon toggle in UserMenu wired through useTheme.
- [x] Delete semantic-tokens.ts + remove barrel export line.
- [x] Behavioral test: render toggle, click, assert attribute + localStorage flip.
- [x] Playwright visual audit: dark+light @ 375px & 1280px; dark parity before/after;
      assert no horizontal overflow. Save to `.codex/tmp/playwright-screenshots/`.

## Acceptance Criteria

- [x] Dark mode is byte-for-byte unchanged (visual parity screenshots match).
- [x] `[data-ui-theme='sam-light']` overrides all semantic colors + glass + shadows.
- [x] Tokyo Night palette stays dark in both themes.
- [x] Theme toggle in UserMenu switches themes and persists across reload.
- [x] No FOUC: correct theme applied before first paint.
- [x] WCAG AA: light body text ≥4.5:1, large/UI ≥3:1.
- [x] semantic-tokens.ts removed; no dangling imports.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all green.
- [x] No horizontal overflow at mobile/desktop in either theme.

## Continuation Notes

- Rebased this branch onto `origin/main` on 2026-06-06 after Claude usage exhausted,
  so the draft PR no longer includes reversions of newer mainline work.
- The remaining unchecked item is the current-session validation rerun; previous
  commits already include unit and Playwright audit coverage.

## Delivery Constraints

- Execute via `/do`. DRAFT PR only. DO NOT MERGE. DO NOT deploy to staging
  (orchestrator integrates all phases then handles merge/staging).
- Branch is the FOUNDATION other agents branch from — keep clean, push early,
  token/switcher API stable + well-named.

## References

- `.claude/rules/01-doc-sync.md` (no dead code), `17-ui-visual-testing.md`,
  `16-no-page-reload-on-mutation.md`, `03-constitution.md` (no hardcoded values).
- `packages/ui/src/tokens/theme.css`, `apps/web/src/{index,app}.css`, `main.tsx`.
