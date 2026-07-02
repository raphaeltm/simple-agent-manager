# Morphing Completion Dock — Real-UI Integration Plan

> Exploration artifact. This plan describes how the approved **Concept B —
> "Morphing center"** dock would be integrated into the production chat UI. It
> is NOT an approval to implement. The `/prototype/dock` route and this
> `dock-prototype/` directory must be removed before any merge to `main`.

## 1. What the dock replaces

The dock is a **persistent secondary control bar** that sits directly above the
composer in `ProjectMessageView`. It replaces two mutually-exclusive,
state-dependent strips that exist today:

| Today (`apps/web/src/components/project-message-view/index.tsx`) | Lines | Role |
| --- | --- | --- |
| Idle indicator — "Agent idle · End session" | ~385–403 | shown when `sessionState==='idle'` + conversation-mode + `onCloseConversation` |
| Working indicator — `Spinner` + "Agent is working..." + Plan + Cancel | ~405–426 | shown when `agentActivity !== 'idle'` + `isActive` |

Both are conditional and swap in/out as the fragile `agentActivity` signal
changes. The dock is **always mounted** while `isActive`, so the interrupt /
archive affordance never disappears even if the activity signal is wrong. This
is the core resilience win.

## 2. Placement

```
ProjectMessageView (isActive)
├── transcript (scroll)
├── <CompletionDock />        ← NEW: replaces lines 385–403 and 405–426
└── <FollowUpInput />         ← unchanged composer
```

The dock renders between the scroll region and `FollowUpInput`, both `shrink-0`.

## 3. State → visual mapping

The dock derives everything from the existing live-connection object (`lc`) —
no new backend signal is required.

| Dock element | Source | Working (`agentActivity !== 'idle'`) | Idle (`sessionState==='idle'`) |
| --- | --- | --- | --- |
| Center button identity | `working` | red **Interrupt** (Stop/Pause) with spinner ring | grey **Archive** |
| Center button action | — | `lc.handleCancelPrompt()` | `onCloseConversation()` |
| Spinner ring | `working` | visible + spinning | hidden |
| Plan pill (left) | `planItem` (`currentPlanToPlanItem(lc.currentPlan)`) | shown if plan exists → `setShowPlanModal(true)` | hidden |
| Bump geometry | eased `progress` (1 while working, 0 idle) | domed up | flat |

- The "Agent is working..." **text is removed** — the spinner ring is the sole
  working indicator (per standing design direction).
- Cancel → framed as **Interrupt/Pause**; Complete/End → framed as **Archive**.
- The human ends the conversation via Archive; the agent must never call
  `complete_task` itself.

## 4. Reused production components / handlers

| Need | Reuse |
| --- | --- |
| Composer | `FollowUpInput` → `ProjectChatComposer` (unchanged) |
| Plan pill click target | existing `PlanModal` + `showPlanModal` state |
| Plan data | existing `planItem` / `currentPlanToPlanItem` |
| Interrupt handler | existing `lc.handleCancelPrompt` |
| Archive handler | existing `onCloseConversation` (+ `closingConversation` disabled state) |
| Elapsed time | existing `ElapsedTime` (optional, can move into the dock) |
| Icons | `lucide-react`: `Archive`, `Pause`, `Square`, `ListTodo` |

The only genuinely new code is the `CompletionDock` component itself (the SVG
bump geometry + morphing center button). Everything it drives already exists.

## 5. Theming (dark + light)

The dock must be **token-driven** so it inherits both themes automatically. No
hardcoded colors.

| Surface | Token |
| --- | --- |
| Dock fill (SVG path) | `var(--sam-glass-bg-chrome)` (matches composer chrome) |
| Dock hairline (SVG stroke) | `var(--sam-glass-border-color)` |
| Plan pill text | `var(--sam-color-fg-primary)` |
| Plan pill border/bg | accent-tinted tokens (`--sam-color-accent-primary` @ low alpha) |
| Interrupt button bg | `var(--sam-color-danger)` |
| Archive button bg | `var(--sam-color-fg-muted)` |
| Center icon / ring | white on the colored button (reads on both bg colors) |

Light mode is applied by the runtime `ThemeProvider` setting
`data-ui-theme='sam-light'` on `<html>`; every token above has a light override
in `packages/ui/src/tokens/theme.css`. Because the dock reads only tokens, it
adapts with zero conditional logic.

## 6. Accessibility & motion

- Center button keeps a stable `aria-label` that reflects its current action
  ("Interrupt agent" / "Archive conversation").
- Bump animation is gated by `prefers-reduced-motion` (falls back to an instant
  flat↔domed swap).
- Interrupt/Archive remain keyboard-focusable and 44px tap targets.

## 7. Rollout / risk

- The dock is purely presentational over existing handlers, so the blast radius
  is one component + the two strips it replaces in `ProjectMessageView`.
- The fragile `agentActivity` signal still drives the *appearance* (bump vs
  flat), but no longer gates whether the *controls exist* — the biggest current
  failure mode (controls vanishing on a bad signal) is eliminated.
- The underlying `agentActivity` reliability fix is owned separately by the user
  and is out of scope for this dock work.

## 8. Out of scope for this exploration

- Production implementation of `CompletionDock` in `ProjectMessageView`.
- Any change to the `agentActivity` signal path.
- Task-mode (non-conversation) behavior beyond what the current strips do.
