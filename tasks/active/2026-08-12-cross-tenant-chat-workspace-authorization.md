# Fix cross-tenant chat workspace attachment and teardown authorization

## Problem

`POST /api/projects/:projectId/sessions` accepts a caller-provided `workspaceId` and persists it on both the new task and ProjectData session without verifying that the workspace belongs to the route project and caller. The session archive path later trusts that link and invokes terminal cleanup without caller scope, allowing an attacker to attach another tenant's workspace and archive the session to trigger destructive cleanup.

Scope is audit finding CT-01 only. Preserve every valid API response and shared-project workflow; reject only unauthorized or inconsistent workspace links with non-disclosing not-found behavior.

## Audit Evidence and Independent Verification

- Strict CTO audit task `01KZSZ5HDBARX61Q0PCASP1650`, session `c9487e09-e90d-4e46-84af-f8ecf30f178c`, finding CT-01: “Attacker-controlled chat workspace attachment enables cross-tenant teardown” (High, 99%, ship blocker).
- The audit identifies `CreateChatSessionSchema`, `apps/api/src/routes/chat.ts`, `apps/api/src/routes/chat-stop.ts`, `apps/api/src/services/task-terminal-cleanup.ts`, and `apps/api/src/services/task-runner.ts` as the exploit chain.
- Independently re-verified on `origin/main` at `fc1e394217248c3bd004b2e6619cf2344eade7e3` on 2026-08-12:
  - `CreateChatSessionSchema` accepts optional `workspaceId`.
  - `POST /sessions` trims and persists that ID without a workspace lookup.
  - `chat-stop.ts` calls `cleanupTerminalTaskResources` without `requiredUserId`.
  - `task-terminal-cleanup.ts` reads the linked workspace by ID alone and mutates session state before calling `cleanupTaskRun`.
  - `cleanupTaskRun` treats an omitted `requiredUserId` as an internal caller and tears down resources under the workspace owner's identity.
- Active SAM tasks and open GitHub PRs were checked before editing; none duplicates CT-01. Adjacent audit tasks target trigger IDOR and preview cookie isolation and remain out of scope.

## Compatibility Constraints

- Creating a session without `workspaceId` remains unchanged.
- A project member with `task:write` may attach a workspace they own inside that shared project.
- Project-scoped shared task/session state remains usable by authorized members.
- Nodes and workspaces remain user-scoped resources; another member cannot destroy them.
- Existing internal completion paths may still clean up legitimate task runtime resources when their task/workspace/project identities agree.
- Response shapes and success status codes remain unchanged for valid requests.

## Implementation Checklist

- [x] Add discriminating tests that fail on current `main` for foreign-user, foreign-project, missing/stale, and mismatched workspace attachment.
- [x] Add valid compatibility controls for no-workspace creation and same-project caller-owned workspace attachment.
- [x] Validate caller-supplied workspace attachment against both caller and route project before any task or ProjectData session write.
- [x] Add terminal-cleanup tests for foreign user/project workspace links, stale/mismatched task records, legitimate same-project cleanup, and zero destructive boundary calls on rejection.
- [x] Revalidate task, project, workspace, and caller scope before ProjectData session mutation or compute teardown.
- [x] Preserve trusted internal cleanup semantics with explicit identity consistency checks.
- [x] Add a process-rule improvement covering caller-controlled relationship attachment plus destructive-use revalidation.
- [x] Run focused tests, API checks, repository fast/full gates, and prove new tests are discriminating against the pre-fix code.
- [ ] Run task-completion, Cloudflare, security, constitution, documentation-sync, and test specialist reviews plus a fresh independent adversarial bypass review; resolve credible findings.
- [ ] Open exactly one non-draft PR against `main`, do not deploy to staging, do not merge, and monitor all applicable CI checks to green.

## Acceptance Criteria

- Foreign-user, foreign-project, missing, or inconsistent `workspaceId` input cannot create a linked task/session and receives non-disclosing not-found behavior.
- An authorized project member can still create an unbound session or attach their own workspace in that project with the existing response contract.
- Archive/completion cleanup performs no ProjectData stop/fail call, VM workspace stop/delete, container/node stop, workspace status update, or deletion scheduling when task/workspace/project/caller identities do not authorize teardown.
- Legitimate same-project, caller-owned chat archive still stops the session and performs normal cleanup.
- Trusted internal task completion still cleans legitimate resources, while stale cross-project task/workspace links fail closed.
- Tests exercise the real route/service code with real SQLite predicates and realistic boundary state, and are proven to fail when the new guards are removed.
- No unrelated audit finding, UI behavior, migration, or public documentation change is bundled.

## References

- `.claude/rules/02-quality-gates.md`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/34-vm-agent-callback-auth.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `tasks/archive/2026-08-05-shared-project-task-authorization-lookup.md`
- `apps/www/src/content/docs/docs/architecture/security.md`

## Post-Mortem

### What broke

An authenticated project member could supply another tenant's `workspaceId` while creating a chat.
The ID was persisted on the task and ProjectData session, and archiving that attacker-owned session
could follow the stale link into container/node teardown under the victim workspace owner's identity.

### Root cause

Commit `8766f976a3` (2026-02-22, project-first architecture) introduced the caller-controlled chat
workspace attachment without resolving the workspace against caller and route-project scope. Commit
`56cb8ba9d5` (2026-07-11, teardown leak fix) later connected chat archival to terminal runtime cleanup
without threading the caller identity. Commit `d590ec5626` (2026-07-16, task-backed chat) persisted the
same unverified relationship on D1 tasks. Cleanup correctly used the workspace owner for trusted
internal completion, but the archive path accidentally entered that trusted mode because it omitted
caller scope. The vulnerability was the interaction of those individually useful changes.

### Timeline

- 2026-02-22: arbitrary workspace attachment became possible.
- 2026-07-11: archive began destructive runtime cleanup, completing the exploit chain.
- 2026-07-16: task-backed chat duplicated the unverified relationship across D1 and ProjectData.
- 2026-08-12: strict CTO audit CT-01 identified the chain; independent verification reproduced it on
  `origin/main` at `fc1e394217248c3bd004b2e6619cf2344eade7e3`.

### Why it was not caught

Existing tests covered route-level project authorization and cleanup behavior independently. They did
not build the complete creation-to-archive lifecycle with a foreign workspace, and several cleanup
tests used chainable database mocks whose `where()` implementation did not evaluate ownership or
project predicates. No test asserted both non-disclosing rejection and zero calls at every destructive
system boundary while retaining a valid owner/shared-project control.

### Class of bug

This was a caller-controlled relationship confused with a trusted persisted relationship: scope was
not checked when the link was attached and was not revalidated before destructive dereference. It was
also a mock-hidden integration failure across D1, ProjectData, and runtime cleanup boundaries.

### Process fix

`.claude/rules/28-credential-resolution-fallback-tests.md` now requires authorization at both
relationship attachment and destructive use, real-SQLite scoping tests, stale/cross-store mismatch
attacks, zero destructive-boundary assertions, and legitimate owner/shared-project controls. The new
vertical suite demonstrated discrimination before the implementation: 7 attacks failed on current
main while 6 compatibility controls passed. After independent review added cross-store backlink,
pre-repair mutation, and `stop_subtask` boundary cases, a guard-removal run failed all 5 added attacks
while 16 controls/previous cases passed. With every guard restored and the reviewer-requested legacy
task compatibility control added, all 22 vertical scenarios pass.
