# Operations tools PR3: approved actions + telemetry (decision log, black box, snapshot trace)

SAM task `01M6GN7PP650TXB7X9D7302085`. Idea `01M6GGY1QPGG4D40HG0PVGQS3R`. Orchestrator `01M6GGJJAYQBEZXX2E93C9Y4WW`.
Siblings: PR1 `01M6GN63FR1V4063V7RVXMDT3X` (access gate, `services/operations-access.ts`), PR2 (read tools: `ops_timeline`, `ops_get_node`, `ops_get_session_story`, node-agent call service). Merge order PR1 → PR2 → PR3. Channel `feature.operations-tools`.

## Problem

Debugging agents in the Operations project cannot answer "why is this node still alive", lose node logs when a node is torn down, see "snapshot failed" without knowing which step failed, and have no safe way to act. PR3 adds the memory (telemetry) and the hands (actions behind a server-side human approval).

## Research findings

### Decision log write points
- NodeLifecycle DO `apps/api/src/durable-objects/node-lifecycle.ts`: `markIdleSerialized` (kept active: userOwned/occupied/placementClaim; marked warm + timeout), `tryClaimSerialized` (claimed by task), `markActive`, `releaseClaim`, `handoffIdleNode` (warm → destroying, or preserved because a reservation/claim won, or node gone), `handleDestroyingAlarm` (max destroying age, node absent/stopped), `finalizeDeletion` (explicit terminal proof).
- Cron sweep `scheduled/node-cleanup/shared.ts:destroyNodeForCleanup` is the single destroy hook for every VM phase: budget skip (:284), claim refusal with `diagnoseCleanupRefusal().reasons` (:294-321), strict delete result (`providerVm`), failure (`handleCleanupFailure`). Skips repeat every 5 min → dedupe in SQL.
- `services/node-warm-handoff.ts:handOffEmptyWorkspaceNode` outcomes: `handed_to_warm`, `preserved_active`, `skipped(reason)`, `failed`.
- Rule 53: the verdict must not treat `last_heartbeat_at`/`updated_at` as idleness. Use active workspace reservations, NodeLifecycle state, warm_since, and the last decisions.
- Template table: `node_health_events` (migration 0172, no FK to nodes so rows survive node deletion).

### Black box recorder
- Teardown chokepoint: `services/strict-node-deletion.ts:deleteNodeResourcesStrict` → `deleteStrictProviderInstance` right before `provider.deleteVM` (:302). Covers cron, explicit API delete, stop, deployment nodes, trial expiry, TaskRunner, fresh-provisioning cleanup.
- Bypasses (documented, not captured): `node-provisioning.ts:deleteCreatedProviderVmDirectly` (VM just created, never booted an agent) and `provider-orphan-reconciliation-core.ts:destroyCandidate` (no node row). cf-container teardown has no VM logs worth capturing (container DO).
- Unhealthy transition: `scheduled/node-cleanup/unhealthy-nodes.ts:processUnhealthyCandidate` health CAS (:310-316). Other `health_status='unhealthy'` writers are provisioning/boot failures/container paths (out of scope: no live VM agent).
- VM `/logs` via `services/node-agent-diagnostics.ts:getNodeLogsFromNode` → `nodeAgentRequest` with `signNodeManagementToken(node.user_id, …)`. Sources `agent|cloud-init|systemd|docker|all`, `limit` ≤ 1000, newest first. Background timeout tier `DEFAULT_NODE_AGENT_BACKGROUND_REQUEST_TIMEOUT_MS` = 5s.
- No new VM endpoint needed for logs. R2: reuse `env.R2` under prefix `node-log-captures/`. gzip pattern: `workspace-resource-history.ts:gzipJson`. Purge pattern: `runWorkspaceResourceHistoryCleanup`.
- Rule 47: cron teardown is sequential per node → only capture when the node's heartbeat is fresh (cheap reachability pre-check, not an idleness signal), bounded by a short timeout, and run unhealthy-transition captures in parallel after the loop.

### Snapshot step trace
- Go agent already times sleep/wake phases (`internal/server/lifecycle_timings.go`) and posts them once to `/lifecycle-timings` (log-only, `routes/workspaces/lifecycle-timings.ts`). No per-step outcome, no stderr tail, nothing persisted.
- Errors carry stderr inside `err.Error()`; `cappedBuffer` keeps the HEAD (rule 53 §5c says keep the tail).
- `session_snapshots` is one row per chat. Persist traces in a child table `session_snapshot_traces` (bounded rows per chat) keyed by `chat_session_id`.
- Rollout compat (rule 54): older agents send the old payload without `chatSessionId`/`failedPhase`/`errorTail` → keep logging only, never 400.

