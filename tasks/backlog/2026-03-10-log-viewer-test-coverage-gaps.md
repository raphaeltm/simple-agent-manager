# Log Viewer: Test Coverage Gaps

## Problem

Test engineer review of PR #309 identified several test gaps in the log viewer components. The core functionality is tested at the `LogEntryRow` level, but container-level behavioral tests are missing for some interactions.

## Priority Gaps

1. **Copy All click behavior** — LogViewer and LogStream tests check button presence but never click it and assert `clipboard.writeText` was called with formatted entries
2. **Copied state feedback** — No test verifies the Copy → Check icon transition after clipboard write
3. **Search submit interaction** — No test types into search input, presses Enter, and asserts `setSearch` was called
4. **Expand/collapse toggle** — Only expand is tested, not collapse on second click
5. **Multiple highlight matches** — No test for search term appearing twice producing two `<mark>` elements

## Files

- `apps/web/tests/unit/components/admin/log-viewer.test.tsx`
- `apps/web/tests/unit/components/admin/log-stream.test.tsx`
- `apps/web/tests/unit/components/admin/log-entry-row.test.tsx`

## Acceptance Criteria

- [ ] All 10 missing tests from test engineer review are added
- [ ] All tests pass
