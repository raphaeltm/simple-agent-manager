# ProjectData tool-payload R2 archival and retention

## Problem

The SAM ProjectData Durable Object for the SAM project is near Cloudflare's hard 10 GB SQLite-backed DO limit. On 2026-08-26 it was reported at 8.74 GB / 10 GB and growing fast enough that headroom is measured in days. It already hit the wall once on 2026-08-18 with 102 `Exceeded the maximum database size.` write failures, and Raphaël manually purged 3.14 GB of tool-call JSON data to recover.

The approved product decision is strict:

- Conversation and message text is never deleted; long-term searchability must be preserved.
- Tool-call JSON payloads older than the retention window may be removed from ProjectData SQLite, but only after they are archived to private, project-scoped R2 and remain retrievable.

## Research findings

- Approved design lives in SAM idea `01M0YZNBKSKQZ47NC0K7M8N5AX`: Layer 1 is daily tool-payload archival plus retention; sharding is an escalation layer only if retention does not bring usage below target.
- Existing cleanup entrypoint is `runProjectDataToolPayloadCleanup` in `apps/api/src/durable-objects/project-data/tool-payload-cleanup.ts`. It is called from `storage-alarm.ts`; this must be extended rather than bypassed.
- Current candidate selection is in `tool-payload-cleanup-candidates.ts` and is constrained through `selectNextTerminalSessionId()` in `tool-payload-cleanup-state.ts`, which only reaches old terminal sessions. Production evidence says that scope only covers about 703 KB, so retention must select old tool-message payloads by message age across session statuses.
- Existing cleanup strips `tool_metadata.content` with `stripToolMetadataPayloadForStorage()` and never writes R2. That must become archive-then-strip/delete for all new payload-removal paths.
- `messages.getMessageToolContent()` currently returns inline `tool_metadata.content` or `[]`. It needs an archived R2 fallback or an explicit archived-unavailable state so expanders do not silently break.
- The REST lazy-load endpoint is `GET /api/projects/:projectId/sessions/:sessionId/messages/:messageId/tool-content` in `apps/api/src/routes/chat.ts`; frontend `apps/web/src/lib/api/sessions.ts` destructures `{ content }`, so transparent R2 fallback can stay backward-compatible.
- MCP registration is centralized in `apps/api/src/routes/mcp/index.ts`, with read-only session/message tools in `session-tools.ts` and schemas in `tool-definitions-project-awareness.ts`. The archive retrieval tool belongs there.
- DO migrations are append-only in `apps/api/src/durable-objects/migrations.ts`; a new metadata table can be added safely with `CREATE TABLE IF NOT EXISTS` and indexes.
- R2 bindings belong only in the top-level `apps/api/wrangler.toml`. Generated environment config in `scripts/deploy/sync-wrangler-config.ts` must emit the new binding for staging/production.
- Existing storage telemetry uses `ctx.storage.sql.databaseSize`; all reclaim evidence must continue to use that value, not PRAGMA page count math.
- Relevant tests already exist in `apps/api/tests/workers/project-data-storage-safety.test.ts`, `apps/api/tests/workers/project-data-do.test.ts`, and MCP workers tests. New coverage must include R2 write failure atomicity, retention boundary, row/byte/wall-time budgets, read-path fallback, and MCP retrieval.
- Redispatch context: predecessor task `01M0YZPBW8EA5X3HA91RP5QVXG` was false-killed during a ProjectData DO self-reset; branch `sam/implement-projectdata-tool-payload-p5qvxg` contains only this task file commit. This task continues on SAM output branch `sam/implement-projectdata-tool-payload-j28xyt`.
- Coordination context: PR #1932 must merge and deploy first. As of Phase 1 start, PR #1932 is open/clean with staging run `32971336141` in progress on `sam/continue-finish-vm-liveness-bj2ype`. Do not trigger staging until that work is clear, and after it merges rebase onto current `main` without reverting its storage-alarm/storage-telemetry category-scan bounding.

Every finding above is represented in the checklist below.

## Implementation checklist

