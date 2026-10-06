# Add MCP `list_triggers` Tool

## Problem

SAM agents can create, update, and delete automation triggers through MCP, but they cannot discover the current project's triggers or their IDs. Editing an existing trigger therefore requires bypassing the product API with a raw D1 query. Add one bounded, project-scoped `list_triggers` MCP tool that exposes operational trigger metadata without execution history or secret-bearing webhook configuration.

## Research Findings

- `apps/api/src/routes/mcp/trigger-tools.ts` is 523 lines and exceeds the 500-line ceiling. Split the existing create/update/delete handlers mechanically in a standalone commit before adding the feature.
- `apps/api/src/routes/triggers/crud.ts` owns the REST list query and `TriggerRow` to `TriggerResponse` mapper. Extract the base query/mapper into a shared trigger-read service so REST and MCP use one query path.
- The common `triggers` table contains the requested scheduling and execution summary fields, plus prompt/user/project metadata that the MCP list does not need.
- `webhook_trigger_configs` stores `token_hash`, a token suffix/timestamps, filters, and `included_headers_json`; raw one-time webhook tokens are returned only during create/rotation. The MCP list must not query or serialize this side table. A strict output allowlist also excludes prompt templates and any source-specific configuration.
- `github_trigger_configs` stores event filters but no signing secret. The deployment-level GitHub webhook secret is a Worker secret, not a trigger row. It is nevertheless outside the MCP list contract and must not be serialized.
- Project isolation must be a SQL predicate on `triggers.project_id`, tested against a real SQL engine using the repository's SQLite-backed D1 helpers or Worker integration environment.
- MCP list tools clamp caller limits with configurable default/max values. Add `MCP_TRIGGER_LIST_LIMIT` and `MCP_TRIGGER_LIST_MAX` with `DEFAULT_*` fallbacks, Env declarations, `.env.example`, and public configuration reference entries.
- `apps/www/src/content/docs/docs/guides/agents.md` lists project-aware MCP tools and must include `list_triggers`.
- Existing trigger worker tests exercise the actual `/mcp` dispatcher and D1. They are the preferred vertical-slice location for tool registration/dispatch behavior; focused SQLite-backed handler tests can cover the full filter, isolation, redaction, and bounding matrix quickly and deterministically.

## Implementation Checklist

- [x] Split `apps/api/src/routes/mcp/trigger-tools.ts` into focused create/update/delete modules in a standalone refactor commit with unchanged behavior.
- [x] Extract the REST trigger base list query and row mapper into a shared service; keep existing REST response behavior intact.
- [x] Add configurable MCP trigger list default/max limits with `DEFAULT_*` constants and environment documentation.
- [x] Add `handleListTriggers` with optional `status`, `sourceType`, and `limit`; validate enum filters and clamp the limit.
- [x] Return an explicit safe field allowlist: `id`, `name`, `description`, `status`, `sourceType`, `cronExpression`, `cronTimezone`, `cronHumanReadable`, `nextFireAt`, `lastTriggeredAt`, `triggerCount`, `taskMode`, `agentProfileId`, `skillId`, `maxConcurrent`, and `skipIfRunning`.
- [x] Add the `list_triggers` MCP definition and dispatcher wiring.
- [x] Add behavioral real-SQL coverage for an empty project, multiple rows/field mapping, status filtering, source-type filtering, cross-project isolation, webhook secret/config redaction, and default/requested/max bounding.
- [x] Add dispatcher/tool-list coverage and update the public MCP tools reference.
- [x] Run focused tests, lint, typecheck, full tests, build, and file-size checks.
- [x] Run task completion, Cloudflare, security, constitution, environment, documentation, and test specialist reviews; address all correctness findings.
- [ ] Run local PR evidence checks against the final PR body, open a PR stating that staging was intentionally skipped by explicit instruction, wait for required CI evidence, and leave it open and unmerged for Raphaël.

## Validation Evidence

- Focused API coverage: 274 tests passed, including the 7-test real-SQL `list_triggers` suite.
- Worker MCP vertical slice: 6 tests passed through the actual `/mcp` dispatcher and D1 binding.
- Repository gates: `pnpm lint`, `pnpm typecheck`, `pnpm test` (20/20 tasks; API 6,756/6,756), `pnpm build`, and `pnpm quality:file-sizes` passed.
- Staging was intentionally not deployed or verified, per explicit user instruction.

## Specialist Review Evidence

| Reviewer | Status | Outcome |
| --- | --- | --- |
| task-completion-validator | PASS | All planned work and pre-PR acceptance criteria are covered; archival authorized. |
| security-auditor | PASS | SQL project isolation and secret-safe output allowlisting verified. |
| cloudflare-specialist | PASS | D1 query, Worker dispatch, bounds, and real-engine coverage verified. |
| constitution-validator | PASS | Configurable `DEFAULT_*` default/max limits satisfy Principle XI. |
| env-validator | PASS | Optional runtime variables and documentation are synchronized. |
| doc-sync-validator | ADDRESSED | MCP limit grouping labels corrected in `7e2f6eaea`. |
| test-engineer | PASS | Combined filters are discriminating and schema/real-SQL coverage is complete. |

## Acceptance Criteria

- `tools/list` advertises `list_triggers` with no required parameters and optional validated `status`, `sourceType`, and `limit` inputs.
- Calling `list_triggers` returns only triggers whose `project_id` matches the current MCP token's project, ordered consistently with the REST list.
- Empty projects return `{ "triggers": [] }`; populated projects return all requested operational fields with a human-readable cron schedule.
- Both filters work independently and together, and the configurable default/max bounds are enforced by the SQL query.
- The payload contains no webhook token/hash/suffix, included-header configuration, source filters, credentials, signing secrets, or execution history. A webhook canary test proves secret material is absent.
- REST and MCP share the base trigger list query/mapper rather than maintaining duplicate SQL paths.
- The split MCP trigger handler modules and REST trigger CRUD module are within the 500-line ceiling; the pre-existing centralized MCP dispatcher remains below the mandatory 800-line limit.
- Local lint, typecheck, tests, build, and applicable quality checks pass; CI reaches the allowed green state.
- No staging deployment or verification is performed, by explicit user instruction.
- The PR remains open and unmerged for Raphaël's review.

## References

- `apps/api/src/routes/mcp/trigger-tools.ts`
- `apps/api/src/routes/mcp/tool-definitions-trigger-tools.ts`
- `apps/api/src/routes/mcp/index.ts`
- `apps/api/src/routes/triggers/crud.ts`
- `apps/api/src/services/cron-utils.ts`
- `apps/api/tests/helpers/sqlite-d1.ts`
- `apps/api/tests/workers/mcp-trigger-tools.test.ts`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/18-file-size-limits.md`
- `.claude/rules/25-review-merge-gate.md`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/50-list-read-row-fault-isolation.md`
- `.specify/memory/constitution.md` (Principle XI)
