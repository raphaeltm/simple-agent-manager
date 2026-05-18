# Error Banner Glass Styling in Project Chat

## Problem

Error messages at the top of the project chat UI (e.g., "Task failed: ...") have no backdrop blur or dark background, making them unreadable when overlapping chat content beneath. The success/completion message (SessionHeader) uses a glass-chrome treatment with green accents, but error messages use a plain `bg-danger-tint` with no visual depth.

## Research Findings

- **SessionHeader** (`apps/web/src/components/project-message-view/SessionHeader.tsx`): Uses `glass-chrome glass-composited` with `backgroundColor: rgba(8, 15, 12, 0.68)` and green radial glow (`rgba(34, 197, 94, ...)`), plus `rounded-b-2xl`.
- **Error div** (`apps/web/src/components/project-message-view/index.tsx`, lines 199-204 and 238-243): Uses plain `bg-danger-tint border-b border-border-default` — no glass, no blur, no darkening.
- **TruncatedSummary** (`apps/web/src/components/chat/TruncatedSummary.tsx`): Uses `glass-surface glass-composited` with green gradient background — good reference for the pattern.
- Error div appears in two places (empty messages view and messages-present view) — both need updating.
- When error div sits below SessionHeader, the header's `rounded-b-2xl` creates a visual gap since the error has no matching treatment.

## Implementation Checklist

- [x] Add `hasContentBelow` prop to SessionHeader to suppress bottom rounding and green glow
- [x] Style error div with `glass-chrome glass-composited` + dark rgba background
- [x] Use red accents: `rgba(239, 68, 68, ...)` for radial glow and box-shadow
- [x] Handle error-only (error gets rounded bottom + glow) vs error+summary (error passes bottom treatment to summary)
- [x] Update both occurrences in index.tsx (empty and messages-present views)
- [x] Verify build and typecheck pass

## Acceptance Criteria

- [ ] Error messages at the top of project chat have backdrop blur and dark background matching the glass-chrome pattern
- [ ] Error messages use red accent color instead of green
- [ ] SessionHeader seamlessly connects to error div when present (no visual gap)
- [ ] When both error and output summary exist, visual flow is continuous
- [ ] No horizontal overflow on mobile viewports
- [ ] Build and typecheck pass

## References

- Screenshot: `/workspaces/.private/Simple Agent Manager 2026-05-19 00.23.51.png`
- Glass utilities: `apps/web/src/index.css` lines 152-198
- Design tokens: `packages/ui/src/tokens/`
