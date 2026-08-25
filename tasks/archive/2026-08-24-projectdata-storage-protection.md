# ProjectData storage-protection firebreak

## Problem

SAM's dogfooding ProjectData Durable Object hit Cloudflare's hard SQLite-backed
10 GB per-object ceiling on 2026-08-18. A manual purge of tool-call JSON payloads
reclaimed about 3.14 GB, but production telemetry on 2026-08-24 shows the same
object is growing back toward the wall. PR #1875 measures and classifies storage
pressure, but it does not automatically brake growth. PR #1873 is broader
sharding infrastructure and must not be landed wholesale.

Build one focused, independently shippable protection patch that automatically
reclaims low-value storage in bounded Durable Object alarm batches while
preserving high-value chat history.

## Research findings

- Current production D1 telemetry (read-only query on 2026-08-24) shows project
  `01KHRJGANBBWGDY1NZ0KVF0D4J` at `8,326,971,392` bytes / `10,000,000,000`
  bytes, status `warning`, with `last_alert_at` and `last_purge_at` still NULL.
- Observability D1 contains 102 `Exceeded the maximum database size.` errors in
  the last 7 days, all from August 18. The literal production message exists in
  addition to the `SQLITE_FULL` phrasing.
- The downloaded investigation report
  `.library/projectdata-do-storage-ceiling-status-2026-08-24.md/...` confirms
  the −3.14 GB drop was Raphaël's manual purge of tool-call JSON data, making
  `chat_messages.tool_metadata` / large tool payload JSON the dominant consumer.
- Current main already has `storage-safety.ts`, per-object `sql.databaseSize`
  telemetry, a superadmin emergency purge for `activity_events` /
  `acp_session_events`, and a 128 KiB write-path cap for new `tool_metadata`;
  it does not auto-reclaim legacy dominant tool payload rows under storage
  pressure.
- `measureAndPersistProjectDataStorage()` currently runs on every ProjectData
  alarm tick, even when the storage measurement interval is not due. Because
  ProjectData alarms are multiplexed with faster control loops, this causes more
  D1 telemetry writes than the configured interval implies.
- PR #1873's sharding draft uses the wrong PRAGMA sizing formula and can keep
  re-arming after DELETEs. It also has large-session `.toArray()` migration OOM
  risk and poison-candidate control-loop risk.
- Cloudflare DO storage quota must be measured with
  `ctx.storage.sql.databaseSize`; `DELETE` reclaims quota immediately because
  freelist pages are subtracted. Do not use `page_count * page_size`, `VACUUM`,
  or `auto_vacuum`.
- For Durable Object cleanup, use raw row access with bounded LIMIT/keyset
  batches across separate alarm calls. Fully consume cursors before any await;
  never materialize large sweeps with `.toArray()`.
- Independent review of PR #1901 found the first cleanup implementation was
  row-bounded but not byte-bounded: it selected full `tool_metadata` values and
  materialized up to 500 legacy payloads. Legacy individual payloads may be
  much larger than the write-path cap, so cleanup must bound bytes read into JS,
  not just candidate rows.
- The same review found poison-candidate risk: one cleanup candidate that throws
  during strip/update can prevent cursor advancement and leave a stale
  `storageSafetyToolCleanupRecheckAt`, making ProjectData alarms re-arm
  immediately.
- Safe cleanup target: terminal-session `tool_metadata.content` payloads.
  Stripping the heavy structured payload preserves the chat row, role, text
  content, tool identity/status, and `contentSize`; recent/active/sleeping
  history remains protected by a configurable age floor and terminal-status
  predicate.

## Implementation checklist

- [x] Add configurable automated storage-cleanup settings to the ProjectData Env
  surface and public/internal env references.
- [x] Add storage-safety helpers that decide when cleanup is due, persist cleanup
  cursors/stats in `do_meta`, and schedule cleanup rechecks separately from
  hourly measurement.
- [x] Implement one bounded keyset/LIMIT cleanup batch per alarm that strips
  `tool_metadata.content` from old terminal-session rows using raw cursor access.
- [x] Add a configurable cleanup byte budget so candidate selection reads only
  row identity plus `length(CAST(tool_metadata AS BLOB))`, then reads full
  legacy metadata only when it fits the remaining per-alarm byte budget.
- [x] Add fail-closed oversized/poison candidate handling that writes a small
  sentinel, records failure metadata, advances the cursor, and prevents stale
  due recheck alarms from hot-looping.
