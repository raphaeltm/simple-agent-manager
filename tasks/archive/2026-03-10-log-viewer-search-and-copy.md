# Log Viewer: Search Highlight & Copy to Clipboard

## Problem

The admin log viewer lacks two critical usability features:

1. **No copy mechanism** — When debugging issues (e.g., MCP server injection), users cannot copy log entries to paste into chat sessions or bug reports. This is especially painful on mobile where text selection in the current UI is unreliable.

2. **No client-side search highlight** — The existing search filters server-side (historical) or via WebSocket filter (stream), but neither highlights matching text in the results. Users scanning logs for specific session IDs or error messages must visually hunt through entries.

## Research Findings

### Key Files
- `apps/web/src/components/admin/LogViewer.tsx` — Historical log viewer (205 lines)
- `apps/web/src/components/admin/LogStream.tsx` — Real-time log stream (242 lines)
- Both components have independent `LogEntryRow` subcomponents with identical structure
- `apps/web/tests/unit/components/admin/log-viewer.test.tsx` — LogViewer tests
- `apps/web/tests/unit/components/admin/log-stream.test.tsx` — LogStream tests

### Current State
- Both components have search input that filters server-side but doesn't highlight matches
- Log entries show: level badge, timestamp, event name, message (truncated), expandable JSON details
- No copy affordance — no buttons, no text selection optimization
- `LogEntryRow` is duplicated between both components (same structure, slightly different prop names)

### Design Decisions
- **Extract shared `LogEntryRow`** — DRY up the duplicated component into a shared module
- **Copy button per entry** — Small clipboard icon on each row; copies formatted text (level, timestamp, event, message, details)
- **"Copy All Visible" button** — In toolbar, copies all currently displayed entries as formatted text
- **Client-side highlight** — After server-side filtering returns results, highlight the search term in message text with a `<mark>` element
- **Mobile-first** — Copy buttons must be touch-friendly (min 44px tap target)

## Implementation Checklist

- [ ] Extract shared `LogEntryRow` component from LogViewer/LogStream into `apps/web/src/components/admin/LogEntryRow.tsx`
- [ ] Add per-entry copy button (clipboard icon) that copies formatted log text
- [ ] Add "Copy All" button to toolbar in both LogViewer and LogStream
- [ ] Add search term highlight in message text (wrap matches in `<mark>`)
- [ ] Pass search term down to LogEntryRow for highlighting
- [ ] Update LogViewer to use shared LogEntryRow
- [ ] Update LogStream to use shared LogEntryRow
- [ ] Add unit tests for copy functionality
- [ ] Add unit tests for search highlight
- [ ] Run quality checks (lint, typecheck, test)

## Acceptance Criteria

- [ ] Tapping copy icon on a log entry copies formatted text to clipboard
- [ ] "Copy All" copies all visible entries as formatted text
- [ ] Search terms are visually highlighted in log message text
- [ ] Copy works on mobile (touch-friendly tap targets)
- [ ] No regressions in existing log viewer/stream functionality
- [ ] All tests pass

## References
- Spec: `specs/023-admin-observability/spec.md`
- Components: `apps/web/src/components/admin/LogViewer.tsx`, `LogStream.tsx`
- Tests: `apps/web/tests/unit/components/admin/log-viewer.test.tsx`, `log-stream.test.tsx`
