# Mobile UX Exploratory Testing — Implementation

**Date**: 2026-03-09
**Source**: Comprehensive mobile UX testing on 390x844 viewport (iPhone 14 Pro)
**Approach**: Speckit workflow — specify, plan, tasks, implement

## Summary

Exploratory testing found 33 issues across the mobile UX. This task tracks fixing the highest-impact frontend issues that can be addressed in a single PR.

## Priority Fixes (This PR)

### Critical (HIGH)
1. **Message duplication** — Every message renders twice in project chat (#28/42)
2. **Tool name display** — Project chat shows "tool tool" instead of actual tool names (#44, #25, #29, #36)

### Important (MEDIUM)
3. **Nav menu backdrop** — No backdrop overlay on mobile nav drawer (#4)
4. **Raw markdown in chat title** — Chat list shows `**README.md** # Task Title...` (#7)
5. **Auto-grow text input** — Task input area too small on mobile (~2 lines) (#14)
6. **Redundant status badges** — Task cards show both "In Progress" AND "Active" (#53)
7. **Workspace header cramped** — Name truncated to ~2 chars on mobile (#46)

### Deferred (separate tasks)
- Session status always "Active" (needs backend changes)
- Multi-task provisioning overview (needs backend + new UI)
- Cancel during provisioning (needs backend changes)
- Timer reset on navigation (needs state architecture change)

## Acceptance Criteria

- [ ] Messages render exactly once in project chat
- [ ] Tool blocks show actual tool names (matching workspace view behavior)
- [ ] Mobile nav has backdrop overlay
- [ ] Chat titles don't show raw markdown
- [ ] Task input auto-grows on mobile
- [ ] Task cards show single consolidated status badge
- [ ] Workspace header handles mobile width gracefully
- [ ] All fixes have behavioral tests
- [ ] No regressions on desktop
