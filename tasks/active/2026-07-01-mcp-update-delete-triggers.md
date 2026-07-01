# Add MCP Update/Delete Trigger Tools

## Problem

Agents can create cron triggers via `create_trigger`, but the MCP tool surface does not expose update or delete operations. The REST trigger CRUD routes already support both operations, so agents are blocked only by missing MCP handlers, tool definitions, and dispatcher wiring.

## Research Findings

- `apps/api/src/routes/mcp/trigger-tools.ts` currently exports only `handleCreateTrigger`, using raw D1 SQL, `sanitizeUserInput`, `parsePositiveInt`, JSON-RPC helpers, and cron utilities.
- `apps/api/src/routes/triggers/crud.ts` is the behavioral reference for PATCH/DELETE: update validates names, cron expressions, timezones, status, template length, concurrency, agent profile/skill ownership, recomputes `next_fire_at`, and delete cascades GitHub config and executions before deleting the trigger.
- `.claude/rules/11-fail-fast-patterns.md` requires project-scoped writes to verify ownership before mutating, reject cross-project attempts, log diagnostics, and include `project_id = ?` in the final mutation predicate when the table has `project_id`.
- `apps/api/src/routes/mcp/tool-definitions-trigger-tools.ts` only defines `create_trigger`; `apps/api/src/routes/mcp/index.ts` only imports and dispatches `handleCreateTrigger`.
- Existing `apps/api/tests/unit/routes/mcp-create-trigger.test.ts` covers direct handler validation with a D1 mock, but the requested update/delete coverage should be Miniflare worker integration tests under `apps/api/tests/workers/`, using real D1/KV and `SELF.fetch`.
- Shared seed helpers in `apps/api/tests/workers/helpers/seed-d1.ts` already seed users, projects, triggers, and trigger executions for realistic Miniflare state.

## Implementation Checklist

- [x] Add `handleUpdateTrigger` in `apps/api/src/routes/mcp/trigger-tools.ts`.
- [x] Require and validate `triggerId`; resolve the trigger before mutation and reject missing/cross-project triggers instead of silently no-oping.
- [x] Validate update fields following REST CRUD behavior: name, description, status, cron expression, timezone, skipIfRunning, agentProfileId, skillId, taskMode, vmSizeOverride, maxConcurrent, and promptTemplate.
- [x] Recompute `next_fire_at` and `cronHumanReadable` when cron/timezone/status changes require it.
- [x] Include `project_id = ?` in the final trigger UPDATE predicate.
- [x] Add `handleDeleteTrigger` with pre-mutation ownership verification, cascaded delete of `github_trigger_configs` then `trigger_executions` then `triggers`, and `project_id = ?` in the final trigger DELETE predicate.
- [x] Add `update_trigger` and `delete_trigger` tool definitions with `triggerId` required and update fields optional.
- [x] Import and dispatch `handleUpdateTrigger` and `handleDeleteTrigger` in `apps/api/src/routes/mcp/index.ts`.
- [x] Add Miniflare worker integration tests proving update persists and recomputes `next_fire_at`.
- [x] Add Miniflare worker integration tests proving delete cascades executions and GitHub configs.
- [x] Add cross-project isolation tests proving update and delete are rejected and leave the other project trigger unchanged.
- [x] Run impacted local tests and quality checks.
- [x] Run specialist review with `cloudflare-specialist` and `security-auditor`; include task completion validation before archive.

## Validation Notes

- `pnpm --filter @simple-agent-manager/api typecheck` passed.
- `pnpm --filter @simple-agent-manager/api lint` passed with existing warnings only.
- `pnpm --filter @simple-agent-manager/api exec vitest run tests/unit/routes/mcp-update-delete-trigger.test.ts` passed.
- Local Miniflare worker tests could not execute in this workspace because workerd segfaulted before tests ran. This was reproduced with an existing worker test (`tests/workers/trigger-execution-cleanup.test.ts`), so it is a local worker-runtime blocker rather than a failure isolated to the new MCP trigger tests.
- `pnpm --filter @simple-agent-manager/api exec vitest run tests/unit/routes/mcp.test.ts tests/unit/routes/mcp-update-delete-trigger.test.ts` passed.
- `pnpm build` passed.
- `pnpm test` passed: API 359 files / 5596 tests, web 199 files / 2497 tests, 19/19 turbo tasks successful.
- Task completion validation passed: implementation covers all research findings, checklist items, and acceptance criteria; the only warning is local Miniflare execution blocked by a reproducible workerd segfault.
- `cloudflare-specialist` review passed: parameterized D1 statements, scoped final trigger mutations, no migration/config changes, and committed worker integration coverage using real D1/KV/`SELF.fetch`.
- `security-auditor` review passed: cross-project update/delete attempts are rejected before mutation, final trigger mutations include `project_id = ?`, profile/skill references are project-scoped, and no secret material is logged.
- Staging verification intentionally skipped per user instruction; no staging deployment was run.

## Acceptance Criteria

- MCP `tools/list` includes `create_trigger`, `update_trigger`, and `delete_trigger`.
- MCP `tools/call` routes `update_trigger` and `delete_trigger` to working handlers.
- `update_trigger` updates allowed trigger fields, validates cron/timezone/template/profile/project-scoped inputs, and returns updated trigger metadata including recomputed next fire time and human-readable cron.
- `delete_trigger` deletes the trigger and cascades GitHub trigger configs and executions.
- Cross-project update/delete attempts return JSON-RPC errors and do not mutate the target trigger.
- No staging deployment is run for this task; verification is local tests, CI, and specialist review.

## References

- `apps/api/src/routes/mcp/trigger-tools.ts`
- `apps/api/src/routes/mcp/tool-definitions-trigger-tools.ts`
- `apps/api/src/routes/mcp/index.ts`
- `apps/api/src/routes/triggers/crud.ts`
- `.claude/rules/11-fail-fast-patterns.md`
- `.claude/rules/35-vertical-slice-testing.md`
