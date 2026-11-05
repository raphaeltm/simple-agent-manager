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

- [x] Ops-tool admin settings (thresholds, caps, retention days default 7) in one module, registered in the registry
- [x] Shared node diagnostics access service (owner | gated operator) + refactor `routes/nodes/diagnostics.ts` and `requireNodeOwnership` onto it
- [x] `ops_find_anomalies` service (7 classes, configurable thresholds, IDs + reason, per-class cap with disclosure)
- [x] `ops_list_nodes` / `ops_get_node` services
- [x] Entity resolver + `ops_get_session_story`
- [x] `ops_timeline` with pluggable sources + truncation disclosure (rule 65)
- [x] `ops_search_errors` (reuse `queryErrors`)
- [x] `ops_query_worker_logs` (shared operation extracted from admin route)
- [x] Node reach-in tools: `ops_node_logs` (contains filter + line/byte caps), `ops_node_system_info`, `ops_node_events`, `ops_node_containers`, `ops_workspace_agent_sessions`
- [x] `ops_capture_debug_package` (byte cap, capped streaming read, library `/debug-packages/<nodeId>/<ts>.tar.gz`) + daily purge
- [x] MCP tool definitions + handlers wired through PR1's `requireOperationsAccess` / `recordOperationsAudit`, untrusted text fenced
- [x] Playbook in `get_instructions` for the Operations project when mode is not off
- [x] Public docs for the tools
- [x] Tests: real-SQL anomaly tests (each class + healthy control), vertical slice MCP → gate → node proxy (mock node enforcing JWT contract), debug package → library → purge, tools/list + gate denial
- [ ] PR body: per-tool round-trip counts (rule 60)

## Acceptance criteria

- [x] Every ops tool rejects calls that fail the PR1 gate and records an audit row on success and failure
- [x] Anomaly sweep returns each class with IDs + reason, and nothing for a healthy fleet
- [x] Node reach-in uses the same service as the owner UI path
- [x] Debug package lands in the Operations library, is downloadable with `download_library_file`, and is purged after N days
- [x] Playbook appears only in the Operations project with mode not off
- [ ] Staging: anomalies, session story on a real task, node logs with `contains`, debug package capture + download on a real node; VM cleaned up

## Review fixes (replacement task 01M6GW24EQR0KP6M77YPHYY6R9, 2026-11-03)

Fresh Phase 5 review of 8 local reviewers on d826b6cbe. Fixed:
- [x] Quarantine anomaly lookup exceeded D1's 100-bind limit at opsAnomalyMaxPerClass > 100 → chunked (cloudflare HIGH)
- [x] Daily purge did ~300 D1 queries → bulk `deleteFiles` (services/file-library-delete.ts), batch 50/max 90 (performance HIGH)
- [x] debugPackageMaxBytes 20 MiB default / 32 MiB max for Worker memory headroom
- [x] Settings for every remaining cap: timeline default window, fan-out (default 2), entity-graph row cap, Worker log window, captures per hour; shared Worker-log rate-limit constants
- [x] Per-field untrusted fencing in ops_search_errors, ops_query_worker_logs, ops_timeline; neutralized lifecycle error and incident signature
- [x] Shared `anyIdIn` for platform_errors lookups
- [x] Capture rate limit per superadmin
- [x] Tests: route-level for every read tool, failed-after-gate audit, cross-project purge control, live timeline sources, get_instructions playbook, rate limit
- [x] Docs: env-reference skill, security architecture exception, admin-settings table
- [x] mcp-library-file-comments test logger mock (broken by PR2's import graph)

## Resume notes (durable copy of local /do state; the workspace has been restored from snapshots twice and lost untracked files)

- Phase 1–5 done. Phase 5 tracker (all ADDRESSED): task-completion-validator, security-auditor, cloudflare-specialist, test-engineer, constitution-validator, doc-sync-validator, architecture-reviewer, performance-reviewer, plus an independent cloudflare-specialist re-verify of the fixes. Deferred LOWs: `platform_errors.message` has no index (scan bounded by the timestamp window); tool-definitions-ops-read-tools.ts also holds node-tool definitions (naming nit).
- Local checks on 36ec614e9: api tsc + full lint clean; full api vitest 1019 files / 14,786 tests passed; `test:workers` too slow locally (CI runs it in 3 shards).
- Next: wait for PR1 #2501 `merged` → `git rebase origin/main` → push `HEAD:sam/operations-tools-pr2-3-4vtq8v` → Phase 6 staging (check no other staging run is active).
- Staging plan: staging CF_TOKEN cannot write KV, so drive real chats. Secrets only through exec_with_secrets (CF_TOKEN; read-only D1 helper: account c4e4aebd980b626f6af43ac6b1edcede, main D1 1cfaf5d4-8226-47d8-bf26-6ba727ce5718, observability D1 8c2fa46c-3b89-428b-b235-d835b7914106). Smoke user is superadmin. In the admin UI set the Operations (feedback) project to Test Project 1 (01KJNR9R3TEN3KX1ETE33852R8) and `operations.debuggerTools=read`; restore both afterwards. Start a chat in Test Project 1 with VM profile raph-cc-convo (01KVR2BJEFY19587NTWR5M6PQN) so it owns a real node, and have it call ops_find_anomalies, ops_get_session_story (its own task), ops_node_logs with contains, ops_capture_debug_package and download_library_file. Check operations_audit_log rows. Delete the VM afterwards.
- PR body: per-tool round-trip table (gate 1 D1 + audit 1 D1 + settings cached; anomalies ~10, list_nodes ~3, get_node ~7, session_story ~14, timeline ~15 with fan-out 2, search_errors ~3, worker_logs ~3, node_* ~4, workspace_agent_sessions ~5, capture ~9 + R2; purge ~6 per run), debug-package buffering rationale (library encrypts whole objects; capped streaming read), CodeRabbit evidence.
