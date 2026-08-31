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

- [x] Move this task file to `tasks/active/` on the implementation branch.
- [x] Add config-backed cleanup result telemetry with explicit termination
  reasons for candidates-exhausted, byte-budget, row-budget, wall-time, and
  oversized-skip; include rows examined, original bytes, stored bytes, and
  `sql.databaseSize` before/after reclaim truth.
- [x] Add an admin-only, cursor-resumable, strictly bounded measurement RPC/API
  for `chat_messages_grouped`/external-content FTS stock and
  eligible-vs-oversized tool-payload stock, disabled from alarms/default
  measurement.
- [x] Implement production-disabled canary/scaled cleanup for old terminal
  session grouped+FTS derived rows only; never delete raw `chat_messages`,
  comments, sessions, or anchored identities.
- [x] Maintain external-content FTS5 correctly when deleting grouped rows and
  deliberately update materialization/search state to report partial degraded
  semantics.
- [x] Add configurable circuit breakers for reset/overload/read regression/weak
  reclaim and hard kill-switch/config bounds.
- [x] Make pre-wall/wall behavior explicit: FTS cleanup is write-required and
  not wall-safe; at the wall only existing pure-DELETE recovery paths are
  eligible.
- [x] Extend legacy tool-payload archival so >1 MiB payloads can be archived via
  bounded/chunked private R2 while preserving archive-confirmed-before-delete
  and authenticated project-scoped retrieval; do not add a longer unbounded RPC.
- [x] Update env references, public docs, and API/reference notes for new admin
  routes/config/state semantics.
- [x] Add unit and Workers-runtime tests for raw transcript preservation,
  comments/anchored-message preservation, idempotent resume, FTS bookkeeping and
  search state, `databaseSize` reclaim assertion, oversized R2 failure leaving
  source intact, and kill-switch/config bounds.
- [x] Run local quality gates and required specialist reviews:
  cloudflare-specialist, constitution-validator, env-validator,
  doc-sync-validator, security-auditor, test-engineer, and
  task-completion-validator.
- [x] Open a draft PR on `sam/implement-projectdata-pre-wall-3avraq`, trigger
  label-based CodeRabbit review only after local readiness, and stop without
  staging, production mutation/config changes, merge, or production deploy
  monitoring.

## Acceptance criteria

- [x] Cleanup telemetry can distinguish candidates-exhausted, byte-budget,
  row-budget, wall-time, oversized-skip, disabled, wall-unsafe, and circuit-breaker
  stops with rows examined and byte/reclaim accounting.
- [x] Admin measurement is bounded, cursor-resumable, requires admin auth, and is
  never run by the default alarm measurement path.
- [x] Grouped+FTS cleanup is disabled by default for production, canary/scaled by
  config, deletes only derived grouped/FTS rows for old terminal sessions, and
  preserves raw transcript text, sessions, and comments.
- [x] External-content FTS5 is kept consistent with deleted grouped rows, and
  search/materialization results expose partial/degraded semantics rather than
  pretending full FTS coverage remains.
- [x] FTS cleanup refuses to run when storage is at/over the configured wall-safe
  ratio; existing pure-DELETE emergency recovery remains the only wall-safe
  recovery path.
- [x] Legacy >1 MiB tool payloads can be archived/retrieved with bounded chunks;
  failed R2 archival or missing chunks leave source `tool_metadata.content`
  intact.
- [x] New thresholds, limits, cadence, kill-switches, chunk sizes, prefixes, and
  route limits are env/config-backed with documented defaults.
- [x] Unit and Workers-runtime tests discriminate the safety properties listed in
  the user request.

## Validation evidence

- `pnpm install` — pass.
- `pnpm lint` — pass with pre-existing unrelated warnings in `packages/acp-client`
  and `apps/web` components.
- `pnpm typecheck` — pass; existing Astro content validation output remains
  baseline and exits 0.
- `pnpm --filter @simple-agent-manager/api typecheck` — pass.
- `pnpm --filter @simple-agent-manager/api lint` — pass.
- `pnpm --filter @simple-agent-manager/api build` — pass.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/durable-objects/project-data-tool-payload-archive.test.ts --reporter dot` — pass, 2 tests.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/durable-objects/migrations.test.ts --reporter dot` — pass, 16 tests.
- `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/project-data-tool-payload-archive.test.ts --reporter dot` — pass, 12 tests; workerd emitted an existing stream-pump cancellation diagnostic after completion.
- `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/project-data-storage-safety.test.ts --reporter dot` — pass, 16 tests.
- `pnpm --filter @simple-agent-manager/api test -- --reporter dot` — broad API unit/integration sweep ran 641/642 files and 8668/8669 tests green, then failed only the migration index-count assertion introduced by this PR. The assertion was updated and the targeted migration test passed afterward.
- `git diff --check` — pass.

No staging deploy, production mutation, production configuration change, merge,
or production monitoring command was run.

## Specialist review tracker

- `cloudflare-specialist`: pass. D1/DO schema change is additive; alarm work is
  bounded by configured rows/bytes/wall time; grouped+FTS cleanup is disabled by
  default and refuses wall-unsafe writes; `databaseSize` before/after is the
  reclaim truth.
- `constitution-validator`: pass. New limits, ratios, batch sizes, chunk sizes,
  cadences, and kill switches are config/env backed and documented; remaining
  literals are named local protocol defaults/constants.
- `env-validator` / `env-reference`: pass. `Env` interfaces, `wrangler.toml`,
  `.env.example`, deployment config sync allowlist, and env reference docs are
  synchronized. Grouped+FTS cleanup defaults to disabled.
- `doc-sync-validator`: pass. Public configuration docs and API reference cover
  the new admin routes and config/state semantics.
- `security-auditor`: pass. New HTTP entry points are admin-mounted; private R2
  archival uses deterministic project/session/message scoped keys and
  authenticated ProjectData retrieval; source payload remains intact until R2
  archive writes and SQL bookkeeping succeed.
- `test-engineer`: pass. Unit and real Workers-runtime tests cover raw
  transcript preservation, comments/anchors, idempotent resume, FTS bookkeeping,
  search degradation state, `databaseSize` reclaim, R2 failure/source
  preservation, and kill-switch/config bounds.
- `task-completion-validator`: pass. Acceptance criteria are represented in the
  diff and validated locally. Remaining PR-only steps are draft PR creation and
  CodeRabbit trigger.

## PR / CI evidence

- Draft PR: <https://github.com/raphaeltm/simple-agent-manager/pull/1978>
- CodeRabbit review trigger: `coderabbit-review` label applied after local
  validation and draft PR creation.
- Branch pushed: `sam/implement-projectdata-pre-wall-3avraq`.
- Stop condition honored: draft PR opened; no staging/prod deploy, production
  mutation, production config change, or merge.

## References

- SAM idea `01M0YZNBKSKQZ47NC0K7M8N5AX`
- PR #1873: <https://github.com/raphaeltm/simple-agent-manager/pull/1873>
- `.claude/rules/07-env-and-urls.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
- `.claude/rules/59-understand-before-adding.md`
