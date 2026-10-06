# Fix Trigger Execution Detail Project IDOR

## Problem

`GET /api/projects/:projectId/triggers/:triggerId/executions/:executionId` authorizes the caller for the route's project, but the execution lookup on current `origin/main` (`fc1e394217248c3bd004b2e6619cf2344eade7e3`) is scoped only by `executionId` and `triggerId`. A member of project A who supplies a trigger and execution pair from project B can receive project B's execution detail, including its rendered prompt, error metadata, task linkage, timestamps, and existence signal.

This is audit finding TR-01 (High, 99%, ship blocker) from task `01KZSZ5HDBARX61Q0PCASP1650`, session `c9487e09-e90d-4e46-84af-f8ecf30f178c`.

## Research Findings

- `apps/api/src/routes/triggers/executions.ts` calls `requireProjectTaskRead(db, projectId, userId)`, which proves membership in the route project but says nothing about the requested execution.
- The detail query predicates on `trigger_executions.id` and `trigger_executions.trigger_id`, but omits `trigger_executions.project_id`; the row is then serialized without an ownership check.
- `trigger_executions.project_id` is a required stored boundary in `apps/api/src/db/schema.ts`; the delete route already uses the three-part `(id, triggerId, projectId)` predicate.
- The existing `apps/api/tests/unit/routes/triggers.test.ts` Drizzle mock ignores `.where()` predicates and therefore cannot prove a query-scoping fix. Rule 28 explicitly requires a real SQL engine for guards expressed as SQL predicates.
- `apps/api/tests/helpers/sqlite-d1.ts` and the webhook management integration suite establish the repository pattern for Hono route + Drizzle + real in-memory SQLite/D1 vertical slices.
- The route response contract needs no schema or public documentation change: authorized requests must return the exact existing `TriggerExecutionResponse`; missing, stale, and cross-project combinations must use the existing non-disclosing `404` response.
- Root-cause history: the detail route was introduced in commit `394b47f4f8`; project membership authorization was added later in `736b6e2178`, but resource-to-project scoping was not added and no cross-project real-SQL route test existed.
- Relevant prior incident: `tasks/archive/2026-06-25-fix-mcp-override-task-state-idor.md` documents the same class—partial identifiers accepted without a final project predicate—and requires owner controls plus adversarial cross-project state.
- No active SAM task or open PR duplicates TR-01 as of 2026-08-12; sibling audit remediations target separate findings and branches.

## Implementation Checklist

- [x] Add adversarial real-SQL route tests before implementation and record that they fail on vulnerable main.
- [x] Cover an authorized active project member reading a same-project execution and preserve the complete response contract.
- [x] Cover an authorized project-A member requesting a valid project-B trigger/execution pair and require the standard non-disclosing `404` body.
- [x] Cover same-shaped valid IDs across projects so syntactic ID validity cannot substitute for project ownership.
- [x] Cover missing and stale/mismatched execution records with the same non-disclosing `404` contract.
- [x] Add the route project predicate to the execution detail lookup before any row is serialized.
- [x] Emit a structured access-miss rejection event with supplied route IDs and action, without querying or logging foreign row contents.
- [x] Add a focused process guard for project-scoped read predicates and real-SQL owner/attack controls.
- [x] Verify list/create trigger behavior and unrelated MCP tools remain untouched.
- [x] Run targeted API tests, API lint/typecheck/build, and root fast/build gates.
- [x] Run the serialized full monorepo test gate on the final reviewed candidate.
- [x] Run task completion, test, Cloudflare, constitution, documentation, security, and fresh independent adversarial local reviews; address every credible finding.
- [x] Push early, open exactly one non-draft PR against `main`, keep it unmerged, skip staging by explicit instruction, and monitor/fix applicable CI until fully green.

## Acceptance Criteria

