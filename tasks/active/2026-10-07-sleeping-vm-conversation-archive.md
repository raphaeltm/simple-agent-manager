# Sleeping VM conversation archive

SAM task: 01M4AXHCABJMF6TYXCFH5V843E
Source Idea: 01M47PYF4XAJ0GZZ8KJP3XBBKH

## Problem and research
VM sleep now persists task status sleeping (#2230), but the conversation close route only accepts in_progress/delegated. Normal dock Archive therefore fails. The close route uses owner-scoped workspace cleanup, with workspace/runtime identity fencing and snapshot purge before final lifecycle closure. The shared transition table also lacks sleeping→completed. MCP completion belongs to an active runtime; do not allow stale sleeping callbacks. Cancellation already includes sleeping; delete has no status restriction.

## Checklist
- [x] Reconcile latest main and active task/PR scopes; coordinate siblings and staging occupants.
- [x] Accept sleeping conversation close and audit complete/cancel/delete allowlists.
- [x] Preserve authorization and strengthen archive task race fencing if required.
- [x] Verify immediate owned workspace/snapshot cleanup, retry/failure safety and idempotence without unrelated deletion.
- [x] Add real SQLite route regression tests including failure, races and authorization.
- [x] Update affected documentation and source Idea.
- [x] Run applicable lint/typecheck/test/build and independent specialist reviews.
- [ ] Coordinate staging deployment and archive a sleeping VM chat from normal dock; clean owned resources.
- [ ] Task-completion validation before archiving evidence.
- [ ] PR/CI, best-effort CodeRabbit, merge, production deployment proof.

## Acceptance
Sleeping VM chat archives from normal confirmed dock action. Owned restore snapshots/workspace are removed through authorized existing cleanup; other owners remain untouched. Racing wake/assignment changes fail safely; repeated archive cannot duplicate lifecycle events or strand retryable cleanup. Awake dock remains Sleep. Real SQLite tests execute lifecycle writes. Staging and production evidence recorded before completion.

## References
apps/api/src/routes/tasks/crud.ts; services/task-status.ts; services/workspace-cleanup.ts; services/workspace-deletion.ts.
Rules 09, 13, 25, 79; sibling tasks 01M4AXFSY11GR95XTD2N68ZE6F and 01M4AXGMEWDEH8KRRQ4X0CW824.

## Implementation evidence
- Close accepts sleeping and completed cleanup retry; CAS predicates cover project/status/updatedAt/workspace, and completion clears executionStep.
- Cleanup retry/fenced/superseded returns 409 with explicit preserved/pending state; completed retry retains completedAt and does not duplicate events.
- Real SQLite tests include actual cleanupWorkspaceForDeletion → workspace-deletion → snapshot R2 deletion → lifecycle finalizer; unrelated snapshot remains untouched. Focused 300 tests passed before adding cancellation/delete sleeping variants.
- Allowlist audit: task-status sleeping→completed is human completion; sleeping→cancelled already exists. Delete is status-independent and has owner-scoped destructive cleanup. MCP complete_task remains active-only deliberately, rejecting stale runtime completion. Callback guards retain exact runtime assignment authorization. Sleeping is deliberately excluded from TASK_EXECUTION_STATUSES (wake goes through queued).
- Independent Cloudflare/security review found archive/wake ordering races. Resolved wholly in archive-owned close route: D1 transaction completes task and revokes exact caller-owned chat snapshot sleepingAt/recoveryAttemptId. This fences both new claims and already-claimed wake batches while retaining keys until authorized deletion. Existing terminal human-followup behavior remains supported; no sibling runtime files changed. Re-review PASS (14 integration tests independently run).
- Independent test/constitution/doc reviewer PASS. No new URLs/timeouts/limits; existing configurable deletion retry bounds retained. No UI changes, normal confirmation and awake Sleep preserved.
- Direct task-only push to main rejected by required Durable Object Workers check; task evidence stays in feature PR rather than bypassing repository rules.

- Latest focused suite: 306 tests across four files PASS. Neighbor snapshot test uses the same owner/project/workspace but different chat and verifies its recovery state/objects survive. Actual close + ensureSessionRecovery archive-first/claim-first tests refuse revival, preserve workspace linkage, and start no runner. SQLite trigger-abort test proves transaction rollback leaves task sleeping. Full lint 13 tasks, typecheck 19 tasks, build 9 tasks PASS.

- Full API suite: 820 files / 11,499 tests PASS; full web suite: 336 files / 4,023 tests PASS, both with maxWorkers=2. Initial root turbo run completed 19/21 tasks before unrelated web timing failures interrupted API; bounded full reruns resolved all four timing failures. No unrelated code changes. Shared staging still reserved by webhook Deploy Staging run 37607076979; waiting explicit release before coordinated candidate deployment.

## Post-mortem
### What broke
The normal sleeping VM conversation dock offered Archive, but the close route rejected the newly persisted sleeping task status.
### Root cause
VM sleep began writing sleeping in #2230; close's in_progress/delegated allowlist and sleeping transition table were not reconciled. Route mocks alone did not cover the actual SQLite transition and snapshot cleanup boundary.
### Class of bug
A new lifecycle enum value omitted from an existing action allowlist, with a concurrent wake boundary requiring transactional fencing.
### Why it was not caught
Existing close coverage omitted sleeping and did not exercise actual recovery claims against archive.
### Process fix
Existing rule 79 already requires auditing every enum gate, so no duplicate standing guidance is added. This task records complete/close/cancel/delete audit decisions; regression tests exercise real SQLite close, actual authorized cleanup, both wake orderings, and atomic rollback.
