# ProjectData storage-safety firebreak

## Problem statement

Production evidence from idea `01M0B8HBA4YRJFF8STQ8PMJ1D8` strongly infers that at least one `ProjectData` SQLite-backed Durable Object is near Cloudflare's 10 GB per-object ceiling. Current `main` does not directly measure per-object `databaseSize`, does not classify storage-exhaustion failures distinctly, and lets high-volume message/tool metadata continue growing without a byte-oriented at-rest cap.

The goal is a narrow production-safe firebreak, not full sharding:

- measure and persist per-object `databaseSize` from inside each `ProjectData` object;
- expose operator diagnostics and alert rows before the ceiling becomes an outage;
- classify `SQLITE_FULL`/storage-limit errors separately from transient DO reset/retry conditions;
- provide a bounded emergency, fail-visible recovery path that only deletes low-value telemetry;
- cap or trim unbounded tool metadata at the write path if that can be done safely without R2/spill infrastructure.

## Constraints

- Base branch: current `main`; implementation branch/PR: `sam/implement-narrow-projectdata-storage-f3f5s3`.
- Preserve PR #1873 as DO NOT MERGE. Do not modify, supersede, close, merge, or otherwise disturb it.
- Do not deploy or mutate staging. Do not merge. Stop after draft PR + CI evidence until the parent grants the staging slot.
- Use official Cloudflare documentation and repository evidence.
- Run focused local/Miniflare experiments for storage-full catchability, deletion reclamation, and alarm execution behavior.
- Follow D1/DO migration safety, control-loop bounding/isolation, configurable defaults, documentation sync, and specialist review gates.

## Research findings

- Cloudflare Durable Object docs currently state that SQLite-backed Durable Objects have a 10 GB per-object storage limit on Workers Paid, 2 MB maximum row/string/blob size, 100 KB SQL statement length, and `database or disk is full: SQLITE_FULL` when writes exceed the storage limit. Docs also state reads and deletes continue to work at the limit.
- Cloudflare SQLite storage docs expose `ctx.storage.sql.databaseSize` as the current SQLite database size in bytes.
- workerd source currently computes `databaseSize` as `(pragma_page_count - pragma_freelist_count) * page_size`, so deleted pages are subtracted from the measured quota.
- Cloudflare alarm docs state each DO has one alarm, alarms are at-least-once, and uncaught alarm errors only get a finite retry series. Any new storage-safety alarm step must catch its own failures and leave unrelated alarm candidates working.
- Existing ProjectData alarm scheduling is centralized in `apps/api/src/durable-objects/project-data/alarm-schedule.ts:computeProjectDataAlarmTime`, and `ProjectData.alarm()` already multiplexes heartbeat, idle cleanup, reconciliation, attention, mailbox, prompt delivery, and task waits.
- `services/project-data.ts` wraps some ProjectData RPCs with retry logic via `durable-object-retry.ts`, whose current transient reset regex would classify a generic "Durable Object reset" as retryable but does not distinguish storage-full causes.
- `messages.ts` currently bounds only by `MAX_MESSAGES_PER_SESSION` row count. It stores `content` and `tool_metadata` raw. `persistMessageBatch()` parses persisted `tool_metadata` for broadcast, so trimming must preserve valid JSON.
- VM agent reporter already caps message content via `MSG_MAX_MESSAGE_CONTENT_BYTES`, but `ToolMetadata` remains bounded only indirectly by batch transport size.
- Existing D1 session-index migration `0117_session_index_per_project.sql` is the closest pattern for an additive per-project diagnostic table keyed to `projects(id)`.

## Implementation checklist

