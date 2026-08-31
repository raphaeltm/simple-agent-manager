# ProjectData pre-wall storage relief

## Problem statement

Production ProjectData storage is close to Cloudflare's hard SQLite-backed Durable
Object wall. At 2026-08-31 10:48 UTC the SAM ProjectData object was reported at
9,475,903,488 / 10,000,000,000 bytes (94.759%), with fitted growth of 175.9
MB/day and about 2.98 days to the wall.

Implement a focused, production-disabled-by-default pre-wall relief package that
preserves raw transcript/message text and session identity. Do not deploy to
staging, mutate production, change production configuration, or merge. Open a
draft PR and stop for coordinator/Fable review.

## Research findings

- SAM MCP task `01M1BQVX0SVVV9T1JPEZ3AVRAQ` sets the output branch to
  `sam/implement-projectdata-pre-wall-3avraq`.
- Referenced health report `/health-reports/health-report-2026-08-31.md` is not
  present in this checkout, but linked Idea `01M0YZNBKSKQZ47NC0K7M8N5AX`
  includes the health update: latest direct `sql.databaseSize` telemetry at
  2026-08-31 09:40:22Z was 9,468,043,264 bytes (94.680%), with 709 overload
  errors, 42 storage-timeout resets, and 22 exhausted session-detail loads in
  the report window.
- Existing main already contains the earlier tool-payload R2 archival path:
  `tool_payload_archives`, private `PROJECT_DATA_ARCHIVE_R2`, lazy
  `getMessageToolContent` archive fallback, and MCP
  `get_archived_tool_payloads`.
- Existing archival is bounded by row/byte/wall-time budgets, but per-slice
  cleanup telemetry does not yet expose a discriminating termination reason such
  as candidates-exhausted, byte-budget, row-budget, wall-time, or
  oversized-skip.
- Existing archival intentionally marks payload rows above
  `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES` as oversized and skips them.
  This leaves the legacy >1 MiB stock locked unless archival can write/read
  chunked private R2 objects without loading a whole legacy payload through an
  unbounded RPC.
- Existing `materializeSession()` writes `chat_messages_grouped` and external
  content FTS5 rows for stopped sessions, using raw `chat_messages` as the
  source of truth. Search combines FTS over materialized rows with a LIKE
  fallback over non-materialized sessions.
- There is no admin-only, cursor-resumable, strictly bounded measurement path
  for grouped/FTS stock and eligible-vs-oversized payload stock. Admin
  `POST /api/admin/project-data/storage/:projectId/measure` includes category
  breakdowns, but that must not become a default hot-object full scan.
- Removing old terminal-session grouped+FTS derived data can reclaim storage
  without deleting raw `chat_messages`, but external-content FTS5 maintenance
  must be explicit and search/materialization semantics must degrade
  deliberately to partial/unmaterialized search, not silently.
- FTS cleanup requires SQLite writes and is not wall-safe. At the wall, only
  existing proven pure-DELETE recovery paths may run.
- PR #1873 is an open draft sharding PR and is dirty against main; it remains a
  reference only and must not be merged or imported wholesale.
- Relevant prior task records include
  `tasks/active/2026-08-26-projectdata-tool-payload-r2-archival.md`,
  `tasks/archive/2026-08-24-projectdata-storage-protection.md`, and
  `tasks/active/2026-08-21-projectdata-storage-safety-firebreak.md`.

Every finding above is represented in the checklist below.

## Implementation checklist

- [ ] Move this task file to `tasks/active/` on the implementation branch.
- [ ] Add config-backed cleanup result telemetry with explicit termination
  reasons for candidates-exhausted, byte-budget, row-budget, wall-time, and
  oversized-skip; include rows examined, original bytes, stored bytes, and
  `sql.databaseSize` before/after reclaim truth.
- [ ] Add an admin-only, cursor-resumable, strictly bounded measurement RPC/API
  for `chat_messages_grouped`/external-content FTS stock and
  eligible-vs-oversized tool-payload stock, disabled from alarms/default
  measurement.
- [ ] Implement production-disabled canary/scaled cleanup for old terminal
  session grouped+FTS derived rows only; never delete raw `chat_messages`,
  comments, sessions, or anchored identities.
- [ ] Maintain external-content FTS5 correctly when deleting grouped rows and
  deliberately update materialization/search state to report partial degraded
  semantics.
- [ ] Add configurable circuit breakers for reset/overload/read regression/weak
  reclaim and hard kill-switch/config bounds.
- [ ] Make pre-wall/wall behavior explicit: FTS cleanup is write-required and
  not wall-safe; at the wall only existing pure-DELETE recovery paths are
  eligible.
- [ ] Extend legacy tool-payload archival so >1 MiB payloads can be archived via
  bounded/chunked private R2 while preserving archive-confirmed-before-delete
  and authenticated project-scoped retrieval; do not add a longer unbounded RPC.
- [ ] Update env references, public docs, and API/reference notes for new admin
  routes/config/state semantics.
- [ ] Add unit and Workers-runtime tests for raw transcript preservation,
  comments/anchored-message preservation, idempotent resume, FTS bookkeeping and
  search state, `databaseSize` reclaim assertion, oversized R2 failure leaving
  source intact, and kill-switch/config bounds.
- [ ] Run local quality gates and required specialist reviews:
  cloudflare-specialist, constitution-validator, env-validator,
  doc-sync-validator, security-auditor, test-engineer, and
  task-completion-validator.
- [ ] Open a draft PR on `sam/implement-projectdata-pre-wall-3avraq`, trigger
  label-based CodeRabbit review only after local readiness, and stop without
  staging, production mutation/config changes, merge, or production deploy
  monitoring.

## Acceptance criteria

- [ ] Cleanup telemetry can distinguish candidates-exhausted, byte-budget,
  row-budget, wall-time, oversized-skip, disabled, wall-unsafe, and circuit-breaker
  stops with rows examined and byte/reclaim accounting.
- [ ] Admin measurement is bounded, cursor-resumable, requires admin auth, and is
  never run by the default alarm measurement path.
- [ ] Grouped+FTS cleanup is disabled by default for production, canary/scaled by
  config, deletes only derived grouped/FTS rows for old terminal sessions, and
  preserves raw transcript text, sessions, and comments.
- [ ] External-content FTS5 is kept consistent with deleted grouped rows, and
  search/materialization results expose partial/degraded semantics rather than
  pretending full FTS coverage remains.
- [ ] FTS cleanup refuses to run when storage is at/over the configured wall-safe
  ratio; existing pure-DELETE emergency recovery remains the only wall-safe
  recovery path.
- [ ] Legacy >1 MiB tool payloads can be archived/retrieved with bounded chunks;
  failed R2 archival or missing chunks leave source `tool_metadata.content`
  intact.
- [ ] New thresholds, limits, cadence, kill-switches, chunk sizes, prefixes, and
  route limits are env/config-backed with documented defaults.
- [ ] Unit and Workers-runtime tests discriminate the safety properties listed in
  the user request.

## Validation evidence

To be filled during implementation.

## Specialist review tracker

Not started.

## PR / CI evidence

To be filled after draft PR creation.

## References

- SAM idea `01M0YZNBKSKQZ47NC0K7M8N5AX`
- PR #1873: <https://github.com/raphaeltm/simple-agent-manager/pull/1873>
- `.claude/rules/07-env-and-urls.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
- `.claude/rules/59-understand-before-adding.md`
