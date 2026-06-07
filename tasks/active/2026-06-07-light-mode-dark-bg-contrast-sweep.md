# Light-mode dark-background contrast sweep (full codebase)

**Date:** 2026-06-07

## Problem Statement

A UX audit of the SAM light theme (`data-ui-theme="sam-light"`) confirmed (via
Playwright dark/light screenshots in `apps/web/.codex/tmp/playwright-screenshots/chat-overlay-*.png`)
that the project chat input box, the SessionHeader top panel, the sidebar search,
the error banner, and several smaller chips/buttons keep a hardcoded near-black
background in light mode instead of adapting. Their text becomes hard to read.
This task sweeps the **entire** web app for the same class of bug and fixes them
all in one PR.

## Root Cause

Surfaces bypass the theme token system in three ways:
1. **Hardcoded near-black `rgba` backgrounds** — `rgba(8,15,12,...)`,
   `rgba(10,15,13,...)`, `rgba(15,8,8,...)` — that never adapt to `sam-light`.
2. **Inline `style={{ backgroundColor }}`** that OVERRIDES `glass-chrome` /
   `glass-surface` utility classes (which DO adapt). Inline styles win the cascade.
3. **`bg-white/[0.0x]` washes** (invisible on light surfaces) and **`bg-black/xx`
   modal scrims** (not theme-aware).

The light theme already exposes every token needed
(`packages/ui/src/tokens/theme.css` under `[data-ui-theme='sam-light']`):
- `--sam-form-bg` (dark `rgba(8,15,12,0.5)` → light `rgba(255,255,255,0.7)`)
- `--sam-color-bg-inset` (dark `#0e1a17` → light `#e3ebe4`) → `bg-inset`
- `--sam-color-bg-surface` → `bg-surface`
- `--sam-glass-bg-surface/-modal`, `--sam-color-fg-primary/-muted`
- `--sam-glass-backdrop-dim` (dark `rgba(0,0,0,0.68)` → light `rgba(20,40,30,0.32)`) → `bg-glass-backdrop-dim`
- `--sam-color-fg-on-accent: #ffffff` → `text-fg-on-accent`

Tailwind v4 `@theme` mappings in `apps/web/src/app.css`: `bg-inset`, `bg-surface`,
`bg-glass-backdrop-dim`, `text-fg-on-accent`. NOTE: there is **no** `--color-form`
mapping, so form inputs must use the arbitrary value `bg-[var(--sam-form-bg)]`.

## Research Findings

The acp-client plan components (`PlanView`, `PlanModal`, `StickyPlanButton`) use
fully-inline hardcoded colors. Their hardcoded values are EXACTLY the dark-theme
token values (`#e6f2ee` = `--sam-color-fg-primary` dark, `#9fb7ae` =
`--sam-color-fg-muted` dark, `rgba(8,15,12,0.55)` = `--sam-glass-bg-modal` dark),
so swapping to `var(...)` is a 1:1 no-op in dark mode and adapts in light. They
render in the LIGHT project-message-view (`index.tsx`, `AcpConversationItemView.tsx`)
and in the legacy `AgentPanel` (which is itself non-adaptive light gray-50/white,
not a dark island) → converting them is safe in both contexts.

`chartTokens.ts:4` uses `var(--sam-admin-chart-tooltip-bg, <fallback>)` and the
var HAS a light override (theme.css:363) → already adapts, NOT a bug.

## Implementation Checklist

### Part 1 — Form inputs → `bg-[var(--sam-form-bg)]`
- [ ] `components/project-chat/ProjectChatComposer.tsx:280` textarea `bg-[rgba(10,15,13,0.6)]`
- [ ] `pages/project-chat/index.tsx:122` search `bg-[rgba(10,15,13,0.4)]`

### Part 2 — Inline-style overrides on glass utilities → remove inline backgroundColor (keep accent boxShadow)
- [ ] `components/project-message-view/SessionHeader.tsx:288` (over glass-chrome, green glow)
- [ ] `components/project-message-view/index.tsx:80` ErrorBanner (over glass-chrome, red glow)

