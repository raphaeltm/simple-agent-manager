# Light Mode — Slice C: Workspace & Node Detail

**Task ID:** 01KTESCH4800XEY9TBERBZ6FPK
**Branch:** `sam/light-mode-slice-c-01ktes`
**Delivery:** DRAFT PR only — DO NOT MERGE, DO NOT deploy to staging.

## Problem Statement

The SAM control-plane app (`apps/web`) is being made light-mode-aware across 5 parallel
slices. Slice C owns the **workspace & node-detail** chrome. Hardcoded color literals in
this scope render correctly only because the app has been dark-only; under the new
`[data-ui-theme='sam-light']` foundation (Phase 0) they either (a) stay dark on a now-light
surface, hurting contrast, or (b) flip to light tokens inside a forced-dark "island",
becoming invisible. Convert chrome literals to the theme-aware Phase-0 tokens.

## Prime Directive — ZERO DARK-MODE DELTA

A literal may only be replaced with a token if that token's **dark** (`:root`) value equals
the literal **byte-for-byte**. Dark mode must stay pixel-identical. Tokyo Night
(`--sam-color-tn-*`) and terminal/diff/code/log content stay INTENTIONALLY DARK in both
themes — convert only the chrome around them; never add light overrides for dark islands.

## Research Findings

Token parity reference (`packages/ui/src/tokens/theme.css`):
- `--sam-color-success` dark `#22c55e` (light `#15803d`)
- `--sam-color-warning` dark `#f59e0b` (light `#b45309`)
- `--sam-color-danger`  dark `#ef4444` (light `#dc2626`)
- `--sam-form-border`   dark `rgba(34,197,94,0.1)` (light `rgba(22,163,74,0.2)`)
- `--sam-form-bg`       dark `rgba(8,15,12,0.5)` (light `rgba(255,255,255,0.7)`)
- `--sam-color-fg-primary` dark `#e6f2ee` (light `#11271d`) — flips
- `--sam-color-fg-muted`   dark `#9fb7ae` (light `#4a5d54`) — flips
- `--sam-color-fg-disabled` is **undefined** → `var(...,#6b7280)` is `#6b7280` in BOTH themes (safe).
- No `[data-ui-theme='sam-dark']` re-assertion block exists, so a forced-dark island that
  uses theme-aware fg tokens must pin those vars locally to keep inner text bright in light.

Key surfaces:
- `Section` uses `bg-surface` → node-detail cards turn light. Status TEXT colors on them
  need semantic tokens for AA contrast (and dark values match exactly).
- The Logs panel (`backgroundColor: var(--sam-color-bg-primary, #0d1117)`) is a forced-dark
  island (bg-primary undefined → always `#0d1117`). `LogEntry` inside it uses
  `text-fg-primary`/`text-fg-muted`, which flip to dark in light mode → invisible log text.
  Fix by pinning `--sam-color-fg-primary`/`--sam-color-fg-muted` to their dark values on the
  panel container (zero dark delta; `LogEntry` needs no edits).

No `dark:` utilities and no Tailwind default-palette utilities (`text-red-500`, etc.) exist
in scope — only hex/rgba literals.

## Implementation Checklist

### Convert (dark byte-for-byte exact)
- [ ] `components/node/LogsSection.tsx` L97 `'#22c55e'` → `var(--sam-color-success)` (LIVE text)
- [ ] `components/node/LogsSection.tsx` L105 `'#22c55e'` → `var(--sam-color-success)` (LIVE dot)
- [ ] `components/node/LogsSection.tsx` L115 `border-[rgba(34,197,94,0.10)] bg-[rgba(8,15,12,0.5)]` → `border-[var(--sam-form-border)] bg-[var(--sam-form-bg)]` (pause btn)
- [ ] `components/node/LogsSection.tsx` L124 same (refresh btn)
- [ ] `components/node/LogsSection.tsx` L148 `var(--sam-color-fg-danger, #ef4444)` → `var(--sam-color-danger)`
- [ ] `components/node/LogsSection.tsx` L173 log-panel container: pin `--sam-color-fg-primary:#e6f2ee` & `--sam-color-fg-muted:#9fb7ae` (dark-island self-containment)
- [ ] `components/node/DockerSection.tsx` L17 `'#22c55e'` → `var(--sam-color-success)`
- [ ] `components/node/DockerSection.tsx` L21 `'#f59e0b'` → `var(--sam-color-warning)`
- [ ] `components/node/DockerSection.tsx` L25 `'#ef4444'` → `var(--sam-color-danger)`
- [ ] `components/node/DockerSection.tsx` L56 `var(--sam-color-fg-danger, #ef4444)` → `var(--sam-color-danger)`
- [ ] `pages/workspace/index.tsx` L397 `border-[rgba(34,197,94,0.10)]` → `border-[var(--sam-form-border)]` (mobile drawer)
- [ ] `pages/workspace/index.tsx` L398 `border-[rgba(34,197,94,0.10)]` → `border-[var(--sam-form-border)]` (drawer header)

### Intentionally left (documented, dark-parity-safe / no exact token / dark island)
- [ ] Decorative SectionHeader icons + iconBg tints (`#06b6d4`, `#a78bfa`, `#9fb7ae`, `#fb923c`) — accents on tinted badges, fine both themes
- [ ] DockerSection `0.12` status-tint backgrounds & L23 `#3b82f6` (restarting) — no exact-dark-match token
- [ ] Danger `rgba(248,113,113,0.3)` / `rgba(239,68,68,0.08/0.2)` borders & banners (NodeOverviewSection L108, NodeEventsSection L142/154, DockerSection L57/58, LogsSection L146/147, index.tsx L318) — no exact token; text already `var(--sam-color-danger/-fg)`
- [ ] LogsSection L192 load-more link & `#0d1117` panel bg — inside dark island
- [ ] WorkspaceTabStrip L505 shadow `0 4px 12px rgba(0,0,0,0.4)` — no byte-exact shadow token
- [ ] WorktreeSelector — already fully token-based
- [ ] LogEntry.tsx — UNCHANGED; inherits pinned dark fg vars from panel container

### Verification
- [ ] Local Vite + Playwright: every workspace/node surface, BOTH themes, 375px & 1280px, varied mock data
- [ ] Confirm terminal/diff/code/log panels stay Tokyo-Night dark in light mode
- [ ] Assert no horizontal overflow; AA contrast on chrome text
- [ ] `pnpm typecheck && pnpm lint && pnpm test` for touched packages; `pnpm build`

## Acceptance Criteria
- Dark mode pixel-identical to pre-change (every converted token's dark value == old literal byte-for-byte).
- Light mode: node-detail cards, log toolbar, mobile drawer render as light chrome with AA-contrast text.
- Log panel content stays bright/readable on its dark `#0d1117` island in BOTH themes.
- No horizontal overflow at 375px/1280px; `lint`/`typecheck`/`test`/`build` green.

## References
- `packages/ui/src/tokens/theme.css`, `apps/web/src/app.css`
- `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/14-do-workflow-persistence.md`
