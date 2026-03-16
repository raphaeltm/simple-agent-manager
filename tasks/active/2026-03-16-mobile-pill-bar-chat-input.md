# Mobile Pill Bar for Chat Input Selectors

## Problem

The ChatInput component in `apps/web/src/pages/ProjectChat.tsx` (lines 1075-1126) renders three label+select pairs (Agent, Workspace, Run mode) in a `flex-wrap` row with `gap-4`. On mobile (<767px), these wrap unpredictably:

- Items don't fit in one row, wrapping creates uneven rows
- Labels ("Agent:", "Workspace:", "Run mode:") consume precious horizontal space
- Nothing aligns vertically — a row might have 2 selectors then 1 orphaned below
- The overall feel is clunky and unpolished

## Solution

Replace the label+select layout with compact "pill" style selectors on mobile only. Each pill shows just the current value + dropdown indicator, no labels. Desktop layout stays unchanged.

Target mobile layout:
```
[ Claude Code ▾ ]  [ Full ▾ ]  [ Task ▾ ]
┌─────────────────────────────────────────┐
│ Describe what you want...               │
└─────────────────────────────────────────┘
```

## Research Findings

### Key Files
- `apps/web/src/pages/ProjectChat.tsx` — ChatInput component (lines 1014-1167)
  - Controls container: `flex items-center gap-4 mb-2 flex-wrap` (line 1075)
  - Agent select: conditional on `agents.length > 1` (lines 1076-1093)
  - Workspace select: always visible (lines 1094-1106)
  - Task mode select: always visible (lines 1107-1125)
- `apps/web/src/hooks/useIsMobile.ts` — Mobile breakpoint (767px)
- ChatInput currently does NOT receive `isMobile` — it needs to import and use the hook itself, or receive it as a prop

### Design Tokens in Use
- Borders: `border-border-default`
- Backgrounds: `bg-page`, `bg-surface`
- Text: `text-fg-primary`, `text-fg-muted`
- Current select styling: `px-2 py-1 border border-border-default rounded-md bg-page text-fg-primary text-xs`

### Props Available in ChatInput
- `agents`, `selectedAgentType`, `onAgentTypeChange`
- `selectedWorkspaceProfile`, `onWorkspaceProfileChange`
- `selectedTaskMode`, `onTaskModeChange`

## Implementation Checklist

- [ ] Import `useIsMobile` hook in ChatInput component (or pass as prop)
- [ ] Create mobile pill bar layout: compact row of pill-styled selects without labels
- [ ] Style pills: small rounded containers, subtle borders, compact padding
- [ ] Keep desktop layout unchanged (conditional rendering based on `isMobile`)
- [ ] Ensure all three pills fit on one row at 320px width
- [ ] Add `aria-label` attributes to pill selects for accessibility (compensating for removed visible labels)
- [ ] Preserve agent pill conditional rendering (`agents.length > 1`)
- [ ] Verify no regressions to chat input functionality

## Acceptance Criteria

- [ ] On mobile (<767px), selectors render as compact pills in a single row without labels
- [ ] On desktop (>=768px), existing label+select layout is preserved unchanged
- [ ] All three pills fit in one row on a 320px-wide screen
- [ ] Each pill select has an appropriate `aria-label` for accessibility
- [ ] Agent pill only appears when `agents.length > 1`
- [ ] Visual styling uses existing design tokens
- [ ] No regressions to chat input (typing, submitting, voice, Ctrl+Enter)
