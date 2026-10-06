# Discoverable Three-Way Theme Switcher (Dark / Light / System)

**SAM Task ID:** 01KTGR36MXMN0NV0H5VED4ZCGP
**Branch:** sam/implement-discoverable-three-way-01ktgr

## Problem Statement

Light mode shipped in PR #1239. Theming works (token layer, persistence under
localStorage `sam-theme`, pre-paint FOUC prevention in `main.tsx`), but the only
way to change the theme is the binary `toggleTheme` button inside `UserMenu`,
which renders **only** in the standalone workspace header — never in the main app
shell.

Consequences:
- **Mobile users have no theme control at all.** `MobileNavDrawer` (the primary
  mobile nav surface) has no switcher. This violates rule 26 (project-chat-first):
  the primary surface lacks a core control.
- **Desktop sidebar footer** (`AppShell`) shows only avatar + sign-out — no theme
  control.
- There is **no "System" (follow-OS) option** at all; the model is binary
  (`dark`/`light`).

## Goals

1. **Three-way theme model** in `ThemeContext`: `theme: 'dark' | 'light' | 'system'`,
   persisted in `sam-theme`. Default (and unset/unknown) = `'system'` (intentional
   change from current `'dark'` default). When `'system'`, resolve effective theme
   via `window.matchMedia('(prefers-color-scheme: dark)')` and **subscribe to its
   `change` event** for live OS-theme updates (no reload). Keep `data-ui-theme`
   mapping (effective dark → `sam`, effective light → `sam-light`). Backwards
   compat: stored `'dark'`/`'light'` keep working; only absent/invalid → `'system'`.
2. **Pre-paint FOUC script** in `main.tsx` handles `'system'` by reading the media
   query inline and applying the correct `data-ui-theme` before first paint.
3. **ONE shared switcher component** used in `MobileNavDrawer`, `AppShell` desktop
   footer, and `UserMenu` (replace binary toggle). No duplicated logic (rule 24).
   Explicit 3-option segmented control (Dark | Light | System) with icons
   (sun/moon/monitor) + labels so "System" is discoverable.
4. **UX/a11y/contrast:** touch targets ≥44px; `role="group"` + `aria-pressed`
   semantics; full keyboard operability; WCAG AA contrast in BOTH themes; existing
   design tokens only (no hardcoded colors).

## Research Findings

- **`apps/web/src/contexts/ThemeContext.tsx`** — current binary impl. `Theme =
  'dark'|'light'`, `DEFAULT_THEME='dark'`, `THEME_ATTRIBUTE` map, `readStoredTheme()`,
  `applyThemeAttribute()`, `ThemeProvider` (useState + useEffect to apply+persist),
  `toggleTheme`/`setTheme`. → Must become three-way with matchMedia resolution.
- **`apps/web/src/main.tsx:17`** — `applyThemeAttribute(readStoredTheme())` runs
  pre-paint. Both `readStoredTheme` and the attribute application must handle
  `'system'` (resolve via matchMedia) so first paint is correct.
- **`apps/web/src/components/UserMenu.tsx:21,137-176`** — uses `{ isDark, toggleTheme }`
  and renders a binary toggle button with inline sun/moon SVG. → Replace with shared
  switcher. Keep dropdown-portal layout.
- **`apps/web/src/components/MobileNavDrawer.tsx:314-323`** — sign-out section at
  bottom. Add switcher above/near it. Component is presentational (props only);
  currently has no theme awareness — switcher will be self-contained (uses
  `useTheme` internally) so no new props needed.
- **`apps/web/src/components/AppShell.tsx:264-282`** — desktop sidebar footer
  (avatar + sign-out). Add switcher here. Already imports `Monitor` from lucide.
  Mobile path renders `MobileNavDrawer` (207-222) with no theme props (good — switcher
  self-contained).
- **Segmented-control pattern:** `apps/web/src/pages/admin-analytics/PeriodSelector.tsx`
  — `role="group"`, `aria-pressed`, `min-h-[44px] min-w-[44px]`,
  `focus-visible:ring-2 focus-visible:ring-focus-ring ring-offset-bg-canvas`, active
  `bg-accent text-fg-on-accent border-accent`, inactive `border-border-default
  text-fg-secondary hover:bg-surface-secondary`. These tokens are theme-aware
  (proven in production both themes). Follow this idiom.
