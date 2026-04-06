# Plan Status Indicator in "Agent is Working" Bar

## Problem

The "Agent is working..." bar in project chat shows a static spinner regardless of whether the agent has an active plan with progress. Users have no visibility into what the agent is doing without scrolling through the conversation.

## Research Findings

### Key Files
- `apps/web/src/components/project-message-view/index.tsx` — Lines 203-217 contain the "Agent is working" bar
- `packages/acp-client/src/index.ts` — Already exports `PlanModal`, `PlanItem`, `StickyPlanButton`
- `packages/acp-client/src/components/PlanModal.tsx` — Full modal with progress bar, Escape-to-close, focus trap
- `packages/acp-client/src/hooks/useAcpMessages.ts` — `PlanItem` type with entries (content, priority, status)

### Existing Patterns
- `StickyPlanButton` shows a plan progress badge with pulse dot — reference for icon/badge patterns
- `PlanModal` accepts `plan: PlanItem`, `isOpen: boolean`, `onClose: () => void`
- Plan data available via `lc.agentSession.messages.items` — find item with `kind === 'plan'`
- `PlanItem.entries[].status`: `'pending' | 'in_progress' | 'completed'`

### No Backend Changes Needed
- All plan infrastructure exists end-to-end
- This is purely a UI enhancement in `project-message-view/index.tsx`

## Implementation Checklist

- [ ] Add `useState` for `planModalOpen` in ProjectMessageView
- [ ] Derive `currentPlan` and `activeStep` from `lc.agentSession.messages.items`
- [ ] Import `ListChecks` from lucide-react and `PlanModal`/`PlanItem` from acp-client
- [ ] Replace lines 203-217 with conditional layout:
  - With plan: ListChecks icon + pulsing green dot + "Agent is working on: [step]" + Cancel
  - Without plan: Spinner + "Agent is working..." + Cancel (current behavior)
- [ ] Render PlanModal when `currentPlan` exists
- [ ] Add CSS truncate on active step text for narrow viewports
- [ ] Write behavioral tests for both states and modal open/close

## Acceptance Criteria

- [ ] With active plan: bar shows list icon (pulsing green dot) + "Agent is working on: [current step]"
- [ ] Without plan: bar shows spinner + "Agent is working..." (current behavior preserved)
- [ ] Tapping list icon opens PlanModal with all entries and statuses
- [ ] PlanModal closable via X, backdrop click, or Escape
- [ ] Active step text truncates on narrow viewports (no horizontal overflow)
- [ ] Cancel button accessible in both states
- [ ] Plan updates reflected in real-time
- [ ] Behavioral tests for both states and modal open/close
