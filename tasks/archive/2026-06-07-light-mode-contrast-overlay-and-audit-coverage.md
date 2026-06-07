# Light-mode contrast/overlay bug fixes + Playwright audit coverage

**Task ID:** 01KTGRHBBYHP0VRM0DEPJVCRMR
**Date:** 2026-06-07

## Problem Statement

A UX audit of the SAM light theme surfaced real rendering defects and gaps in
automated light-mode coverage:

1. **Contrast failure (WCAG AA):** `ToolsCli.tsx` renders a primary CTA with
   `bg-accent text-black`. In light mode the accent is `#15803d`; black text on
   that fill is ~3.3:1, below the 4.5:1 AA threshold.
2. **Dark-assuming overlays:** Several surfaces hardcode `bg-white/[0.0x]` chip
   washes (invisible on a light surface) or `bg-black/xx` modal scrims (too dark,
   not theme-aware). These should route through theme tokens so they adapt.
3. **Audit coverage gaps:** Many screens have no light-mode Playwright visual
   audit, so future light-mode regressions on those screens would ship silently.

## Constraints

- A concurrent task (`01KTGR36MXMN0NV0H5VED4ZCGP`) is building the three-way
  theme switcher. **Do NOT** modify `ThemeContext`, `main.tsx` seed logic, or any
  switcher UI. Keep this change scoped to the contrast/overlay fixes and tests.
- **Dark islands stay dark in both themes** — do NOT force these light:
  - `ToolsCli.tsx` `CodeBlock` (`bg-black/30`, terminal surface)
  - `ProjectAgentChat` (immersive dark island)
  - Tokyo Night palette (`--sam-color-tn-*`)

## Research Findings

### Theme system
- Theme applied via `<html data-ui-theme>` from localStorage `sam-theme`
  (`dark` -> `sam`, `light` -> `sam-light`).
- Light token overrides live in `packages/ui/src/tokens/theme.css` under
  `[data-ui-theme='sam-light']`.
- Tailwind v4 `@theme` mapping in `apps/web/src/app.css`:
  - `--color-inset: var(--sam-color-bg-inset)` -> `bg-inset`
  - `--color-fg-on-accent: var(--sam-color-fg-on-accent)` -> `text-fg-on-accent`
  - `--color-glass-backdrop-dim: var(--sam-glass-backdrop-dim)`
- `glass-backdrop-dim` is the established scrim utility class (used by ~15 modals/
  drawers); replacing hardcoded `bg-black/x` with it is the canonical theme-safe
  pattern.
- Light values: `--sam-color-bg-inset: #e3ebe4`, `--sam-color-accent-primary:
  #15803d`, `--sam-color-fg-on-accent: #ffffff`, `--sam-glass-backdrop-dim:
  rgba(20, 40, 30, 0.32)`.

### Exact code defects
- `apps/web/src/pages/ToolsCli.tsx` ~166: `bg-accent text-black` (contrast bug)
- `apps/web/src/pages/ToolsCli.tsx` ~191: `bg-white/[0.03]` chip overlay
- `apps/web/src/pages/Tools.tsx` ~82: `bg-white/[0.04]` icon bg (coming-soon)
- `apps/web/src/pages/Tools.tsx` ~87: `bg-white/[0.05]` coming-soon chip
- `apps/web/src/pages/AdminComputeQuotas.tsx` ~282: `bg-black/50` modal scrim
- `apps/web/src/components/chat/BootLogPanel.tsx` ~46: `bg-black/20` backdrop
- `apps/web/src/components/chat/ChatFilePanel.tsx` ~276: `bg-black/20` backdrop

### Existing light-mode audit coverage (do NOT duplicate)
- `admin-chrome-theme-audit`: /admin/costs, /admin/logs, /admin/errors
- `admin-analytics-audit`: /admin/analytics (+ sub-tabs)
- `slice-e-theme-audit`: project library, ideas, triggers, project settings,
  project notifications, agent-context/memory
