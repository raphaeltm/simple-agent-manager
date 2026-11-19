# Operations tools PR3: approved actions + telemetry (decision log, black box, snapshot trace)

SAM task `01M6GN7PP650TXB7X9D7302085`, continued by `01M6GW2GNDQWT8T9CZPHGT7EFZ` after an account limit (Part B was rebuilt; branch rebased onto PR2). Idea `01M6GGY1QPGG4D40HG0PVGQS3R`. Orchestrator `01M6GGJJAYQBEZXX2E93C9Y4WW`.
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
- [x] Migration: `node_lifecycle_decisions` (id, node_id, source, decision, reason, workspace_count, detail_json, created_at) + indexes
- [x] `services/node-lifecycle-decisions.ts`: best-effort `recordNodeLifecycleDecision` (never throws; optional SQL dedupe window), `listNodeLifecycleDecisions`, `purgeNodeLifecycleDecisions`
- [x] Write rows from NodeLifecycle DO transitions
- [x] Write rows from cron `destroyNodeForCleanup` (attempted / destroyed+provider result / failed / skipped+reason deduped)
- [x] Write rows from `handOffEmptyWorkspaceNode`
- [x] `ops_why_is_node_alive` core: current state + last N decisions + plain verdict (no liveness-as-idleness)
- [x] Migration: `node_log_captures` (id, node_id, trigger, status, r2_key, sources_json, entry_count, raw_bytes, stored_bytes, error, created_at, expires_at)
- [x] `services/node-log-capture.ts`: bounded capture (agent, systemd, cloud-init), gzip to R2, index in D1; never throws, hard timeout
- [x] Hook before provider delete in strict deletion (fresh-heartbeat gate, per-node dedupe)
- [x] Hook on unhealthy transition in unhealthy sweep (parallel, after the loop)
- [x] Retention purge (R2 + D1) for captures and decisions in a daily-gated cron step
- [x] Admin settings: retention days, capture timeout, lines per source, max bytes, approval TTL, decision dedupe window
- [x] `ops_get_node_log_capture` core: read + gunzip + bounded output
- [x] Go: trace per phase (outcome, failed phase, bounded redacted error tail), keep stderr TAIL in capped buffers
- [x] API: `/lifecycle-timings` accepts optional `chatSessionId`, `failedPhase`, `errorTail`; persists to `session_snapshot_traces` when identity matches; old payload still accepted
- [x] Migration: `session_snapshot_traces`

### B. Actions (after PR1 contract)
- [x] Migration: `operations_action_approvals`
- [x] `services/operations-actions/*`: matrix, request, decide, execute (CAS approved → executed), per-action executors reusing existing services
- [x] MCP tools `ops_request_action`, `ops_execute_action`, `ops_why_is_node_alive`, `ops_get_node_log_capture` registered via PR1's mechanism
- [x] Notification type `operations_approval` (+ urgency + web config) and Approve/Deny control in the notification UI (phone-usable)
- [x] Superadmin decision endpoint `POST /api/admin/operations/approvals/:id/decision` (+ list/get)
- [x] Decision delivered to requesting session via `acceptPromptDelivery` (`operations_decision` source kind; rule 79 audit)
- [x] VM agent `POST /admin/restart-agent` + API caller with 404 → unsupported

### C. After PR2 merges
- [x] Decision log as an `ops_timeline` source
- [x] Captures listed in `ops_get_node`
- [x] Snapshot traces in `ops_get_session_story`

### Docs
- [x] Public docs: operations project tools page (actions, approvals, telemetry) under `apps/www/src/content/docs/docs/`

## Acceptance criteria
- [x] Approvals on a real SQL engine: approve → execute once; second execute refused; denied/expired refused; target A ticket cannot run on B; other task refused; mode `read` refuses `act`; auto-safe matrix per action; each guard deleted once → attack test red
- [x] Black box: teardown proceeds when node unreachable/slow (timeout); capture stored when reachable
- [x] Decision log rows written on each lifecycle path through real triggers
- [x] Go: step-trace tests + old-agent compatibility test
- [x] Staging (run 41775976216, head 2d203fbee, after PR2 merged): one real node; decision rows + `ops_why_is_node_alive`; request → approve (375px UI) → execute for sleep_session (trace recorded), live `delete_workspace`, `delete_node` (black box teardown capture, 896 entries); replay and denial refused; audit rows for every step; VM deleted and settings restored. Findings filed as ideas 01M6JHVHYK2EKF80SJDAHQ2K65 and 01M6JHVR7HB8SER6NKVEZRTJA1.

## References
- Rules: 47, 53, 54, 56 (providers), 62, 67, 79, 28, 31, 44
- Policy a35180d5 (raw diagnostics), 2b97aefc (phone-usable admin controls), 235ad923 (telemetry bounded)


## Implementation notes (continuation, 2026-11-03)

- Approval UI: the notification deep-links to **Admin → Approvals** (`/admin/approvals?approval=<id>`), which holds the single Approve/Deny control (rule 24: one control per operation; policy 2b97aefc: phone-usable admin UI).
- Execute accepts the requesting task or its session-recovery successor: the CAS compares `requesting_authority_task_id` (`recovery_source_task_id ?? id`, the codebase's stable source-task authority) because waking a sleeping session mints a successor task with a new MCP token.
- Decision prompt: source kind `operations_decision`, `sourceTaskId` = authority task; added to `sourceTaskGuardForClaim` (wake only while the task is live) and the expiring sleeping-wake list. Rule 79 audit of negative-form predicates over `PROMPT_DELIVERY_SOURCES`: `prompt-attachments.ts` (`!== 'user_followup'`, attachments only — unaffected), `invalidParentWakeTargetResult` (`!== 'parent_wakeup'` — unaffected), `invalidProjectEventWakeSourceTaskResult` (unaffected), `sourceTaskGuardForClaim` (now guarded). `NOTIFICATION_TYPES`: exhaustive records updated (urgency, web config, settings labels); `ATTENTION_TYPES` allowlist includes it.
- `deleteOwnedNode` extracted from `routes/nodes/delete.ts` so the owner route and `delete_node` share one teardown path.
- Guard-deletion proof (each conjunct neutered alone; exactly these tests went red):
  - claim `status = 'approved'` → single execute, concurrent executes, re-open-after-execute
  - claim `expires_at > ?` → expired approval
  - claim `action = ?` → other action on the same target
  - claim `target_id = ?` → target A ticket against B
  - claim `requesting_project_id = ?` → project mismatch
  - claim `requesting_authority_task_id = ?` → ticket from another task
  - decide `status = 'pending'` → re-open an executed approval (first attempt was non-discriminating: a deny also moves `expires_at`, so the expiry conjunct masked it; the re-open test fixes that)
  - decide `expires_at > ?` → approve an expired request
- Bug found by the telemetry-source test: the capture source selected `trigger` (column is `capture_trigger`).

## Reconciliation (2026-11-09 weekly queue sweep)

- Shipped: #2502 merged 2026-11-04.
- Production deploy run on `e727f0259` (2026-11-09 01:29 UTC) succeeded and contains this merge, so the change is live.
- Moved from `tasks/active/` to `tasks/archive/` by the weekly reconciliation.
