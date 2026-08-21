# ProjectData DO sharding for 10GB storage ceiling

## Problem

Cloudflare Durable Object SQLite storage has a hard 10GB ceiling per object instance. SAM's `ProjectData` Durable Object stores project-scoped chat sessions, messages, materialized search content, activity, ACP state, ideas, knowledge, and policies. Write-hot projects can exhaust a single `ProjectData` object and start failing writes without a graceful path.

Implement Phase 1 core sharding infrastructure from SAM idea `01M0F88EEQPGR32E08R1EXC2VR`: same-class `ProjectData` shard objects addressed by names such as `projectId:shard:001`, internal facade routing, storage-size estimation, and alarm-driven migration of immutable completed session history.

## Constraints

- Base branch: `main`.
- Output branch: `sam/do-sharding-implementation`.
- Do not deploy to staging for this task.
- Do not merge to `main`.
- Create a draft PR with `DO NOT MERGE` in the title.
- Get local quality checks and PR CI green.
- No new Durable Object classes or wrangler bindings.
- Keep new production source files under 500 lines; split sharding logic into ProjectData sibling modules.

## Research findings

- The ProjectData DO implementation is split under `apps/api/src/durable-objects/project-data/`, but `index.ts` intentionally remains over 500 lines with a Cloudflare RPC facade file-size exception. Add thin public methods there and put new logic in modules such as `sharding.ts` / `shard-migration.ts`.
- DO SQLite migrations live in `apps/api/src/durable-objects/migrations.ts`; the latest migration on `main` is `031-task-wait-replay-hardening`. Sharding must append migration `032-...`; never reorder or rewrite existing migrations.
- The existing session read paths are `ProjectData.getSession()` → `sessions.getSession()` and `ProjectData.getMessages()` → `messages.getMessages()`. Shard routing can be internal to these DO methods without touching API routes, MCP tools, or UI.
- `searchMessages()` currently has no scope parameter. To keep zero API changes while satisfying Phase 1 fan-out coverage, the ProjectData facade should search the primary plus all registered shards and merge by `createdAt` when no specific session is requested; when a session id is already registered in `session_shards`, route directly to that shard.
- The PoC branch `sam/do-sharding-poc` proves same-class DO isolation, DO-to-DO RPC through `env.PROJECT_DATA`, manual session/message migration, FTS in shards, fan-out search, and read-through behavior.
- The project library research doc `/engineering/research/do-10gb-storage-ceiling-research.md` confirms per-object 10GB storage is not visible through Cloudflare per-object metrics and recommends self-instrumenting `PRAGMA page_count * PRAGMA page_size`.
- `chat_sessions` is a parent table for `chat_messages`, `chat_messages_grouped`, `acp_sessions`, `chat_session_ideas`, and `session_attention_markers`. A naive `DELETE FROM chat_sessions` after copying only messages would cascade-delete fork/lineage and idea/attention data. The migration implementation must either migrate dependent session-owned rows that remain required or deliberately avoid deleting the parent until safe.
- Completed/stopped sessions are the safe first migration class. Active and sleeping sessions must stay in the primary DO. Failed sessions have recovery/fork semantics in current code and should not be included unless the implementation proves they are immutable for the copied state.
- ProjectData alarms already run multiple control loops. Rule 47 requires bounded candidate selection, cheap synchronous work, env-configurable limits, and a candidate escape path. Shard migration must process a bounded batch per alarm and re-arm only when work remains.
- Durable Objects do not serialize across `await`. The extract → shard RPC → verify → primary delete → registry update critical section must use an explicit in-DO mutex so concurrent alarm/manual triggers cannot migrate the same session twice or corrupt registry counts.
- New sharding thresholds and batch/check intervals are runtime configuration and must follow Constitution Principle XI: `DEFAULT_*` constants plus env overrides, documented in `Env`, `.env.example`, and public configuration docs.

## Implementation checklist