- `light-mode-slice-b-audit` + `theme-foundation-audit`: project chat
- `chrome-theme-slice-audit`: app chrome (nav drawer, notifications, command
  palette) via /ui-standards
- `workspace-node-chrome-light-audit`: /workspaces, /nodes, workspace detail,
  node detail
- `onboarding-wizard-theme-audit`: onboarding, /workspaces

### Uncovered screens (light-mode gaps to add)
- **Settings cluster** (top-level `/settings/*`): cloud-provider, github, agents,
  notifications, usage, api-tokens — no light coverage.
- **List pages:** `/projects` (Projects), `/chats` (Chats), task detail
  (`/projects/:id/tasks/:taskId`) — no light coverage.
- **Tools:** `/tools`, `/tools/cli` — no light coverage.
- **Admin:** `/admin/overview`, `/admin/users`, `/admin/stream`,
  `/admin/ai-proxy`, `/admin/usage` (compute usage), `/admin/quotas` (compute
  quotas), `/admin/credentials` (platform credentials) — no light coverage.

### Test helpers (reuse)
`apps/web/tests/playwright/audit-helpers.ts` exports `makeMockUser`,
`seedTheme(page, 'dark'|'light')`, `expectTheme`, `screenshot` (captures with
viewport suffix to `.codex/tmp/playwright-screenshots`), `assertNoOverflow`,
`jsonResponse`. Follow the dark/light loop + stress-mock pattern from
`slice-e-theme-audit.spec.ts`.

## Implementation Checklist

### Part 1 — Contrast bug
- [x] `ToolsCli.tsx` ~166: `text-black` -> `text-fg-on-accent`

### Part 2 — Dark-assuming overlays -> tokens
- [x] `Tools.tsx` ~82: `bg-white/[0.04]` -> `bg-inset`
- [x] `Tools.tsx` ~87: `bg-white/[0.05]` -> `bg-inset`
- [x] `ToolsCli.tsx` ~191: `bg-white/[0.03]` -> `bg-inset`
- [x] `AdminComputeQuotas.tsx` ~282: `bg-black/50` -> `glass-backdrop-dim`
- [x] `BootLogPanel.tsx` ~46: `bg-black/20` -> `glass-backdrop-dim`
- [x] `ChatFilePanel.tsx` ~276: `bg-black/20` -> `glass-backdrop-dim`

### Part 3 — New light-mode Playwright audits (dark + light, mobile 375x667 + desktop 1280x800, assertNoOverflow each, stress mock data)
- [x] Settings cluster audit (cloud-provider, github, agents, notifications, usage, api-tokens)
- [x] Lists audit (/projects, /chats, task detail)
- [x] Tools audit (/tools, /tools/cli) — asserts CTA + chips render in light
- [x] Admin audit (overview, users, stream, ai-proxy, usage, quotas, credentials)

### Validation
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- [x] Run new Playwright audits locally; confirm no overflow, screenshots clean
- [x] task-completion-validator

## Acceptance Criteria
- ToolsCli CTA uses `text-fg-on-accent`; passes AA contrast in light mode.
- No remaining `bg-white/[0.0x]` washes or hardcoded `bg-black/x` scrims on the
  six listed surfaces; they use theme tokens and render correctly in both themes.
- Dark islands (CodeBlock, ProjectAgentChat, Tokyo Night) unchanged.
- New Playwright audits cover the listed uncovered screens in both dark and light,
  both viewports, each asserting `assertNoOverflow`.
- All quality gates green; staging verified in both themes as a real user.

## References
- `.claude/rules/17-ui-visual-testing.md` (mandatory visual audit)
- `.claude/rules/24-no-duplicate-ui-controls.md`
- `.claude/rules/02-quality-gates.md` (behavioral, not source-string, tests)
- `.claude/rules/30-never-ship-broken-features.md`, `33-staging-feature-validation.md`
- `packages/ui/src/tokens/theme.css`, `apps/web/src/app.css`
