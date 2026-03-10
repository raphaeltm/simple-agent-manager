# Shared Log Viewer Components

## Problem

The admin LogViewer (`apps/web/src/components/admin/`) has copy-to-clipboard (per-entry + copy-all) and search highlight features that the node log viewer (`apps/web/src/components/node/`) lacks. Both viewers have duplicate implementations of search highlighting. We should extract shared utilities and add the missing features to the node viewer.

## Research Findings

**Admin log viewer** (added in PR #309):
- `LogEntryRow.tsx`: Per-entry copy button (hover-reveal), `highlightText()` with regex escaping, `formatLogEntry()`/`formatLogEntries()` for plain text
- `LogViewer.tsx`: Copy All button, search input, level filters, time range

**Node log viewer**:
- `LogEntry.tsx`: Has `highlightSearch()` (no regex escaping), expandable metadata, no copy button
- `LogsSection.tsx`: Has streaming controls (pause/resume), source/level/container/search filters, no Copy All button
- `LogFilters.tsx`: Debounced search, source/level/container dropdowns

**Key differences**:
- Admin entry type: `{ timestamp, level, event, message, details }`
- Node entry type: `NodeLogEntry { timestamp, level, source, message, metadata? }`
- Admin uses regex-escaped highlight; node uses simple indexOf
- Node has auto-scroll and streaming; admin is paginated

## Implementation Plan

- [ ] Create `apps/web/src/components/shared/log/` directory with:
  - `highlight-text.tsx` — shared `highlightText()` (regex-escaped version from admin)
  - `CopyButton.tsx` — reusable copy button with copied state feedback
  - `format-log-text.ts` — generic formatter accepting `{timestamp, level, label, message, extra?}`
- [ ] Refactor admin `LogEntryRow.tsx` to import from shared
- [ ] Update node `LogEntry.tsx`:
  - Replace `highlightSearch` with shared `highlightText`
  - Add per-entry copy button (hover-reveal like admin)
  - Add `formatNodeLogEntry()` using shared formatter
- [ ] Update node `LogsSection.tsx`:
  - Add Copy All button in toolbar
- [ ] Add tests:
  - Unit tests for shared `highlightText` and `CopyButton`
  - Behavioral tests for node LogEntry copy interaction
  - Behavioral tests for node LogsSection Copy All button
- [ ] Run lint, typecheck, test, build

## Acceptance Criteria

- [ ] Node log viewer has per-entry copy-to-clipboard (hover-reveal button)
- [ ] Node log viewer has Copy All button in toolbar
- [ ] Search highlighting uses the same robust implementation in both viewers
- [ ] Admin log viewer still works identically (no regression)
- [ ] Shared utilities are imported by both viewers (no duplication)
- [ ] Tests cover copy and highlight behavior
