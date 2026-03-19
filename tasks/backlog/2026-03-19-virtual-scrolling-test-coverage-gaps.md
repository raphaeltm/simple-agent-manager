# Virtual Scrolling Test Coverage Gaps

**Created**: 2026-03-19
**Source**: Late-arriving test-engineer review of PR #462 (virtual scrolling)
**Priority**: Medium

## Problem

PR #462 added virtual scrolling via react-virtuoso to `ProjectMessageView` and `AgentPanel`. The JSDOM Virtuoso mock omits `atBottomStateChange`, which means scroll-related state (`showScrollButton`, `isAtBottom`) is never toggled in tests. This creates two HIGH coverage gaps and several MEDIUM ones.

## HIGH — Must Fix

### 1. No test for `loadMore` → `setFirstItemIndex` pagination path

The `loadMore` function decrements `firstItemIndex` by `actualAdded` (dedup-safe count) so Virtuoso maintains stable virtual indices during prepend. No test sets `hasMore: true` or clicks the "Load earlier messages" button.

**File**: `apps/web/tests/unit/components/project-message-view.test.tsx`
**Fix**: Add test with `hasMore: true`, click Header button, assert `firstItemIndex` decreases correctly and older messages appear.

### 2. No FAB visibility or click test in AgentPanel

The old `calls scrollToBottom when FAB is clicked` test was removed. The mock Virtuoso never calls `atBottomStateChange(false)`, so the FAB can never render in tests. The `scrollToIndex` ref method is also not mocked.

**File**: `packages/acp-client/src/components/AgentPanel.test.tsx`
**Fix**: Enhance mock to optionally trigger `atBottomStateChange(false)`, then test FAB appears and click calls `scrollToIndex`.

## MEDIUM — Should Fix

### 3. ACP→DO key-based remount has no transition test

The `key={useFullAcpView ? 'acp' : 'do'}` switch that forces Virtuoso remount on grace-period end is not tested.

### 4. Source-contract test in `chat-components.test.ts`

The `toContain('Virtuoso')` / `toContain('followOutput')` test violates the prohibited source-contract pattern (rule 02). Should be replaced with behavioral test or removed (behavioral coverage exists in `.test.tsx` files).

### 5. Mock pattern inconsistency

`AgentPanel.test.tsx` uses `vi.mock()` while `project-message-view.test.tsx` uses `vi.hoisted()`. The hoisted pattern is safer — standardize on it.

## LOW

### 6. Dropped negative tests for scroll reset

The `ready → prompting` (should NOT reset) and `replaying → prompting` (should reset) state transition tests were dropped from AgentPanel. The `prompting` branch of the reset logic is now untested.

## Implementation Checklist

- [ ] Enhance Virtuoso mock to support `atBottomStateChange` callback (both test files)
- [ ] Add `loadMore` pagination test with `hasMore: true` in ProjectMessageView
- [ ] Add FAB visibility + click test in AgentPanel
- [ ] Add ACP→DO key remount transition test
- [ ] Remove or replace source-contract test in `chat-components.test.ts`
- [ ] Standardize mock pattern to `vi.hoisted()` in AgentPanel tests
- [ ] Restore `replaying → prompting` and negative transition tests

## Acceptance Criteria

- [ ] All HIGH coverage gaps have behavioral tests
- [ ] No source-contract tests for interactive behavior remain
- [ ] Mock Virtuoso supports `atBottomStateChange` for scroll state testing
- [ ] All tests pass: `pnpm test`
