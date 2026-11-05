# VM heartbeats almost never carry per-workspace memory

## Problem

The VM agent is meant to add `metrics.workspaceMemory[]` (live memory per workspace container) to each node heartbeat (`packages/vm-agent/internal/server/health.go`, `collectWorkspaceMemoryMetrics`), and the API stores it in `nodes.last_metrics`. On staging, only **2 of 183** VM nodes have ever had it, the latest on **2026-09-08**. A VM running a lightweight workspace on 2026-11-04 (node `01M6M5908QESNY0EER04Q4WF5Z`, workspace `01M6M5JA5Z7CGCNWEHBPA370DA`) heartbeated every minute with `cpuLoadAvg1`, `memoryPercent` and `diskPercent` but no `workspaceMemory`.

Consumers that expect it:

- The scheduler's measured-admission check reads `workspaceMemory` (`apps/api/src/services/workspace-resource-capacity.ts`), so it is deciding without per-workspace live memory.
- The Nodes page (`apps/web/src/components/node/usage/node-resource-model.ts`, `liveMemoryByWorkspace`) uses it for "now" memory and the live dot; without it, it falls back to the newest resource-history minute (up to ~15 minutes old).

## Context

Found during staging verification of the Nodes page redesign (task `01M6KHM7JE54SN3P23EK4S1NFY`, branch `sam/nodes-page-live-usage`). Likely causes to check, in order: workspaces whose runtime has no `ContainerLabelValue` (lightweight workspaces?), the "all or nothing" `len(labelValues) > limit` return, and Docker stats errors, which are logged only at `slog.Debug` and so are invisible in production (`.claude/rules/39`).

## Acceptance Criteria

- [ ] Root cause identified from VM agent logs (raise the stats-unavailable log above Debug first if needed)
- [ ] A running VM workspace (lightweight and full) reports `workspaceMemory` in its heartbeat on staging, confirmed in `nodes.last_metrics`
- [ ] A failure to collect is logged at a level visible in production, with the reason
- [ ] Test covering a lightweight workspace's heartbeat including its memory
