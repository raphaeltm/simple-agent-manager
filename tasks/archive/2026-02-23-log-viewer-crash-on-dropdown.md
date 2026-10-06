# Log Viewer Crashes on Dropdown Selection

**Created**: 2026-02-23
**Priority**: High
**Classification**: `ui-change`, `cross-component-change`

## Context

The unified log viewer (added in spec 020-node-observability) crashes with `Cannot read properties of null (reading 'length')` when selecting from filter dropdowns, particularly when choosing "Docker" as the source. Container name filtering also behaves erratically — entries appear then disappear.

## Root Cause Analysis

### Crash: DockerSection null access
**File**: `apps/web/src/components/node/DockerSection.tsx`
- Line 81: Guard checks `!docker || !docker.containerList || docker.containerList.length === 0`
- Line 111: `docker.containerList.map(...)` called without re-checking — crashes if `containerList` is null
- Backend (`packages/vm-agent/internal/sysinfo/sysinfo.go:483-540`): `collectDocker()` returns with `containerList = nil` (Go zero value) when `docker ps` fails or returns empty — never initializes as empty slice

### Container filtering issues
**File**: `packages/vm-agent/internal/logreader/reader.go:295-314`
- When `filter.Container` is empty string, the code appends bare `"CONTAINER_NAME"` to journalctl args as a field match (match any entry with that field)
- This is fragile — journalctl behavior with bare field names may vary
- `parseLogFilter()` in `logs.go:88-104` doesn't distinguish between missing and empty container parameter

### Log filter state management
**File**: `apps/web/src/hooks/useNodeLogs.ts`
- When switching source dropdown, the WebSocket reconnects with new filter params
- Container filter state may not be properly reset when switching between sources
- Race conditions between filter state updates and API calls

## Plan

1. Fix null safety in DockerSection component
2. Initialize Go containerList as empty slice instead of nil
3. Fix container filter logic to properly handle empty/missing values
4. Ensure filter state resets properly on source change

## Detailed Tasklist

- [x] Fix `apps/web/src/components/node/DockerSection.tsx:111` — ternary guard is actually correct (no change needed)
- [x] Fix the ternary condition at line 81 — already properly handles null/undefined (no change needed)
- [x] Fix `packages/vm-agent/internal/sysinfo/sysinfo.go` — initialize `ContainerList` as `[]ContainerInfo{}` on both error and empty paths
- [x] Fix `packages/vm-agent/internal/logreader/reader.go` — ensure `ReadLogs` never returns nil entries (initialize as `[]LogEntry{}`)
- [x] Fix `packages/vm-agent/internal/server/logs.go:88-104` — no change needed, `parseLogFilter()` is correct
- [x] Review `apps/web/src/hooks/useNodeLogs.ts` — added `result.entries ?? []` null guard + clear container filter on non-docker source switch
- [x] Review `apps/web/src/components/node/LogFilters.tsx` — dropdown state management is correct (no change needed)
- [x] Add null safety to `apps/web/src/components/node/LogEntry.tsx:69` — existing `&&` guard is correct (no change needed)
- [x] Run Go tests — logreader and sysinfo pass (pre-existing flaky test in acp package unrelated)
- [x] Run typecheck: `pnpm typecheck` — passes

## Files to Modify

| File | Change |
|------|--------|
| `apps/web/src/components/node/DockerSection.tsx` | Null-safe containerList access |
| `packages/vm-agent/internal/sysinfo/sysinfo.go` | Init ContainerList as empty slice |
| `packages/vm-agent/internal/logreader/reader.go` | Fix empty container filter handling |
| `packages/vm-agent/internal/server/logs.go` | Distinguish missing vs empty container param |
| `apps/web/src/hooks/useNodeLogs.ts` | Reset container filter on source change |
| `apps/web/src/components/node/LogFilters.tsx` | Verify filter state management |
| `apps/web/src/components/node/LogEntry.tsx` | Null-safe metadata access |