- **Tests:** `tests/unit/ThemeContext.test.tsx` (default dark, persisted light,
  toggle, setTheme, throws, consumer toggle) and `tests/unit/components/user-menu.test.tsx`
  (line 73 asserts `'Switch to light theme'` button) **will break** and must be
  rewritten. `tests/playwright/theme-foundation-audit.spec.ts` + `audit-helpers.ts`
  (`seedTheme`, `expectTheme` support only `dark`/`light`) — extend for `system`.
- **lucide-react** has `Sun`, `Moon`, `Monitor`.

## Implementation Checklist

### Theme model
- [ ] `Theme = 'dark' | 'light' | 'system'`; `DEFAULT_THEME = 'system'`.
- [ ] `readStoredTheme()` returns stored `dark`/`light`/`system`; absent/invalid → `'system'`.
- [ ] Add `resolveEffectiveTheme(theme)` → `'dark'|'light'` (system uses matchMedia).
- [ ] `applyThemeAttribute(theme)` applies the **resolved** `data-ui-theme`.
- [ ] `ThemeProvider`: subscribe to matchMedia `change` while `theme==='system'`;
      re-apply attribute on change; clean up listener. Persist + apply on `setTheme`.
- [ ] Context value: `theme`, `setTheme(theme)`, `isDark` (resolved), `resolvedTheme`.
      Drop `toggleTheme` (no longer used) — remove dead code.

### Pre-paint
- [ ] `main.tsx` pre-paint applies resolved attribute for all three settings,
      reading matchMedia inline for `'system'`.

### Shared component
- [ ] New `apps/web/src/components/ThemeSwitcher.tsx` — segmented control
      (Dark|Light|System) using `useTheme`, icons Sun/Moon/Monitor, `role="group"`,
      `aria-pressed`, ≥44px targets, focus ring, theme tokens. Accept a `compact?`
      or `className?` prop for layout flexibility across surfaces if needed.

### Wiring
- [ ] `UserMenu` — replace binary toggle (137-176) with `<ThemeSwitcher />`; drop
      `isDark`/`toggleTheme` usage.
- [ ] `MobileNavDrawer` — render `<ThemeSwitcher />` near sign-out (314-323).
- [ ] `AppShell` desktop footer (264-282) — render `<ThemeSwitcher />`.

### Tests
- [ ] Rewrite `ThemeContext.test.tsx`: default `system`; `system` resolves via
      mocked matchMedia; live reaction to simulated media `change`; `setTheme`
      persists + updates `data-ui-theme`; legacy `dark`/`light` still work; unset →
      `system`; throws outside provider.
- [ ] New `ThemeSwitcher.test.tsx`: render + click each option, assert
      `data-ui-theme`/`localStorage`/`aria-pressed` (behavioral, not source-contract).
- [ ] Update `user-menu.test.tsx` for the new switcher.
- [ ] Extend `audit-helpers.ts` `seedTheme`/`expectTheme` to accept `system`
      (with a matchMedia override for deterministic resolution).
- [ ] Playwright visual audit: all three states × mobile (375x667) + desktop
      (1280x800) on primary surfaces (dashboard/project list, project chat, mobile
      drawer OPEN). Assert no horizontal overflow. Verify switcher present + functional.

## Acceptance Criteria

- [ ] `theme` model is three-way; default + unset/invalid resolve to `system`.
- [ ] `system` resolves via matchMedia and updates live on OS theme change (no reload).
- [ ] Legacy stored `dark`/`light` continue to work.
- [ ] No FOUC for any of the three settings (pre-paint applies resolved attribute).
- [ ] One shared `ThemeSwitcher` used in MobileNavDrawer, AppShell desktop footer,
      and UserMenu — no duplicated switching logic.
- [ ] Switcher: ≥44px targets, `aria-pressed`, keyboard-operable, AA contrast both
      themes, design tokens only.
- [ ] Mobile users can change theme from the mobile nav drawer.
- [ ] Behavioral tests cover the matrix above; Playwright audits pass with no overflow.

## References
- Rules: 17 (visual testing), 24 (no duplicate controls), 26 (project-chat-first),
  02 (no source-contract tests), 03 (no hardcoded values).
- PR #1239 (light mode foundation).
