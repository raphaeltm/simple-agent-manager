# Convert Chats Refresh to Stale-While-Revalidate

## Problem

The `/chats` page currently treats every refresh like a first load. `useAllChatSessions` calls `setLoading(true)` at the start of each fetch, so an explicit refresh or future polling/refetch path can blank known-good chat/session data and replace it with loading UI. Refresh failures also need to be visible without discarding stale-but-usable data.

This is a narrow, non-breaking UI remediation. API contracts must remain unchanged.

## Research Findings

- `apps/web/src/hooks/useAllChatSessions.ts` fetches cross-project chat summaries via `getAllChats({ limit: 100 })`.
- `apps/web/src/pages/Chats.tsx` renders:
  - skeletons whenever `loading` is true,
  - empty state when not loading, no active sessions, and no error,
  - rows when not loading and active sessions exist.
- Current `useAllChatSessions` behavior:
  - uses `sessions: []` initial state,
  - sets `loading=true` and `error=null` at the start of every fetch,
  - preserves sessions on catch but still uses the same `loading` flag for first load and refresh.
- `apps/web/tests/unit/pages/chats.test.tsx` mocks `useAllChatSessions` and covers page rendering states.
- `apps/web/tests/playwright/chats-audit.spec.ts` already covers `/chats` normal data, long text, empty, many items, and error scenarios at mobile and desktop.
- Related rule: `.claude/rules/48-stale-while-revalidate-ui.md` requires spinners only when there is no data yet, and refreshes must keep content visible.

## Implementation Checklist

- [x] Update `useAllChatSessions` to distinguish first-load loading from background refresh.
- [x] Keep existing sessions visible while a refresh is in flight.
- [x] Preserve first-load loading, first-load error, and empty-state behavior.
- [x] Preserve stale data and surface an error when a refresh fails.
- [x] Keep `getAllChats` API usage and response contract unchanged.
- [x] Add/adjust unit tests for first load, refresh with existing data, refresh failure with stale data, empty state, and long-title/list rendering.
- [x] Run targeted web tests and full relevant quality checks.
- [x] Run `/chats` Playwright visual audit if rendered behavior changed materially.
- [x] Run specialist reviews: test-engineer, ui-ux-specialist, constitution-validator; security-auditor only if auth/session boundaries are touched.
- [ ] Open a PR from `sam/execute-task-using-skill-jhsxzd` and do not merge.

## Acceptance Criteria

- First load still shows loading skeletons before any chat data has loaded.
- First-load failure still surfaces an explicit error instead of an empty state.
- Empty successful response still shows "No active chats".
- Refresh with existing chat data keeps rows visible and does not replace the list with skeletons.
- Refresh failure with existing chat data keeps stale rows visible and surfaces the error.
- Long chat titles and many-row lists remain layout-safe.
- No API contract changes.
- PR body states no breaking changes and includes test evidence.
