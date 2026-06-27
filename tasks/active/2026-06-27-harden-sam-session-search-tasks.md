# Harden SAM Session Search Tasks

**Priority**: P1
**Source**: CTO spot check, parent task `01KW3E1B1NFC6S3MKWX5RA319G`

## Problem

The SAM-session Durable Object `search_tasks` tool has drifted from the canonical project-aware MCP `search_tasks` contract. It advertises stale task statuses, only searches task titles despite describing title-or-description matching, accepts broad or invalid inputs, returns too little investigation context, and lacks focused tests for the DO implementation and project-agent wrapper path.

## Research Findings

- Canonical behavior lives in `apps/api/src/routes/mcp/task-tools.ts` and `apps/api/src/routes/mcp/tool-definitions-project-awareness.ts`.
- The DO implementation lives in `apps/api/src/durable-objects/sam-session/tools/search-tasks.ts`.
- Project-agent registration wraps the SAM-session tool in `apps/api/src/durable-objects/project-agent/tools/index.ts`, using `withProjectId` to inject the current project id.
- SAM-session registration is in `apps/api/src/durable-objects/sam-session/tools/index.ts`.
- Task schema fields for investigation output are in `apps/api/src/db/schema.ts`, including `description`, `priority`, `outputBranch`, `outputPrUrl`, `outputSummary`, and timestamps.
- Existing route tests cover the canonical MCP route under `apps/api/tests/unit/routes/mcp.test.ts`, but focused DO tests are missing.
- Existing durable-object test patterns live under `apps/api/tests/unit/durable-objects/`, including mock D1/Drizzle patterns in `sam-tools-phase-c.test.ts`.
- Prior retained query-hardening lesson in `tasks/archive/2026-05-07-fts5-query-sanitization.md` reinforces proving search sanitization and matching behavior with tests rather than relying on comments or assumptions.

## Implementation Checklist

- [ ] Update `searchTasksDef` to advertise `query` and the real statuses: `draft`, `queued`, `in_progress`, `delegated`, `awaiting_followup`, `completed`, `failed`, `cancelled`.
- [ ] Preserve `keyword` as a deprecated alias while documenting `query` as the public parameter.
- [ ] Require a trimmed query, reject blank or one-character queries, and return explicit DO-style errors.
- [ ] Validate `status` against the real enum and reject invalid values such as `running`.
- [ ] Round and clamp `limit` to a defensible min/default/max before passing it to Drizzle/D1.
- [ ] Search both `schema.tasks.title` and `schema.tasks.description` using Drizzle predicates with parameter binding.
- [ ] Preserve user ownership scoping and optional project scoping.
- [ ] Return canonical investigation fields: `id`, `title`, `status`, `priority`, `projectId`, `projectName`, `descriptionSnippet`, `outputBranch`, `outputPrUrl`, `outputSummary`, and `updatedAt`.
- [ ] Keep generated snippets bounded with a documented local constant or existing route helper if practical.
- [ ] Add focused unit tests for missing, blank, and one-character query rejection.
- [ ] Add focused unit tests for invalid status rejection and `in_progress` acceptance, including no advertised `running` status.
- [ ] Add focused unit tests proving description-only matches are returned.
- [ ] Add focused unit tests proving limit clamping.
- [ ] Add focused unit tests proving canonical fields and bounded snippets are returned.
- [ ] Add focused unit tests proving user/project scoping is preserved.
- [ ] Add focused unit tests proving the project-agent `withProjectId` path prevents cross-project task search.
- [ ] Run targeted API tests first.
- [ ] Run repo quality checks appropriate for API TypeScript changes.
- [ ] Run required specialist reviews: cloudflare-specialist, security-auditor, constitution-validator, test-engineer, and task-completion-validator.

## Acceptance Criteria

- [ ] DO `search_tasks` and project-agent wrapped `search_tasks` expose the correct task status vocabulary and do not mention `running`.
- [ ] Description-only task matches are returned.
- [ ] Invalid or too-short queries and invalid statuses return explicit errors instead of broad or misleading queries.
- [ ] Result shape gives agents enough context to triage task history without calling `get_task_details` for every hit.
- [ ] Tests fail on the current implementation and pass after the fix.
- [ ] No cross-project or cross-user leakage is introduced.
- [ ] PR is created, CI is checked, and the `/do` workflow proceeds through merge if all gates pass.

## References

- `apps/api/src/durable-objects/sam-session/tools/search-tasks.ts`
- `apps/api/src/durable-objects/sam-session/tools/index.ts`
- `apps/api/src/durable-objects/project-agent/tools/index.ts`
- `apps/api/src/routes/mcp/task-tools.ts`
- `apps/api/src/routes/mcp/tool-definitions-project-awareness.ts`
- `apps/api/src/db/schema.ts`
- `apps/api/tests/unit/routes/mcp.test.ts`
- `apps/api/tests/unit/durable-objects/`
