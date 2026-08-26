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

Every finding above is represented in the checklist below.

## Implementation checklist

- [ ] Extend ProjectData DO schema additively with archive metadata for tool payloads.
- [ ] Add a private project-scoped R2 archive helper with deterministic keys, JSON object format, and no public URL exposure.
- [ ] Extend storage safety config and env typing with archive cadence, retention window, batch row/byte/wall-time budgets, retry/recheck cadence, and key prefix defaults.
- [ ] Add top-level `PROJECT_DATA_ARCHIVE_R2` binding in `apps/api/wrangler.toml` and generated staging/production binding emission in deploy sync code.
- [ ] Extend `runProjectDataToolPayloadCleanup` to run retention archive batches using keyset pagination by message age and to archive before removing `tool_metadata.content`.
- [ ] Preserve fail-closed behavior: R2 write failure, malformed payload, missing binding, or budget exhaustion must not remove DO payload content.
- [ ] Update alarm scheduling so the retention cadence and continuation rechecks are honored without adding a parallel cleanup loop.
- [ ] Update the lazy tool-content read path to return inline content, transparent R2 archived content, or an explicit archived-unavailable content item.
- [ ] Add an MCP tool for retrieving archived tool payloads by message ID and/or session/time range, scoped to the caller's project and bounded by env-configurable limits.
- [ ] Update public/agent API references and env references where they document runtime env vars or MCP tools.
- [ ] Add deterministic unit tests for archive helpers/config and MCP handler validation.
- [ ] Add workers-pool tests for archive-then-delete atomicity, retention-window boundaries, batch budgets, R2 read fallback, and MCP retrieval.
- [ ] Run quality gates, specialist review skills, staging verification, PR creation, CI, merge, and production deploy monitoring per `/do`.

## Acceptance criteria

- [ ] Daily retention archives tool payload JSON older than the configured window to private R2 and only then removes the payload from ProjectData SQLite.
- [ ] Message text and non-payload metadata remain in ProjectData; searchability is preserved.
- [ ] R2 archive failures fail closed with no DO payload deletion.
- [ ] Cleanup uses keyset/LIMIT pagination and bounded row/byte/wall-time budgets; no large `.toArray()` scans are added.
- [ ] Existing lazy expanders either load archived content transparently or show an explicit archived-unavailable state.
- [ ] SAM MCP exposes a project-scoped retrieval tool for archived tool payloads by message/session/time range.
- [ ] All new limits, cadence, retention windows, and prefixes are environment-configurable with `DEFAULT_*` constants.
- [ ] Staging/production deployment config receives the new R2 binding from the generated wrangler path.
- [ ] Tests prove atomicity, boundaries, budgets, read fallback, and MCP retrieval.
- [ ] Production verification plan records that post-merge effectiveness must be judged by `project_data_storage_telemetry.databaseSize`.

## References

- SAM idea `01M0YZNBKSKQZ47NC0K7M8N5AX`
- `.claude/rules/07-env-and-urls.md`
- `.claude/rules/24-no-duplicate-ui-controls.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
- `.claude/rules/59-understand-before-adding.md`