- A current active member receives the identical successful execution-detail JSON contract for an execution belonging to the route project and trigger.
- A current active member of project A receives the repository-standard `404` error for a project-B execution, even when both foreign IDs are valid and correctly paired.
- Missing execution IDs, same-shaped foreign IDs, and stale/mismatched rows return the same `404` status and body without prompt, error, task, metadata, or existence disclosure.
- The security boundary is enforced by a project-scoped database predicate and proven with a Hono-to-real-SQL vertical slice whose attack case fails if the project predicate is removed while its owner control still succeeds.
- Trigger list/create behavior, unrelated trigger actions, MCP tools, response types, and authorized user-visible behavior are unchanged.
- All applicable local and GitHub CI checks are green; the single PR remains open and unmerged; staging is not mutated.

## Validation Evidence

- TDD red phase on vulnerable `origin/main` behavior: `pnpm --filter @simple-agent-manager/api test -- tests/integration/trigger-execution-detail-access.test.ts` — 4 adversarial cases failed with `received 200, expected 404`; the authorized owner-path control and genuinely missing-record control both passed.
- Green phase: after reviewer-requested removal of one duplicate request case, the focused execution-detail suite passed 5/5; the combined detail and existing trigger-route suites passed 26/26. API typecheck, root `check:fast`, and the full monorepo build passed.
- Final focused security/routes/membership run passed 33/33 after adding structured rejection diagnostics; API lint and typecheck passed.
- Final serialized monorepo test gate: `pnpm exec turbo run test --concurrency=1 --output-logs=errors-only` — 21/21 tasks passed in 7m03s (8 cached, 13 executed).
- Local specialist reviews: skeptical test quality PASS after one LOW duplicate-case cleanup; fresh adversarial security PASS with zero findings; Cloudflare/D1 PASS; constitution PASS after structured logging remediation; documentation sync PASS; task completion Checks A–F PASS with only PR/CI workflow pending.
- Pull request: [#1812](https://github.com/raphaeltm/simple-agent-manager/pull/1812), created as the sole non-draft PR against `main` and intentionally left open and unmerged.
- GitHub CI on reviewed code head `f746a9b5633270ace30c57acd9a018f7bdd11956`: all applicable test, Durable Object, build, lint, typecheck, code-quality, secret-scan, specialist-evidence, SonarCloud, benchmark, and smoke checks passed. Expected path-filtered jobs skipped. The archival-only follow-up commit triggered the final fresh event after correcting PR preflight evidence formatting.
- Staging was not deployed or mutated, per the explicit parent constraint.

## Post-Mortem

### What broke

An authorized project member could retrieve another project's trigger execution detail by putting the authorized project in the route while supplying a foreign trigger/execution pair.

### Root cause

The route treated project membership authorization and resource ownership as equivalent. Its final read predicate used two caller-controlled identifiers but omitted the stored project boundary.

### Timeline

The detail route was introduced in commit `394b47f4f8`. Membership-based project authorization was added in `736b6e2178` without extending the execution lookup to the project boundary. Strict CTO audit task `01KZSZ5HDBARX61Q0PCASP1650` reported TR-01 on 2026-08-12; the finding was independently reproduced against the unchanged current `origin/main` before editing.

### Why it was not caught

There was no execution-detail integration test with multiple projects. The nearby unit route harness returns queued rows regardless of Drizzle predicates, so it cannot distinguish a properly project-scoped query from the vulnerable query.

### Class of bug

Cross-project IDOR caused by authorizing the container scope without binding the requested child resource to that scope at the database boundary.

### Process fix

Extend the identity-boundary rule to require project-scoped read predicates, non-disclosing mismatch behavior, and discriminating owner/attacker tests against a real SQL engine whenever the security control is a query predicate.

## Constraints

- Scope only TR-01; do not bundle other audit debt.
- Preserve every valid workflow, API contract, and user-visible behavior.
- Fail closed only for unauthorized or unsafe requests.
- Create exactly one non-draft PR, do not merge it, and do not deploy or mutate staging.
- Stop only after every applicable CI check is green.

## References

- `apps/api/src/routes/triggers/executions.ts`
- `apps/api/src/db/schema.ts`
- `apps/api/tests/helpers/sqlite-d1.ts`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/06-api-patterns.md`
- `.claude/rules/11-fail-fast-patterns.md`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `tasks/archive/2026-06-25-fix-mcp-override-task-state-idor.md`