- [x] Append DO SQLite migration `032-project-data-sharding` creating `session_shards` and `shard_registry` tables plus indexes for session lookup, shard lookup, dates, and registry ordering.
- [x] Add sharding config helpers with `DEFAULT_DO_SHARD_MIGRATION_THRESHOLD_BYTES` (7GB), `DEFAULT_DO_SHARD_AGGRESSIVE_THRESHOLD_BYTES` (8.5GB), `DEFAULT_DO_SHARD_HARD_BRAKE_THRESHOLD_BYTES` (9GB), `DEFAULT_DO_SHARD_TARGET_SIZE_BYTES` (5GB), `DEFAULT_DO_SHARD_MAX_SIZE_BYTES` (2GB), `DEFAULT_DO_SHARD_MIGRATION_BATCH_SIZE` (10), and `DEFAULT_DO_SHARD_CHECK_INTERVAL_MS`.
- [x] Add Env interface entries and documentation for every new sharding variable.
- [x] Add internal storage-size estimation using `PRAGMA page_count` and `PRAGMA page_size`; expose it through a ProjectData internal/testable RPC method.
- [x] Add shard lookup and same-class stub helpers that keep API/MCP/UI callers unchanged.
- [x] Route `getMessages(sessionId)` and `getSession(sessionId)` through `session_shards` before local reads.
- [x] Implement search fan-out across registered shards and primary with deterministic result merge/truncation.
- [x] Implement bounded alarm-based migration with an explicit mutex, oldest stopped-session selection, shard capacity selection/creation, per-session extract/copy/verify/delete/registry update, and re-arm behavior when storage remains above target.
- [x] Preserve or explicitly guard dependent session-owned tables so migration cannot cascade-delete ACP fork/lineage, idea links, or attention state accidentally.
- [x] Trigger a shard migration check after session stop/materialization and from the ProjectData alarm loop.
- [x] Add worker integration tests in `apps/api/tests/workers/` for migration correctness, read routing, fan-out search, storage estimation, alarm trigger, active/sleeping non-migration, and cascade-safety.
- [x] Add focused unit tests for sharding config parsing and storage/migration helpers where they can run without workerd.
- [x] Update docs and task notes with control-loop I/O budget: batch size, worst-case per-candidate cost, and candidate escape path.
- [x] Run targeted tests, full `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, migration-safety checks, and file-size check.
- [x] Run required local specialist reviews: task-completion-validator, cloudflare-specialist, env-validator, constitution-validator, and test-engineer.
- [ ] Archive this task only after validator passes, then create a draft PR titled with `DO NOT MERGE`.

## Acceptance criteria

- [x] Existing API routes, MCP tools, and UI call the same ProjectData service methods with no signature changes required.
- [x] `session_shards` and `shard_registry` exist in DO SQLite after migrations and are safe on clean bootstrap and upgrade.
- [x] A migrated stopped session is absent from primary message storage, present in a shard, and readable through primary `getSession()` / `getMessages()`.
- [x] Active and sleeping sessions are never selected for migration.
- [x] Search returns merged results from primary and shard data without duplicate rows and honors the requested limit.
- [x] Storage estimation uses actual SQLite PRAGMAs and can be asserted in worker tests.
- [x] Alarm-driven migration processes a bounded batch and re-arms only when more sharding work remains.
- [x] Migration does not accidentally delete session-owned data needed by current fork/lineage or linked-idea flows.
- [x] All new thresholds and limits are configurable through env vars with documented defaults.
- [x] Local quality suite is green; staging is intentionally skipped by explicit user instruction.
- [ ] GitHub CI is green for the draft PR.

## Control-loop I/O budget

- Shard migration runs only from ProjectData alarms. `stopSession()` may arm an immediate alarm after materialization when storage is already above `DO_SHARD_MIGRATION_THRESHOLD_BYTES`; it does not migrate inline on the request path.
- Each alarm turn processes at most `DO_SHARD_MIGRATION_BATCH_SIZE` stopped sessions, capped in code at 100 even if an unsafe larger env override is supplied.
- Each candidate does one primary extraction, one same-class shard RPC, one shard verification, and one primary finalize transaction. Candidates are ordered oldest-first and active/sleeping/failed sessions are excluded.
- Primary finalize deletes only `chat_messages` and `chat_messages_grouped` rows after shard verification. The primary `chat_sessions` row is retained in Phase 1 to avoid cascade-deleting ACP lineage, linked ideas, or attention state.
- When eligible candidates remain after a bounded batch, the alarm re-arms after `DO_SHARD_CHECK_INTERVAL_MS` (default 1 hour). If no candidates remain, sharding does not keep the ProjectData alarm alive.

## References

- SAM idea `01M0F88EEQPGR32E08R1EXC2VR`
- Project library: `/engineering/research/do-10gb-storage-ceiling-research.md`
- PoC: `origin/sam/do-sharding-poc:apps/api/tests/workers/do-sharding-poc.test.ts`
- `apps/api/src/durable-objects/project-data/index.ts`
- `apps/api/src/durable-objects/project-data/sessions.ts`
- `apps/api/src/durable-objects/project-data/messages.ts`
- `apps/api/src/durable-objects/project-data/materialization.ts`
- `apps/api/src/durable-objects/migrations.ts`
- `.claude/rules/18-file-size-limits.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/45-durable-object-concurrency-mutex.md`
- `.claude/rules/47-control-loop-io-budget.md`
