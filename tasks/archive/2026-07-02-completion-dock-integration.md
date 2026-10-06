# Completion Dock Integration into ProjectMessageView

**Date:** 2026-07-02
**SAM idea:** `01KWHFG7M50YM8BG19J4B77FR7` — "Morphing completion dock — integrate into ProjectMessageView"

## Problem Statement

The project chat currently renders two separate, mutually-exclusive state strips at the
bottom of `apps/web/src/components/project-message-view/index.tsx`:

1. **Idle strip** (~lines 385-403): `Clock` + "Agent idle" + divider + "End session" button.
   Gated on `lc.sessionState === 'idle' && taskMode === 'conversation' && onCloseConversation`.
2. **Working strip** (~lines 405-426): `Spinner` + "Agent is working..." + `ElapsedTime` +
   `StickyPlanButton` + Cancel button. Gated on `lc.agentActivity !== 'idle' && isActive`.

The `agentActivity` signal (`'idle' | 'prompting' | 'responding'`) is fragile — when it is
wrong or stale, the working strip disappears and the user loses access to the Interrupt /
Cancel control mid-response. The idle strip and working strip are wired to different gating
conditions, so there are states where **neither** strip renders and the user has no
lifecycle control at all.

The approved design (prototype Concept B, "morphing center") replaces both strips with a
single **always-mounted** `CompletionDock` while the session `isActive`. A morphing center
button is a red **Interrupt** (Stop/Pause icon with spinner ring) while the agent is working,
and a grey **Archive** button while idle. Because the dock is always mounted, the
interrupt/archive control never disappears even when `agentActivity` is wrong — this is the
core resilience win.

## Research Findings

### Integration target: `apps/web/src/components/project-message-view/index.tsx` (487 lines)

- Imports (verified): `PlanModal, StickyPlanButton, mapToolCallContent` from
  `@simple-agent-manager/acp-client`; `Button, Spinner` from `@simple-agent-manager/ui`;
  `ChevronDown, Clock` from `lucide-react`; `FollowUpInput` from `./FollowUpInput`.
- `currentPlanToPlanItem(plan)` helper (lines 100-112) maps `lc.currentPlan` → PlanItem.
- `ElapsedTime` FC (lines 115-129) renders elapsed time from `startedAt`.
- Props (131-156) include: `onCloseConversation?`, `closingConversation?`, `closeError?`.
- State: `showPlanModal`/`setShowPlanModal` (174); `lc = useSessionLifecycle(...)` (177).
- `planItem` useMemo (244-247): `lc.currentPlan && length>0 ? currentPlanToPlanItem(...) : null`.
- `const isActive = lc.sessionState === 'active' || lc.sessionState === 'idle';` (line 266).
- **Idle strip** to remove (385-403). **Working strip** to remove (405-426).
- `PlanModal` (427-433) is rendered whenever `planItem` exists, `isOpen={showPlanModal}` — keep.
- `FollowUpInput` (436-453) gated on `isActive` — keep below the dock.
- Effect (204-206): `if (lc.agentActivity === 'idle') setShowPlanModal(false);` — keep.

### Geometry source: `apps/web/src/pages/dock-prototype/index.tsx` (`BumpBar`, Concept B)

Approved constants: `BAR_H=56`, `BTN=Math.round(BAR_H*0.9)=50`, `BUBBLE_R=BAR_H/2=28`,
`FILLET_R=12`, `OVERLAP=4`, `SVG_PAD_TOP=Math.ceil(BUBBLE_R)+12=40`. Button center rises from
bar-center (idle, progress 0) to bar-top (working, progress 1). Fillet tangent-blend +
concentric evenodd hole (`holeR=R-OVERLAP`) so the bubble laps OVER the button. SVG `zIndex:1`
`pointerEvents:'none'`; pills/button `zIndex:2`. `showArchiveInCenter = morph && !working`.

Helper hooks to port: `useEased(target, reducedMotion, durationMs=420)` (rAF easeOutBack
rising / linear falling, respects reduced motion), `useWidth<T>()` (ResizeObserver, default
375), `Ring({active,size})` (spinner ring SVG, `motion-safe:animate-spin`,
`strokeDasharray="34 126"`, success-token stroke).

### Theming caveat (CRITICAL — recorded in SAM idea)

