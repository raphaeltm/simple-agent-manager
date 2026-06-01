# Add generated OpenAPI contract for CLI-facing SAM REST API

## Problem

The SAM CLI consumes a growing subset of the API, but there is no generated or checked OpenAPI contract for that CLI-facing surface. Current source of truth is split across Hono routes, Valibot schemas, shared TypeScript types, and Go CLI structs. That makes API/CLI contract drift easy to miss.

This task implements the first robust slice of generated OpenAPI support for the CLI-facing REST API so future Go CLI types/client code can be generated and contract drift can be tested.

## Constraints

- Use `/do`, but stop at a draft/open PR.
- Do **not** merge to `main`.
- Put `DO NOT MERGE` clearly in the PR title or body.
- Report progress through SAM task status updates.

## Research Findings

- `packages/cli/internal/cli/client.go` lists the exact CLI API calls, including auth token/device routes, project/session/task/library/knowledge/notification/trigger/profile/activity/node routes, and workspace detail/ports/port-access routes.
- `packages/cli/internal/cli/types.go` contains the current Go-side response shapes and drift-sensitive fields.
- API route implementations are mounted from `apps/api/src/index.ts` and live under `apps/api/src/routes/**`.
- Shared API/domain types live in `packages/shared/src/types/**`.
- Existing `specs/**/contracts/*.yaml` files are planning artifacts, not a live generated contract.
- `.claude/rules/36-cli-quality.md` requires high-quality CLI contract tests if CLI code changes.
- `docs/notes/2026-05-19-cli-sonar-quality-gap-postmortem.md` warns that CLI changes need real coverage evidence and QA-style tests.
- `docs/notes/2026-03-31-pr568-premature-merge-postmortem.md` requires durable reviewer tracking and no premature transition past review gates.
- `docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md` warns against relying only on source-contract assertions when combined Hono route behavior matters.

## Implementation Checklist

- [ ] Inspect CLI-facing Hono routes and current response shapes.
- [ ] Add a minimal typed OpenAPI builder or route/schema-compatible generator for the CLI-facing API.
- [ ] Add a canonical checked-in OpenAPI artifact, likely under `apps/api/openapi/`.
- [ ] Add an API route for serving the CLI OpenAPI document if it fits existing routing.
- [ ] Add a generation/check command and documentation for regenerating/checking the contract.
- [ ] Add tests that fail if required paths disappear.
- [ ] Add tests that fail if drift-sensitive fields disappear:
  - [ ] profile `items`
  - [ ] node list array/wrapper shape as implemented
  - [ ] library `sizeBytes`, `uploadSource`, `createdAt`
  - [ ] knowledge `name`, `entityType`, `updatedAt`
  - [ ] trigger `cronExpression`, `nextFireAt`
  - [ ] activity `eventType`, `payload`, `createdAt`
  - [ ] chat/session detail with `messages`
- [ ] Run relevant API typecheck/tests.
- [ ] Run broader quality gates required by `/do`.
- [ ] Use specialist review skills before PR.
- [ ] Open a draft/open PR with `DO NOT MERGE` and stop without merging.

## Acceptance Criteria

- Canonical OpenAPI document exists for the CLI-facing API surface.
- Contract includes the drift-sensitive fields listed above.
- Tests fail if required CLI-facing paths or fields disappear.
- API typecheck/tests pass for touched areas.
- Documentation explains how to regenerate/check the contract.
- PR is opened as draft/open with `DO NOT MERGE`, not merged.

## References

- `/uploads/sam-cli-session.txt`
- `packages/cli/internal/cli`
- `apps/api/src/index.ts`
- `apps/api/src/routes`
- `packages/shared/src/types`
- `.claude/rules/36-cli-quality.md`
- `.claude/skills/api-reference/SKILL.md`