- [x] Add D1 migration and Drizzle schema for per-project ProjectData storage telemetry.
- [x] Add ProjectData storage-safety config with env-backed defaults for measurement cadence, SQLite limit bytes, warning/critical/degrade ratios, alert throttle, emergency purge watermark, and tool-metadata trim size.
- [x] Add a ProjectData storage-safety module that reads `sql.databaseSize`, computes status/watermark state, upserts the D1 telemetry row, logs structured diagnostics, and persists critical/degraded `platform_errors` rows without letting observability failures abort alarms.
- [x] Wire storage-safety measurement into the shared ProjectData alarm schedule and into `ProjectData.alarm()` as an isolated step.
- [x] Add admin diagnostic endpoints that list/query ProjectData storage telemetry, force-measure one project, and run bounded emergency purge for superadmins.
- [x] Add explicit `SQLITE_FULL` / storage-limit classification, keep it non-transient, and return a distinct fail-visible service error from ProjectData retry/write call sites.
- [x] Add a bounded emergency recovery RPC/path that deletes oldest low-value telemetry rows (`activity_events`, `acp_session_events`) in capped batches until below the configured recovery watermark or the configured batch bound, and records the result in telemetry.
- [x] Add safe write-path trimming for oversized `tool_metadata` content arrays, preserving metadata/card-critical fields and storing a truncation marker rather than invalid JSON.
- [x] Run focused local/Miniflare experiments for catchability, deletion reclamation, and alarm behavior; record evidence in this file.
- [x] Add focused unit/workers tests for classifier, telemetry upsert, alarm execution, emergency purge, and metadata trimming.
- [x] Update documentation/config references.
- [ ] Run local specialist reviews: cloudflare-specialist, constitution-validator, test-engineer, doc-sync-validator, security-auditor, task-completion-validator.
- [ ] Open a draft PR and let CI run. Stop before staging/deploy/merge.

## Acceptance criteria

- Operators can query the latest per-project ProjectData DO size and status from D1/admin diagnostics without relying on Cloudflare namespace-level analytics.
- ProjectData alarms periodically self-measure `sql.databaseSize` with bounded local work and persist/log threshold crossings.
- Storage-full errors are classified distinctly, not retried as generic transient DO resets, and callers receive a clear ProjectData-storage-full error rather than an opaque internal reset storm.
- An explicit superadmin/admin recovery path can delete only low-value telemetry in bounded batches and reports exact rows/bytes/status; it does not delete transcripts, knowledge, policies, session state, or mailbox prompts.
- Oversized tool metadata is bounded at the ProjectData write path without breaking lazy-load/read contracts or storing malformed JSON.
- New limits/time intervals use env-backed defaults and are documented.
- Local Miniflare/workerd experiments are recorded for catchability, deletion reclamation, and alarms.
- Focused tests and relevant quality gates pass locally; CI is allowed to run on a draft PR.

## Experiment evidence

- `databaseSize` reclamation: `pnpm vitest run --config vitest.workers.config.ts tests/workers/project-data-storage-safety.test.ts --reporter verbose` inserted ~384 KiB into a scratch DO SQLite table, then deleted it. `sql.databaseSize` increased after inserts and dropped after delete in the workerd/Miniflare runtime.
- Exact local `SQLITE_FULL` forcing: the same Worker-runtime test proved direct `PRAGMA page_count` is rejected with `SQLITE_AUTH`, and `state.storage.sql.setMaxPageCountForTest` is not exposed in the JS Workers test runtime. Therefore the implementation does not rely on an in-DO `SQLITE_FULL` catch hook for automatic recovery. It classifies `SQLITE_FULL` at the service boundary and exposes explicit admin recovery.
- Storage write-error catchability: the same test inserted an oversized row to trigger a SqlStorage write-limit exception inside the DO, caught it, then successfully read and deleted from the table afterward. This proves storage write exceptions do not necessarily reset the actor and that reads/deletes can continue after a caught write failure.
- Alarm behavior: the same test invoked `ProjectData.alarm()` in the Worker runtime, verified a D1 `project_data_storage_telemetry` row with `last_alarm_at`, and verified the ProjectData alarm was rescheduled for the next storage measurement interval.
- Emergency purge: the same test inserted activity and ACP event rows, ran one bounded purge batch (`batchRows=2`, `maxBatches=1`), verified only two oldest rows per low-value table were removed, verified chat messages remained, and verified D1 telemetry recorded `last_purge_rows=4`.

## Specialist review tracker

- cloudflare-specialist: PENDING
- constitution-validator: PENDING
- test-engineer: PENDING
- doc-sync-validator: PENDING
- security-auditor: PENDING
- task-completion-validator: PENDING
