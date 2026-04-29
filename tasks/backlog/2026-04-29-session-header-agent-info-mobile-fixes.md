# Session Header Agent Info — Mobile Truncation & Accessibility Fixes

## Problem

Post-merge UI/UX review of PR #856 identified two issues in the agent info row added to SessionHeader's expanded panel:

1. **Long profile hint overflow (HIGH)**: The `agentProfileHint` span has no `truncate`, `max-w`, or `min-w-0` constraint. Single-token slugs like `custom-profile-with-very-long-name-that-might-overflow` won't wrap (no spaces to break on) and can push the parent to overflow on 375px viewports. The `flex-wrap` on the parent row doesn't help for unbreakable tokens.

2. **Missing aria-hidden on icons (LOW)**: The four new icons (`Bot`, `MessageSquare`, `Cpu`, `User2`) lack `aria-hidden="true"`, which the established `ContextItem` and `CopyableId` patterns include.

## Files

- `apps/web/src/components/project-message-view/SessionHeader.tsx` — lines ~337-355

## Implementation Checklist

- [ ] Add `truncate min-w-0 max-w-[16rem]` to the profile hint span and wrap the text in a `<span className="truncate">`
- [ ] Add `shrink-0` to the `User2` icon so it doesn't compress when text truncates
- [ ] Add `aria-hidden="true"` to all four icons in the agent info row (`Bot`, `MessageSquare`, `Cpu`, `User2`)
- [ ] Run Playwright visual audit on mobile (375px) with a long single-token profile hint to confirm truncation works
- [ ] Verify no horizontal overflow on mobile

## Acceptance Criteria

- [ ] A 72-character single-token profile hint truncates with ellipsis on mobile viewport
- [ ] All icons in the agent info row have `aria-hidden="true"`
- [ ] No horizontal overflow on 375px viewport with any combination of agent info values

## Context

- Source: UI/UX specialist review of PR #856 (late-arriving, post-merge)
- Severity: HIGH (F1), LOW (F2)