### Actions
- MCP: `routes/mcp/tool-definitions.ts` arrays + `tool-handler-table.ts` Map. `McpTokenData` (`services/mcp-token.ts:35`). PR1 provides `requireOperationsAccess(env, tokenData, {capability})` and `recordOperationsAudit`.
- Notifications: `services/notification.ts:sendNotification`; types in `packages/shared/src/types/notification.ts` + urgency + web `notification-type-config.ts` (exhaustive records). No generic action buttons → new web control for approval notifications.
- Decision delivery: `projectDataService.acceptPromptDelivery` with stable `deliveryId`; new source kind `operations_decision` (rule 79 audit of every source_kind branch).
- Superadmin: `requireSuperadmin()` + `requireActiveSettingsSuperadmin()` (`routes/admin-runtime-controls.ts` pattern).
- Action service functions: delete workspace `routes/workspaces/crud.ts:284` / `cleanupWorkspaceForDeletion`; delete node `routes/nodes/delete.ts` / `deleteNodeResources` + `completeOwnerNodeRemoval`; sleep `sleepWorkspaceSession`; cancel task `cancelTask`; retry snapshot = idle checkpoint `hibernateAgentSessionOnNode(background)`; rerun node cleanup = clear backoff + `handOffEmptyWorkspaceNode` (next sweep picks it up); restart vm-agent has no endpoint → new VM `POST /admin/restart-agent` (SIGTERM self; systemd `Restart=always`), old agents 404 → clear "unsupported" result.

## Implementation checklist

### A. Telemetry
- [ ] Migration: `node_lifecycle_decisions` (id, node_id, source, decision, reason, workspace_count, detail_json, created_at) + indexes
- [ ] `services/node-lifecycle-decisions.ts`: best-effort `recordNodeLifecycleDecision` (never throws; optional SQL dedupe window), `listNodeLifecycleDecisions`, `purgeNodeLifecycleDecisions`
- [ ] Write rows from NodeLifecycle DO transitions
- [ ] Write rows from cron `destroyNodeForCleanup` (attempted / destroyed+provider result / failed / skipped+reason deduped)
- [ ] Write rows from `handOffEmptyWorkspaceNode`
- [ ] `ops_why_is_node_alive` core: current state + last N decisions + plain verdict (no liveness-as-idleness)
- [ ] Migration: `node_log_captures` (id, node_id, trigger, status, r2_key, sources_json, entry_count, raw_bytes, stored_bytes, error, created_at, expires_at)
- [ ] `services/node-log-capture.ts`: bounded capture (agent, systemd, cloud-init), gzip to R2, index in D1; never throws, hard timeout
- [ ] Hook before provider delete in strict deletion (fresh-heartbeat gate, per-node dedupe)
- [ ] Hook on unhealthy transition in unhealthy sweep (parallel, after the loop)
- [ ] Retention purge (R2 + D1) for captures and decisions in a daily-gated cron step
- [ ] Admin settings: retention days, capture timeout, lines per source, max bytes, approval TTL, decision dedupe window
- [ ] `ops_get_node_log_capture` core: read + gunzip + bounded output
- [ ] Go: trace per phase (outcome, failed phase, bounded redacted error tail), keep stderr TAIL in capped buffers
- [ ] API: `/lifecycle-timings` accepts optional `chatSessionId`, `failedPhase`, `errorTail`; persists to `session_snapshot_traces` when identity matches; old payload still accepted
- [ ] Migration: `session_snapshot_traces`

### B. Actions (after PR1 contract)
- [ ] Migration: `operations_action_approvals`
- [ ] `services/operations-actions/*`: matrix, request, decide, execute (CAS approved → executed), per-action executors reusing existing services
- [ ] MCP tools `ops_request_action`, `ops_execute_action`, `ops_why_is_node_alive`, `ops_get_node_log_capture` registered via PR1's mechanism
- [ ] Notification type `operations_approval` (+ urgency + web config) and Approve/Deny control in the notification UI (phone-usable)
- [ ] Superadmin decision endpoint `POST /api/admin/operations/approvals/:id/decision`
- [ ] Decision delivered to requesting session via `acceptPromptDelivery` (`operations_decision` source kind; rule 79 audit)
- [ ] VM agent `POST /admin/restart-agent` + API caller with 404 → unsupported

### C. After PR2 merges
- [ ] Decision log as an `ops_timeline` source
- [ ] Captures listed in `ops_get_node`
- [ ] Snapshot traces in `ops_get_session_story`

### Docs
- [ ] Public docs: operations project tools page (actions, approvals, telemetry) under `apps/www/src/content/docs/docs/`

## Acceptance criteria
- [ ] Approvals on a real SQL engine: approve → execute once; second execute refused; denied/expired refused; target A ticket cannot run on B; other task refused; mode `read` refuses `act`; auto-safe matrix per action; each guard deleted once → attack test red
- [ ] Black box: teardown proceeds when node unreachable/slow (timeout); capture stored when reachable
- [ ] Decision log rows written on each lifecycle path through real triggers
- [ ] Go: step-trace tests + old-agent compatibility test
- [ ] Staging: one real node; decision rows + `ops_why_is_node_alive`; request → approve → `delete_workspace`; black box capture on teardown; snapshot trace on a sleep; VMs deleted

## References
- Rules: 47, 53, 54, 56 (providers), 62, 67, 79, 28, 31, 44
- Policy a35180d5 (raw diagnostics), 2b97aefc (phone-usable admin controls), 235ad923 (telemetry bounded)
