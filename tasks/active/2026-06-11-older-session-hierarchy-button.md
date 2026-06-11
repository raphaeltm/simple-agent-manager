# Older Session Hierarchy Button

## Problem

The task hierarchy button is missing from project chat sessions shown in the "Older" stale session bucket. Recent session lists pass `onShowHierarchy` into `SessionList`, but stale desktop and mobile list instances omit the callback. Completed dispatched-task families become stale quickly, so users can see task grouping controls without the hierarchy button.

## Research Findings

- `apps/web/src/pages/project-chat/index.tsx` passes `onShowHierarchy={handleShowHierarchy}` to the recent `SessionList` but not the stale `SessionList`.
- `apps/web/src/pages/project-chat/MobileSessionDrawer.tsx` passes `onShowHierarchy={onShowHierarchy}` to the recent `SessionList` but not the stale `SessionList`.
- `apps/web/src/pages/project-chat/SessionList.tsx` forwards `onShowHierarchy` to each `SessionTreeItem`; the prop is optional, so TypeScript did not catch stale-list omissions.
- `apps/web/src/pages/project-chat/SessionTreeItem.tsx` only renders the hierarchy button when `onShowHierarchy`, `node.session.taskId`, and hierarchy metadata are present.
- `.claude/rules/02-quality-gates.md` requires bug fixes to include fix-proving tests, regression-catching tests, a post-mortem, and a concrete process fix in the same PR.
- `.claude/rules/17-ui-visual-testing.md` requires local Playwright visual audit screenshots at 375x667 and 1280x800 with overflow assertions for web UI changes.

## Implementation Checklist

- [ ] Add `onShowHierarchy={handleShowHierarchy}` to the stale desktop `SessionList` in `apps/web/src/pages/project-chat/index.tsx`.
- [ ] Add `onShowHierarchy={onShowHierarchy}` to the stale mobile drawer `SessionList` in `apps/web/src/pages/project-chat/MobileSessionDrawer.tsx`.
- [ ] Add a stale-bucket behavioral regression test with parent/child `taskInfoMap` lineage, old `lastMessageAt`, hierarchy button assertion, and click handler assertion for the correct `taskId`.
- [ ] Add a process fix so parallel `SessionList` instances cannot silently diverge on this callback again.
- [ ] Run targeted unit tests and web quality checks.
- [ ] Run Playwright visual audit at 375x667 and 1280x800 with overflow assertions.
- [ ] Complete required specialist reviews: task-completion-validator, ui-ux-specialist, test-engineer.
- [ ] Deploy to staging and verify the hierarchy button appears and opens for a stale dispatched-task session.
- [ ] Merge after green CI, then monitor production deploy and verify production behavior.

## Acceptance Criteria

- Desktop project chat "Older" sessions with task hierarchy metadata render the `aria-label="View task hierarchy"` button.
- Mobile project chat drawer "Older" sessions with task hierarchy metadata render the same hierarchy button.
- Clicking the stale-bucket hierarchy button calls the hierarchy modal handler with the session's `taskId`.
- Tests exercise the stale bucket specifically, not only recent sessions.
- The PR description includes a Post-Mortem section and specialist Review Tracker.

## Post-Mortem

### What Broke

Users could see grouped stale dispatched-task session families in the Older bucket, but could not open the task hierarchy from those stale list rows.

### Root Cause

PR #1279 added hierarchy button rendering behind the optional `onShowHierarchy` callback. Recent `SessionList` instances received the callback; stale desktop and mobile `SessionList` instances did not.

### Timeline

- Introduced: PR #1279 when task hierarchy controls were added.
- Discovered: 2026-06-11 via production fault injection comparing stale and recent buckets.
- Fixed: this task adds the missing callback propagation and regression coverage.

### Why It Wasn't Caught

Tests and review did not exercise the stale/Older bucket path. The callback was optional on `SessionList`, so TypeScript allowed parallel instances to drift.

### Class Of Bug

Optional callback props omitted from one of several parallel component instances.

### Process Fix

The implementation will either make the callback required for `SessionList` or consolidate shared props so parallel `SessionList` instances cannot diverge silently.

## References

- `.claude/rules/02-quality-gates.md`
- `.claude/rules/17-ui-visual-testing.md`
- `apps/web/src/pages/project-chat/index.tsx`
- `apps/web/src/pages/project-chat/MobileSessionDrawer.tsx`
- `apps/web/src/pages/project-chat/SessionList.tsx`
