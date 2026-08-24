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
- PR #1875 adds `storage-safety.ts`, per-object `sql.databaseSize` telemetry,
  a superadmin emergency purge for `activity_events` / `acp_session_events`, and
  a 128 KiB write-path cap for new `tool_metadata`; it does not auto-reclaim or
  shed writes at warning/critical pressure.
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
- [x] Fix alarm measurement gating so storage measurement runs only when due
  unless explicitly forced by an admin call.
- [x] Ensure the ProjectData alarm isolates storage measurement/cleanup failures
  from unrelated control-loop steps and recalculates the next alarm candidate.
- [x] Add scenario-driven Worker-runtime tests for due measurement gating,
  terminal-tool cleanup, active/sleeping preservation, bounded batches, cursor
  continuation, and telemetry/purge metadata.
- [ ] Run focused local checks and specialist validation.
- [ ] Create a focused draft/do-not-merge PR and wait for CI evidence; do not
  deploy to staging and do not merge.

## Acceptance criteria

- Automated cleanup begins when `sql.databaseSize / configured limit` reaches a
  configurable trigger ratio and stops when it reaches a configurable target
  ratio or candidate rows are exhausted.
- Cleanup processes at most one bounded batch per alarm call and continues via
  persisted keyset cursor/recheck alarm, not a long synchronous sweep.
- Cleanup uses raw row access and fully consumes the cursor before updates or
  awaits.
- Cleanup preserves active/sleeping sessions and recent terminal sessions by
  default, and it does not delete chat messages or user/assistant transcript
  text.
- Existing explicit emergency purge remains available.
- `measureIntervalMs` is honored even when unrelated ProjectData alarms fire
  more frequently.
- Tests prove the cleanup shrinks `tool_metadata`, preserves high-value rows,
  respects batch bounds, and records telemetry/purge metadata.
