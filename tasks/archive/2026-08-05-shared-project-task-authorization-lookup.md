# Fix shared-project task authorization lookup consistency

## Problem

Active project admins and maintainers have `task:write` and can already modify owner-created project tasks through the general CRUD/status paths. Some execution/lifecycle paths still perform owner-only task lookup after the project capability check, causing authorized project members to be rejected.

Scope is R1 finding 1 only: switch task lookup semantics for the affected task operations to project-authorized lookup while preserving caller-scoped credentials, compute, workspace ownership, and cleanup safety.

## Research Findings

- `apps/api/src/routes/tasks/run.ts` checks `requireProjectCapability(..., 'task:write')` but then calls `requireOwnedTask(...)`, which blocks admins/maintainers from running owner-created tasks.
- The run path also loads the project with `project.id AND project.userId = caller`, which blocks shared project members after task lookup is fixed. This needs project lookup via the already-authorized project resource while keeping GitHub repo access and credentials evaluated for the caller.
- Run dependency status lookup is currently filtered by `tasks.userId = caller`; for shared project tasks, dependency resolution must remain project-scoped so owner-created dependencies are evaluated correctly.
- `apps/api/src/routes/tasks/crud.ts` delegate path checks `task:write` but calls `requireOwnedTask(...)`, which blocks admins/maintainers. The target workspace lookup must remain `requireOwnedWorkspace(...)` so a member cannot delegate into or delete another user's workspace.
- `apps/api/src/routes/tasks/crud.ts` conversation close checks `task:write` but calls `requireOwnedTaskById(...)`, which blocks admins/maintainers. Its cleanup query already filters workspace by caller user/project; preserve that safety so closing another user's conversation task cannot delete their workspace.
- Terminal-status cleanup via `POST /status` already uses project-scoped task lookup and delegates to shared cleanup. Manual `POST /run/cleanup` still calls `requireOwnedTask(...)` and should use project-scoped task lookup while the underlying cleanup service preserves task/workspace ownership semantics.
- Existing project task CRUD/status routes use `requireProjectTaskById(...)` after `requireProjectCapability(...)`; that is the intended lookup pattern for project-owned tasks.

## Implementation Checklist