- [x] Fix alarm measurement gating so storage measurement runs only when due
  unless explicitly forced by an admin call.
- [x] Ensure the ProjectData alarm isolates storage measurement/cleanup failures
  from unrelated control-loop steps and recalculates the next alarm candidate.
- [x] Add scenario-driven Worker-runtime tests for due measurement gating,
  terminal-tool cleanup, active/sleeping preservation, bounded batches, cursor
  continuation, and telemetry/purge metadata.
- [x] Run focused local checks and specialist validation.
- [x] Create a focused draft/do-not-merge PR and wait for CI evidence; do not
  deploy to staging and do not merge.

## Acceptance criteria

- Automated cleanup begins when `sql.databaseSize / configured limit` reaches a
  configurable trigger ratio and stops when it reaches a configurable target
  ratio or candidate rows are exhausted.
- Cleanup processes at most one bounded batch per alarm call and continues via
  persisted keyset cursor/recheck alarm, not a long synchronous sweep.
- Cleanup is byte/memory-bounded for legacy metadata: it does not select or
  materialize full `tool_metadata` batches, and full metadata reads are capped
  by a configurable per-alarm byte budget.
- A single oversized or poison legacy row cannot stall the sweep; it is handled
  fail-closed with observability, cursor progress, and a sane future alarm.
- Cleanup uses raw row access and fully consumes the cursor before updates or
  awaits.
- Cleanup preserves active/sleeping sessions and recent terminal sessions by
  default, and it does not delete chat messages or user/assistant transcript
  text.
- Existing explicit emergency purge remains available.
- `measureIntervalMs` is honored even when unrelated ProjectData alarms fire
  more frequently.
- Tests prove the cleanup shrinks `tool_metadata`, preserves high-value rows,
  respects row and byte bounds, handles oversized/poison candidates, clears stale
  due rechecks, avoids alarm thrash, and records telemetry/purge metadata.

## Validation

- Draft/do-not-merge PR: <https://github.com/raphaeltm/simple-agent-manager/pull/1901>
- `needs-human-review` label added because spawned local review agents timed out
  before returning results. Manual local specialist checklists passed; do not
  merge until human review clears the label.
- `pnpm --filter @simple-agent-manager/shared build && pnpm --filter @simple-agent-manager/providers build && pnpm --filter @simple-agent-manager/cloud-init build`
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/durable-object-retry.test.ts`
- `pnpm --filter @simple-agent-manager/api typecheck`
- `pnpm --filter @simple-agent-manager/api build`
- `(cd apps/api && pnpm vitest run --config vitest.workers.config.ts tests/workers/project-data-storage-safety.test.ts --reporter verbose)` — 11 tests passed after adding byte-budget, oversized-row, poison-row, stale-recheck, and non-thrashing alarm coverage.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/durable-objects/project-data-messages.test.ts`
- `pnpm --filter @simple-agent-manager/api lint`
- `pnpm quality:file-sizes` — passed after extracting automated tool-payload
  cleanup candidate processing into `tool-payload-cleanup-candidates.ts`; no
  files exceed 800 lines.
- `pnpm quality:ast-checks` — passed after splitting the cleanup candidate
  query into static SQL branches; existing warnings remain unrelated.
- `pnpm lint` — passed with pre-existing warnings unrelated to this patch.
- `pnpm format:check` — Prettier format ratchet passed.
- `git diff --check HEAD`

## Specialist review notes

- Cloudflare/DO review: cleanup uses `ctx.storage.sql.databaseSize`, keeps
  alarm work isolated, uses bounded LIMIT/keyset batches over row identity plus
  metadata byte length, and persists a recheck cursor instead of running a long
  sweep.
- Data-loss review: automated cleanup strips only expandable
  `tool_metadata.content` from old terminal sessions; it preserves chat rows,
  message text, active/sleeping sessions, and recent terminal sessions by
  default.
- Constitution/env review: operational thresholds, limits, batch sizes, age
  floors, byte budgets, and recheck cadence are configurable via env vars and
  documented in Worker env types, examples, `wrangler.toml`, public docs, and
  `env-reference`.
- Test review: worker-runtime scenarios cover quota measurement, delete reclaim
  semantics, interval gating, bounded cleanup, cursor continuation,
  active/sleeping preservation, age-floor preservation, oversized and poison
  legacy metadata, stale recheck clearing, non-thrashing alarm scheduling, and
  telemetry metadata.
