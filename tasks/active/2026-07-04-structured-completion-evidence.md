# Structured Task Completion Evidence

## Problem

`complete_task` currently persists only a free-text summary. Agents can report completion without a structured, machine-readable record of which tests, staging checks, CI checks, or manual verifications were performed. SAM needs generic completion evidence on platform tasks so MCP tools, task detail APIs, and future verification gates can distinguish self-certified completion from completion backed by proof.

## Research Findings

- `apps/api/src/routes/mcp/task-tools.ts` handles `complete_task` with raw D1 statements and exposes MCP `get_task_details`.
- `apps/api/src/routes/mcp/tool-definitions-task-tools.ts` defines the MCP tool schema and description for `complete_task`.
- `apps/api/src/routes/tasks/crud.ts` serves `GET /api/projects/:projectId/tasks/:taskId`, which the web task detail page consumes through `apps/web/src/lib/api/tasks.ts`.
- `apps/api/src/lib/mappers.ts` maps D1 task rows to shared `Task` DTOs.
- `packages/shared/src/types/task.ts` owns shared task API types; `packages/shared/src/types/index.ts` re-exports them.
- `apps/api/src/db/schema.ts` defines the `tasks` table. `tasks` is linked to `projects` and `users` with `ON DELETE CASCADE`, so migration rule 31 requires additive `ALTER TABLE ADD COLUMN` only.
- Existing MCP route tests live in `apps/api/tests/unit/routes/mcp.test.ts`; `complete_task` tests already exercise the route through JSON-RPC with a mocked D1 boundary.
- Relevant rules: `.claude/rules/31-migration-safety.md`, `.claude/rules/35-vertical-slice-testing.md`, `.claude/rules/13-staging-verification.md`, `.claude/rules/32-cf-api-debugging.md`, `.claude/rules/01-documentation-sync.md`.

## Implementation Checklist

- [ ] Add migration `0082_task_completion_evidence.sql` using only `ALTER TABLE tasks ADD COLUMN completion_evidence TEXT;`.
- [ ] Add `completionEvidence` shared type and defensive validator/parser in `packages/shared`.
- [ ] Add `completionEvidence` to shared `Task` and task detail response DTOs.
- [ ] Add `completionEvidence` to `apps/api/src/db/schema.ts`.
- [ ] Update `toTaskResponse` to parse stored JSON and return `completionEvidence`.
- [ ] Update `complete_task` MCP handler to accept optional `evidence`, reject malformed evidence before status mutation, and persist valid evidence JSON.
- [ ] Update MCP `get_task_details` to include parsed `completionEvidence`.
- [ ] Update task detail API route through mapper plumbing.
- [ ] Update MCP tool description/schema and any API docs/contracts touched.
- [ ] Add route-level tests for valid evidence round-trip, summary-only regression, malformed evidence rejection with no completion, and realistic D1 state.
- [ ] Run migration safety, lint, typecheck, tests, build, specialist reviews, staging verification, PR checks, merge, and production deploy monitoring.

## Acceptance Criteria

- `pnpm quality:migration-safety` passes.
- `complete_task` with valid evidence persists JSON to `tasks.completion_evidence` and `get_task_details` returns `completionEvidence`.
- `complete_task` without evidence keeps existing summary-only behavior.
- Malformed evidence rejects the whole call and does not mark the task completed.
- A vertical-slice test exercises the MCP route with realistic task/project state at the D1 boundary and asserts D1 state.
- Task detail API responses expose `completionEvidence`.
- Staging deploy is verified by exercising `complete_task` with evidence and querying staging D1 via `$CF_TOKEN` to confirm the column/data.