- [x] Update run task lookup to project-scoped semantics after `task:write` authorization.
- [x] Update run project/dependency lookup to support shared project members without weakening caller-scoped credentials, repo-access, or compute attribution.
- [x] Update manual terminal cleanup task lookup to project-scoped semantics only.
- [x] Update delegate task lookup to project-scoped semantics while preserving caller-owned workspace requirement.
- [x] Update conversation close task lookup to project-scoped semantics while preserving caller-owned workspace cleanup filter.
- [x] Add positive tests for admin/maintainer acting on owner-created tasks across run, delegate, terminal cleanup, and conversation close.
- [x] Add negative tests for viewer, nonmember, wrong project, cross-user workspace, and cleanup/close safety.
- [x] Run relevant API quality checks and local reviewer validations.
- [x] Open a tightly scoped PR (#1740). Original dispatch said do-not-merge; Raphaël explicitly
      authorized the merge on 2026-08-06 after the security fix was implemented and re-verified.
- [x] Close the cross-tenant compute-teardown vulnerability found by adversarial review
      (`requiredUserId` threaded `/status` → `cleanupTerminalTaskResourcesOrThrow` → `cleanupTaskRun`).
- [x] Replace the non-discriminating cleanup tests with real-SQLite behavioral tests.
- [x] Add the `project_id` write predicate to `setTaskStatus` (rule 11 defence in depth).
- [x] Staging deploy + cross-tenant E2E verification with two real users (23/23 checks passed).

## Acceptance Criteria

- Active project admin/maintainer with `task:write` can run, delegate, clean up terminal runs, and close conversation-mode tasks created by another project member.
- Viewers and nonmembers cannot perform write operations.
- Wrong-project task IDs are not accessible through another project route.
- Delegate requires a running workspace owned by the caller.
- Conversation close never deletes another user's workspace.
- Run uses the caller's cloud credentials, repo access, identity, and compute context.
- Public API shape, defaults, response formats, and existing owner behavior remain unchanged.


## Post-Mortem

### What broke

Two defects, discovered in two successive adversarial review rounds on PR #1740.

**1. Cross-tenant compute teardown (the security bug).** Widening the task lifecycle routes from
owner-scoped to project-scoped meant any member with `task:write` could cancel a shared task. The
terminal-cleanup path was not widened *with a matching narrowing of resource scope*: `cleanupTaskRun`
matched the workspace by `task.workspaceId` alone. So member B cancelling member A's task tore down
**A's** workspace and node.

**2. Non-discriminating evidence for the fix (the process bug).** The tests written to prove defect 1
was fixed used a chainable DB mock whose `.where()` ignored its arguments and returned canned rows.
The "attacker cannot tear down another user's workspace" test hardcoded an empty workspace result, so
it passed identically with the `requiredUserId` guard deleted. Two reviewers flagged this
(security-auditor HIGH-1, test-engineer CRITICAL); the PR was parked at `needs-human-review` with the
findings documented but unaddressed.

### Root cause

Defect 1: authorization and resource-mutation scope were treated as one decision. Widening *who may
act on the task* silently widened *whose compute gets destroyed*, because the cleanup helper derived
its target from the task row rather than from the caller.

Defect 2: the guard under test is a **SQL predicate**, but the test harness mocked the query builder.
A mock that ignores `.where()` cannot evaluate a predicate, so the test could only ever assert "the
canned result was empty" — never "the filter excluded the row."

### Class of bug

1. **Authorization widening without a corresponding resource-scope narrowing.** Covered by
   `.claude/rules/51-server-side-node-class-gates.md` (server decides from values it verified) and
   rule 11 (project-scoped write requirements).
2. **A test that cannot fail for the reason it claims to test.** Rule 02 bans source-contract tests
   (`readFileSync` + `toContain`) and rule 28 bans tautological IDOR tests, but neither covered the
   query-layer twin: a `.where()`-ignoring DB mock asserting a WHERE-clause ownership guard. Green
   tests actively concealed that the fix was unproven.

### Why it wasn't caught earlier

The mock-based tests were green and numerous, and the runtime fix *was* correct — so the suite looked
like adequate evidence. Only an adversarial reviewer specifically asking "would this test fail if the
guard were removed?" surfaced it. Nothing in CI can detect a tautological assertion.

### Process fix (in this PR)

- `.claude/rules/28-credential-resolution-fallback-tests.md` — new prohibited pattern #5: a DB mock
  whose `.where()` ignores its arguments cannot prove a WHERE-clause guard. Ownership guards
  expressed as SQL predicates must be tested against a real SQL engine, every attack case must be
  paired with an owner-path control, and the pair must be verified discriminating by deleting the
  guard. Two new items added to that rule's Quick Compliance Check.
- `apps/api/tests/helpers/sqlite-d1.ts` — `createSchemaTables` / `createAllSchemaTables` build the
  in-memory test schema from the drizzle schema itself, so real-SQLite tests are cheap to write and
  the test DB cannot drift from the columns production queries select.

### Verification that the new tests are discriminating

Both guards were temporarily deleted and the suites re-run:

- Removing the `requiredUserId` workspace filter from `cleanupTaskRun` → both ATTACK cases fail
  (attacker tears down victim's workspace; row flips to `stopped`), all 3 CONTROL cases still pass.
- Removing the `project_id` predicate from `setTaskStatus`'s UPDATE → the wrong-project write test
  fails, its matching-project control still passes.

### Design note: cancelled-by-another-member compute is not stranded

Caller-scoped cleanup means B cancelling A's task leaves A's compute running. That is reclaimed by
the node-cleanup cron, whose candidate queries match terminal tasks
(`apps/api/src/scheduled/node-cleanup.ts:180` cf-container terminal-task sweep, `:463` orphan
detection). The alternative — letting B tear down A's compute — is the vulnerability itself.

## Staging Verification Result (2026-08-06)

Deployed `586522868` (run 31088081600, success). Exercised end-to-end with two real users in the
real shared project `01KJNR9R3TEN3KX1ETE33852R8`: PRIMARY `serverspresentation2025` (owner) and
SECONDARY `dfv31` (admin, so genuinely holds `task:write`). **23/23 checks passed.**

PRIMARY created a task and actually ran it, provisioning a real VM node + workspace — necessary
because a task with no workspace makes `cleanupTaskRun` return early, exercising nothing.

- SECONDARY cancelled PRIMARY's task -> 200 (the widening works); task reached `cancelled`
- PRIMARY's workspace and node both SURVIVED (`running`) — the security guarantee
- SECONDARY's `/run/cleanup` -> 200, compute still `running`
- CONTROL: PRIMARY's own `/run/cleanup` stopped the workspace within 10s — proving the survival
  above is identity-based and not simply broken cleanup
- Cross-project `/status` and `/run/cleanup` with a real task id -> 404 on both
- No unexpected browser console errors

Compute state was read from staging D1 directly rather than the API's own view of itself.

**Cleanup:** node deleted immediately (`DELETE /api/nodes/... -> 200`); node and workspace rows are
gone from D1; staging holds 0 nodes with a Hetzner instance. Pre-test baseline was 0/0.

**Not reachable E2E:** the diverged-owner path (member B runs member A's task) could not be
exercised on staging because `/run`'s credential gate is caller-scoped and SECONDARY has no
cloud-provider credential. Covered by discriminating real-SQLite unit tests instead. The gate is a
real defect that blocks this feature for members without their own cloud credential — filed as
`tasks/backlog/2026-08-06-run-gate-ignores-platform-cloud-credential.md`.
