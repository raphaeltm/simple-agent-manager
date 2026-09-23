# ProjectData retention convergence under storage pressure

## Problem statement

The production ProjectData Durable Object for project
`01KHRJGANBBWGDY1NZ0KVF0D4J` is at roughly 8.85 GB of the configured 10 GB
limit, growing at about 291 MB/day, and telemetry reports
`cleanup_health='target_unreachable'`. When this object previously reached the
hard Cloudflare SQLite-backed Durable Object size wall on 2026-08-18, platform
writes broke with Cloudflare's `Exceeded the maximum database size.` error.

Retention must actually converge without wedging the hot Durable Object. Message
text must never be deleted. Tool-call JSON older than the configured retention
floor may be removed from `chat_messages.tool_metadata` only after successful R2
archive, and archived payloads must remain retrievable through the existing MCP
path.

## Pre-change diagnosis

- The PR #1933 retention job did fire after deploy. D1
  `project_data_storage_telemetry` history for
  `01KHRJGANBBWGDY1NZ0KVF0D4J` shows cleanup/continuation cadence from
  2026-08-26T19:44Z through 2026-08-27T02:53Z, with
  `last_purge_reason='auto_tool_payload_archive_cleanup'` and
  `last_purge_rows=26` at 2026-08-27T02:52:57Z.
- It did not outpace growth. From the first post-deploy history row to the
  latest row examined during diagnosis, `databaseSize` grew from about 8.799 GB
  to 8.847 GB (+47.7 MB net). Observed negative deltas totaled only about
  8.36 MB while positive deltas totaled about 56.1 MB.
- The object did show storage-maintenance pressure. Observability logs include
  `Durable Object storage operation exceeded timeout which caused object to be
  reset.` at 2026-08-26T19:46:49Z and overload messages around the same minute.
- The cleanup selector scanned old tool rows with
  `role='tool' AND tool_metadata LIKE '%"content"%' AND created_at < cutoff`,
  but the Durable Object schema only has session-oriented chat-message indexes.
  There is no cleanup-oriented index for role/tool metadata age ordering.
- The latest row has `category_breakdown_json=NULL` because the shipped alarm
  path intentionally disables category scans on hot alarm execution. Forcing the
  existing admin category measurement on this object would run broad aggregation
  work on the overloaded Durable Object, so the safe pre-change breakdown is the
  already-recorded idea evidence from 2026-08-26: message content about
  3.24 GB, tool metadata about 630 MB, and unattributed SQLite/index overhead
  about 4.87 GB. The protected text plus overhead means sharding may still be
  required later if all eligible archived tool metadata is insufficient, but
  sharding is out of scope for this task.

## Implementation checklist

- [x] Avoid a large hot-object `chat_messages` index build; switch candidate
  discovery to session-major keyset scans that reuse the existing
  `idx_chat_messages_session_seq` index.
- [x] Add durable candidate attempt/skip state so no-content, oversized, poison,
  and retry-deferred rows escape repeated sweeps without deleting message text or
  unarchived payloads.
- [x] Keep archive-then-delete fail closed: if R2 archive or archive-table
  bookkeeping fails, the original payload remains in `chat_messages`.
- [x] Keep cleanup bounded by configurable row, byte, wall-time, retry, timeout,
  and cadence defaults.
- [x] Avoid long synchronous purge loops; process one bounded cleanup slice per
  alarm and re-arm for continuation.
- [x] Use `sql.databaseSize` for quota measurement only.
- [x] Add regression tests for pacing/bounds.
- [x] Add regression tests for fail-closed archive-then-delete behavior.
- [x] Add the two-sweep candidate-escape regression.
- [x] Add a discriminating control proving recent/ineligible payloads are never
  purged.
- [x] Add a deferred-retry carry-forward regression so retry-deferred rows are
  not skipped after later candidates are archived.
- [x] Run local verification.
- [x] Run specialist reviews.
- [ ] Verify on staging.
- [ ] Deploy to production and monitor at least two cleanup cycles.

## Local verification

- `pnpm vitest run --config vitest.workers.config.ts tests/workers/project-data-tool-payload-archive.test.ts --reporter=verbose` — 10 passed.
- `pnpm vitest run --config vitest.workers.config.ts tests/workers/project-data-storage-safety.test.ts --reporter=verbose` — 14 passed.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/durable-objects/project-data-tool-payload-archive.test.ts --reporter=verbose` — 2 passed.
- `pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `pnpm --filter @simple-agent-manager/api lint` — passed.
- `pnpm quality:do-migration-safety` — passed.
- `pnpm quality:migration-safety` — passed.
- `pnpm quality:wrangler-bindings` — passed.
- `pnpm quality:file-sizes` — passed.
- `pnpm quality:ast-checks` — exited 0 with existing warnings.
- `pnpm format:check` — passed.
- `git diff --check` — passed.

## Review results

- `test-engineer` / `task-completion-validator`: PASS. Required regressions are present for pacing/bounds, archive-then-delete fail-closed behavior, two-sweep candidate escape, recent/ineligible controls, deferred-retry carry-forward, and MCP retrieval.
- `cloudflare-specialist`: PASS. No blocking DO/R2/storage findings. Non-blocking note addressed by documenting `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_SESSIONS_PER_ALARM` as deprecated compatibility only; active archival cleanup is bounded by rows, bytes, write timeout/retry delay, and wall time.
- `env-validator` / `doc-sync-validator` / `constitution-validator`: PASS. New knobs are optional Worker vars with `DEFAULT_*` constants, wrangler defaults, example/docs entries, workflow passthrough, and sync script propagation.
- `security-auditor`: PASS. R2 keys are project/session/message scoped and encoded; archive retrieval remains project-scoped; SQL remains parameterized; logs avoid payload content.

## Out of scope

- ProjectData sharding or transcript deletion.
- One-off production purge.
