# Heartbeats carry no workspace memory, and declared budgets use nominal rather than real memory

## Problem

Two pre-existing memory-accounting gaps found while fixing
`tasks/active/2026-11-05-provisioned-node-rejects-its-own-task.md` (2026-11-08). Neither caused that
incident, which was on an empty node.

1. **No `workspaceMemory` in production heartbeats.** On 2026-11-08 every running production
   workspace node's `nodes.last_metrics` held only `cpuLoadAvg1`, `memoryPercent`, `diskPercent` and
   `creatingWorkspaces`, including node `01M6VXJTQ77Y0Q2P0Q89B3MJ2S` with 5 active workspaces. The
   vm-agent attaches `workspaceMemory` only when `collectWorkspaceMemoryMetrics()`
   (`packages/vm-agent/internal/server/health.go`) returns rows. Without it, admission credits no
   observed usage, so every running workspace on an occupied node is charged twice: once inside
   measured host use and once as its full reservation (`observedWorkspaceMemoryCredit()` in
   `apps/api/src/services/workspace-reservation-usage.ts`). Occupied nodes refuse co-tenants earlier
   than declared accounting would.
2. **Nominal vs real memory.** Declared budgets use the provider's nominal memory
   (`observed_provider_instance_memory_mb` = 4096 on a cx23). Cloud-init caps the workload slice at
   `MemTotal - reserve` (`packages/cloud-init/src/template.ts`, `sam-configure-docker-memory.sh`), and
   MemTotal is about 5–7% below nominal. So the workload slice is smaller than the budget admission
   hands out: on a cx23 with the 1024 MB reserve, admission allows 3072 MB but the slice is roughly
   2.7 GB.

## Context

Evidence query (production D1, 2026-11-08): `SELECT id, last_metrics FROM nodes WHERE status='running'
AND node_role='workspace'` returned no `workspaceMemory` key on any row. Debug with
`ops_node_logs` filtered on `Heartbeat workspace memory stats unavailable` (Debug level, so it may
need a temporary log-level change), and check `ContainerMode` and
`HEARTBEAT_WORKSPACE_METRICS_MAX_CONTAINERS` on a live node.

## Acceptance Criteria

- [ ] Root cause found for the missing `workspaceMemory` (config, timeout, label discovery or schema)
- [ ] Production heartbeats of nodes with running workspaces include `workspaceMemory`, verified in D1
- [ ] Decide whether declared budgets should use observed MemTotal; if so, report it from the
      vm-agent and use it in `resolveTrustedWorkspaceNodeCapacity`, with provisioning using the same
      figure (rule 69: one accounting policy)
- [ ] Tests through the real heartbeat route and the real admission SQL

## Merged from `2026-11-04-heartbeat-workspace-memory-not-reported.md` (2026-11-09)

That file reported the same gap from staging: only 2 of 183 staging VM nodes had ever reported
`workspaceMemory` (latest 2026-09-08), and a lightweight workspace on node
`01M6M5908QESNY0EER04Q4WF5Z` heartbeated with no `workspaceMemory`. Suspects it listed: runtimes
with no `ContainerLabelValue` (lightweight workspaces?), the all-or-nothing `len(labelValues) > limit`
return, and Docker stats errors logged only at `slog.Debug`. The Nodes page
(`node-resource-model.ts`, `liveMemoryByWorkspace`) also depends on it.

- [ ] Both a lightweight and a full VM workspace report `workspaceMemory`, with a test covering the
      lightweight case
- [ ] A failure to collect is logged at a level visible in production, with the reason