`[data-ui-theme='sam']` in `packages/ui/src/tokens/theme.css` (~256) only sets `color` /
`background-color`, NOT the token custom properties (those live only in `:root`, which is the
default dark). Only `[data-ui-theme='sam-light']` (~285) is a full token override layer. This
means token vars (`--sam-glass-bg-chrome`, `--sam-glass-border-color`, `--sam-color-danger`,
`--sam-color-fg-muted`, success token) resolve correctly in the default dark theme without any
wrapper. Do NOT scope `data-ui-theme='sam'` onto a wrapper div expecting dark tokens — it will
not work. Just use the token vars directly; the real `ThemeProvider` on `<html>` drives them.

### Prototype not on main

`apps/web/src/pages/dock-prototype/` and its route/import in `App.tsx` exist ONLY on the
`prototype/morphing-dock` branch, NOT on `origin/main`. The feature branch is cut from
`origin/main`, so there is nothing to delete — the "remove the throwaway prototype" step is a
no-op on this branch. The prototype branch is simply abandoned after merge.

## Implementation Checklist

- [x] Create `apps/web/src/components/project-message-view/CompletionDock.tsx` (production component)
  - [x] Port `useEased`, `useWidth`, `Ring` helpers (or extract into the file)
  - [x] Port `BumpBar` geometry (bump path + evenodd hole + fillet tangent-blend)
  - [x] Props: `working: boolean`, `hasPlan: boolean`, `onInterrupt`, `onArchive`,
        `onOpenPlan`, `archiving`, `archiveDisabled`, `elapsed` slot / `promptStartedAt`
  - [x] Center button: red Interrupt (Square/Pause) + spinner Ring while working;
        grey Archive while idle. NO "Agent is working..." text.
  - [x] Bump domed while working, flat while idle; gated by `prefers-reduced-motion`
  - [x] Token-driven fill/stroke only (`var(--sam-glass-bg-chrome)`,
        `var(--sam-glass-border-color)`, `var(--sam-color-danger)`, etc.) — no hardcoded colors
- [x] Wire `CompletionDock` into `ProjectMessageView`
  - [x] Remove idle strip (385-403) and working strip (405-426)
  - [x] Render `CompletionDock` while `isActive` (single mount point). NOTE: gated
        `(taskEmbed?.taskMode === 'conversation' && onCloseConversation) || agentActivity !== 'idle'`
        — conversation-mode gets the always-mounted morph; task-mode keeps its original
        working-only behavior (idle task-mode shows nothing, matching the original strip).
  - [x] `working = lc.agentActivity !== 'idle'`
  - [x] Interrupt → `lc.handleCancelPrompt`
  - [x] Archive → `onCloseConversation`; disabled/label via `closingConversation`; show `closeError`
  - [x] Plan pill → `setShowPlanModal(true)` when `planItem` exists and working
  - [x] Keep `ElapsedTime` using `lc.promptStartedAt`
  - [x] Keep `PlanModal` (427-433) and `FollowUpInput` (436-453) unchanged
- [x] Behavioral tests: render CompletionDock, assert Interrupt fires while working,
      Archive fires while idle, plan pill opens modal, reduced-motion path, disabled archive
- [x] Playwright visual audit: 375x667 + 1280x800, dark + light, working + idle, assert no
      horizontal overflow (`scrollWidth <= innerWidth`)

## Acceptance Criteria

- [x] The dock is a single component that stays mounted for conversation-mode while `isActive` —
      Interrupt/Archive never disappears when `agentActivity` is stale (covered by a render test
      that mounts a conversation-mode session with `agentActivity='idle'` yet `isActive=true` and
      asserts the Archive control is present). Task-mode intentionally retains original
      working-only mounting (see gating note above) to satisfy the "do NOT touch task-mode
      behavior" constraint.
- [x] Working state shows a red Interrupt with spinner ring and NO "Agent is working..." text.
- [x] Idle state shows a grey Archive button that calls `onCloseConversation`.
- [x] Plan pill appears only while working and a plan exists; clicking opens `PlanModal`.
- [x] Renders correctly in dark (`data-ui-theme=sam`) and light (`sam-light`) — Playwright evidence.
- [x] No horizontal overflow at 375px or 1280px — Playwright assertion.
- [x] `agentActivity` signal path and task-mode behavior are untouched; agent never calls
      `complete_task`.
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass.

## References

- SAM idea `01KWHFG7M50YM8BG19J4B77FR7`
- Prototype geometry: `apps/web/src/pages/dock-prototype/index.tsx` (on `prototype/morphing-dock`)
- `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/26-project-chat-first.md`,
  `.claude/rules/37-prototype-development.md`, `.claude/rules/02-quality-gates.md`

## Staging

Staging verification (Phase 6) is **WAIVED** by explicit user instruction: "No need to deploy
to staging." Local quality gates, tests, and the Playwright visual audit are still mandatory.