### Part 3 — Tooltip on glass-surface
- [ ] `components/project-message-view/SessionHeader.tsx:170` `bg-[rgba(8,15,12,0.94)]` → `bg-[var(--sam-tooltip-bg)]`

### Part 4 — Chips/buttons → `bg-inset` (or `bg-surface` where a sibling uses it)
- [ ] `components/shared/log/CopyButton.tsx:37`
- [ ] `components/task/TaskSubmitForm.tsx:461`
- [ ] `components/trial/SuggestionChip.tsx:32`
- [ ] `components/trial/DiscoveryCards.tsx:120, 196, 260`
- [ ] `components/ErrorBoundary.tsx:75`
- [ ] `components/account-map/nodes/NodeVMNode.tsx:28` → `bg-surface` (match sibling IdeaNode)
- [ ] `pages/Landing.tsx:61` → `bg-inset`

### Part 5 — `bg-white/[0.0x]` washes → `bg-inset`
- [ ] `pages/ToolsCli.tsx:191` `bg-white/[0.03]`
- [ ] `pages/Tools.tsx:82` `bg-white/[0.04]`
- [ ] `pages/Tools.tsx:87` `bg-white/[0.05]`

### Part 6 — Modal scrims `bg-black/xx` → `bg-glass-backdrop-dim`
- [ ] `pages/AdminComputeQuotas.tsx:282` `bg-black/50`
- [ ] `components/chat/BootLogPanel.tsx:46` `bg-black/20`
- [ ] `components/chat/ChatFilePanel.tsx:276` `bg-black/20`

### Part 7 — Gradient dark stop → token
- [ ] `components/chat/TruncatedSummary.tsx:69` second stop `rgba(8,15,12,0.65)` → `var(--sam-glass-bg-surface)`

### Part 8 — Contrast bug
- [ ] `pages/ToolsCli.tsx:166` `text-black` on `bg-accent` → `text-fg-on-accent`

### Part 9 — acp-client plan components → adaptive tokens (bg + text, keep green accents)
- [ ] `packages/acp-client/src/components/PlanView.tsx`
- [ ] `packages/acp-client/src/components/PlanModal.tsx`
- [ ] `packages/acp-client/src/components/StickyPlanButton.tsx`

### Part 10 — Tests
- [ ] Extend `apps/web/tests/playwright/chat-light-mode-overlay-audit.spec.ts` to
      assert no remaining hardcoded near-black bg on the fixed chat surfaces (light)
- [ ] Clean up the investigation spec (empty MESSAGES) into a proper audit

### Validation
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- [ ] Local Playwright visual audit (mobile 375x667 + desktop 1280x800), no overflow
- [ ] task-completion-validator + ui-ux-specialist
- [ ] Staging deploy + verify both themes as a real user

## MUST NOT TOUCH (intentional dark islands)
- `pages/ToolsCli.tsx:91` CodeBlock (`bg-black/30` terminal surface)
- `packages/terminal/*` (Tokyo Night, `MultiTerminal.tsx:777` `rgba(26,27,38,0.7)`)
- `--sam-color-tn-*` Tokyo Night palette
- `chartTokens.ts:4` (already adaptive via var + light override)

## Acceptance Criteria
- No remaining hardcoded near-black `rgba` backgrounds, `bg-white/[0.0x]` washes,
  or `bg-black/xx` scrims on the surfaces above; all route through theme tokens
  and render correctly in BOTH dark and light.
- ToolsCli CTA uses `text-fg-on-accent` (passes AA in light mode).
- Dark islands unchanged (verified in dark theme screenshots).
- Playwright chat audit asserts adapted backgrounds in light mode; all gates green;
  staging verified in both themes.

## References
- Supersedes/folds in: `tasks/backlog/2026-06-07-light-mode-contrast-overlay-and-audit-coverage.md`
  (ToolsCli/Tools/AdminComputeQuotas/BootLogPanel/ChatFilePanel subset). The full
  new audit-coverage Playwright suites listed there remain deferred.
- `.claude/rules/17-ui-visual-testing.md`, `26-project-chat-first.md`
- `packages/ui/src/tokens/theme.css`, `apps/web/src/app.css`
