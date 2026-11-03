# Operations tools PR2 of 3: Eyes (read-only fleet X-ray, node reach-in, debug packages, playbook)

SAM task `01M6GN71RFTRF84W5RY24VTQ8V`. Orchestrator `01M6GGJJAYQBEZXX2E93C9Y4WW`. Idea `01M6GGY1QPGG4D40HG0PVGQS3R`.
Policy `a35180d5` (amended 2026-11-03): raw node diagnostics only behind switch + Operations project + task token + current superadmin, audited, 7-day retention.
Merge order: PR1 (foundations, gate) → **PR2 (this)** → PR3 (actions + telemetry). Channel `feature.operations-tools`.

## Problem

Debugging agents in the Operations project guess because node diagnostics are owner-only, evidence is split across ~8 stores, and there is no MCP surface for installation-wide reads. This PR adds the read-only "eyes": anomaly sweep, node/session/timeline views, error and Worker-log search, live node reach-in, debug packages into the Operations library, and a playbook in `get_instructions`.

## Research findings

- Node diagnostics routes: `apps/api/src/routes/nodes/diagnostics.ts` use `requireNodeOwnership` (`middleware/node-auth.ts`) then `services/node-agent-diagnostics.ts` / `node-agent.ts` (`nodeAgentRequest`, `nodeAgentRawRequest`, `listNodeEventsOnNode`, `listAgentSessionsOnNode`). VM agent validates only audience/node/workspace on the management JWT (`packages/vm-agent/internal/auth/jwt.go:240`), not the subject, so the operator path can sign with the actor's user ID.
- VM `/logs` accepts `source, level, container, since, until, search, cursor, limit` (`packages/vm-agent/internal/server/logs.go:169`); `search` is a case-insensitive substring filter applied after the page is read.
- Debug package: VM `GET /debug-package`, no redaction, no byte cap.
- Library: `services/file-library.ts uploadFile()` encrypts the whole object (AES-GCM) before `R2.put`; `download_library_file` decrypts the whole object. Streaming straight to R2 would need a new chunked format, so capture uses a byte-capped streaming read (aborts the moment the cap is exceeded) and then encrypts. Upload max `LIBRARY_UPLOAD_MAX_BYTES` (50 MB) is a second ceiling.
- Admin settings registry (`services/admin-settings-*-definitions.ts`, `resolveAdminSetting`) is the home for tunables (policy 9017df94). Modules own their settings list (pattern: `agent-email/setting-definitions.ts`).
- Thresholds reuse the cleanup sweep's own config (`scheduled/node-cleanup/config.ts resolveCleanupConfig`: warm grace) and `services/node-health.ts deriveNodeHealth` so an anomaly means "the reaper should already have handled this" (rule 58/74).
- Deletion quarantine lives in NodeLifecycle DO storage; every dead-letter writes a `platform_errors` row "Workspace deletion entered durable operator quarantine" (`durable-objects/node-lifecycle-workspace-deletion.ts:769`) — the cheap SQL signal.
- Pending incidents: `platform_feedback_triages.queue_state = 'pending'`.
- Snapshot failures: `session_snapshots.sleep_status IN ('failed','terminal_failed')`, `recovery_status='failed'`, `status='failed'`, `capture_error IS NOT NULL`.
- Timestamps are mixed (`CURRENT_TIMESTAMP` vs ISO); compare via `julianday()`.
- Readers that already exist: `getSession`, `getSessionState`, `listAcpSessions`, `listActivityEvents` (`services/project-data.ts`), `getBootLogs` (`services/boot-log.ts`), NodeLifecycle `getStatus`/`getWorkspaceDeletionAttemptState`, `queryErrors` (`services/observability-errors.ts`), `queryCloudflareLogs` (`services/observability-logs.ts`), `listNodeHealthEvents`.
- Admin Workers log route (`routes/admin/observability.ts POST /logs/query`) holds its validation inline → extract a shared operation used by both surfaces (policy 5cb362e8).
- Untrusted text envelope: `operations/untrusted-text.ts` (`untrustedTextBlock`, `neutralizeUntrustedText`, `UNTRUSTED_TEXT_GUIDANCE`).
- Daily cron `0 3 * * *` branch in `scheduled/handler.ts` hosts the debug-package purge (policy b0950dd6: daily cleanup).

## Implementation checklist

- [ ] Ops-tool admin settings (thresholds, caps, retention days default 7) in one module, registered in the registry
- [ ] Shared node diagnostics access service (owner | gated operator) + refactor `routes/nodes/diagnostics.ts` and `requireNodeOwnership` onto it
- [ ] `ops_find_anomalies` service (7 classes, configurable thresholds, IDs + reason, per-class cap with disclosure)
- [ ] `ops_list_nodes` / `ops_get_node` services
- [ ] Entity resolver + `ops_get_session_story`
- [ ] `ops_timeline` with pluggable sources + truncation disclosure (rule 65)
- [ ] `ops_search_errors` (reuse `queryErrors`)
- [ ] `ops_query_worker_logs` (shared operation extracted from admin route)
- [ ] Node reach-in tools: `ops_node_logs` (contains filter + line/byte caps), `ops_node_system_info`, `ops_node_events`, `ops_node_containers`, `ops_workspace_agent_sessions`
- [ ] `ops_capture_debug_package` (byte cap, capped streaming read, library `/debug-packages/<nodeId>/<ts>.tar.gz`) + daily purge
- [ ] MCP tool definitions + handlers wired through PR1's `requireOperationsAccess` / `recordOperationsAudit`, untrusted text fenced
- [ ] Playbook in `get_instructions` for the Operations project when mode is not off
- [ ] Public docs for the tools
- [ ] Tests: real-SQL anomaly tests (each class + healthy control), vertical slice MCP → gate → node proxy (mock node enforcing JWT contract), debug package → library → purge, tools/list + gate denial
- [ ] PR body: per-tool round-trip counts (rule 60)

## Acceptance criteria

- [ ] Every ops tool rejects calls that fail the PR1 gate and records an audit row on success and failure
- [ ] Anomaly sweep returns each class with IDs + reason, and nothing for a healthy fleet
- [ ] Node reach-in uses the same service as the owner UI path
- [ ] Debug package lands in the Operations library, is downloadable with `download_library_file`, and is purged after N days
- [ ] Playbook appears only in the Operations project with mode not off
- [ ] Staging: anomalies, session story on a real task, node logs with `contains`, debug package capture + download on a real node; VM cleaned up