- [x] Extend ProjectData DO schema additively with archive metadata for tool payloads.
- [x] Add a private project-scoped R2 archive helper with deterministic keys, JSON object format, and no public URL exposure.
- [x] Extend storage safety config and env typing with archive cadence, retention window, batch row/byte/wall-time budgets, retry/recheck cadence, and key prefix defaults.
- [x] Add top-level `PROJECT_DATA_ARCHIVE_R2` binding in `apps/api/wrangler.toml` and generated staging/production binding emission in deploy sync code.
- [x] Extend `runProjectDataToolPayloadCleanup` to run retention archive batches using keyset pagination by message age and to archive before removing `tool_metadata.content`.
- [x] Preserve fail-closed behavior: R2 write failure, malformed payload, missing binding, or budget exhaustion must not remove DO payload content.
- [x] Update alarm scheduling so the retention cadence and continuation rechecks are honored without adding a parallel cleanup loop.
- [x] Update the lazy tool-content read path to return inline content, transparent R2 archived content, or an explicit archived-unavailable content item.
- [x] Add an MCP tool for retrieving archived tool payloads by message ID and/or session/time range, scoped to the caller's project and bounded by env-configurable limits.
- [x] Update public/agent API references and env references where they document runtime env vars or MCP tools.
- [x] Add deterministic unit tests for archive helpers/config and MCP handler validation.
- [x] Add workers-pool tests for archive-then-delete atomicity, retention-window boundaries, batch budgets, R2 read fallback, and MCP retrieval.
- [ ] Run quality gates, specialist review skills, staging verification, PR creation, CI, merge, and production deploy monitoring per `/do`.

## Acceptance criteria

- [x] Daily retention archives tool payload JSON older than the configured window to private R2 and only then removes the payload from ProjectData SQLite.
- [x] Message text and non-payload metadata remain in ProjectData; searchability is preserved.
- [x] R2 archive failures fail closed with no DO payload deletion.
- [x] Cleanup uses keyset/LIMIT pagination and bounded row/byte/wall-time/per-row budgets; no large `.toArray()` scans are added.
- [x] Existing lazy expanders either load archived content transparently or show an explicit archived-unavailable state.
- [x] SAM MCP exposes a project-scoped retrieval tool for archived tool payloads by message/session/time range.
- [x] All new limits, cadence, retention windows, and prefixes are environment-configurable with `DEFAULT_*` constants.
- [x] Staging/production deployment config receives the new R2 binding from the generated wrangler path.
- [x] Tests prove atomicity, boundaries, budgets, read fallback, and MCP retrieval.
- [x] Production verification plan records that post-merge effectiveness must be judged by `project_data_storage_telemetry.databaseSize`.

## Validation evidence

- `git diff --check`
- `pnpm quality:wrangler-bindings`
- `pnpm quality:do-migration-safety`
- `pnpm quality:skill-references`
- `pnpm format:check`
- `pnpm --filter @simple-agent-manager/api typecheck`
- `pnpm --filter @simple-agent-manager/api lint`
- `pnpm --filter @simple-agent-manager/web typecheck` after building `@simple-agent-manager/ui`, `@simple-agent-manager/acp-client`, and `@simple-agent-manager/terminal`
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/durable-objects/project-data-tool-payload-archive.test.ts tests/unit/routes/mcp.test.ts`
- `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/project-data-tool-payload-archive.test.ts`
- `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/project-data-storage-safety.test.ts`
- `pnpm quality:type-boundaries`
- `pnpm quality:source-contract-tests`

## Post-merge production verification plan

After merge and production deploy, query production `project_data_storage_telemetry`
with `CF_PRODUCTION_DEBUGGING_TOKEN` and compare the SAM project's latest
`database_size_bytes`/`databaseSize` before and after the archival job runs. Judge
effectiveness only by the DO `sql.databaseSize`-backed telemetry value, not PRAGMA
page-count math.

## References

- SAM idea `01M0YZNBKSKQZ47NC0K7M8N5AX`
- `.claude/rules/07-env-and-urls.md`
- `.claude/rules/24-no-duplicate-ui-controls.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
- `.claude/rules/59-understand-before-adding.md`
