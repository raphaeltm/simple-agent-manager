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
- [ ] Run applicable lint/typecheck/test/build and independent specialist reviews.
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
- Independent Cloudflare/security reviewer identified pre-existing human-wake terminal status guard in session-recovery.ts (claim-first/archive-second can requeue completed task); requested narrow coordinated fix from contract sibling. Merge-blocking until resolved and re-reviewed.
- Independent test/constitution/doc reviewer PASS. No new URLs/timeouts/limits; existing configurable deletion retry bounds retained. No UI changes, normal confirmation and awake Sleep preserved.
- Direct task-only push to main rejected by required Durable Object Workers check; task evidence stays in feature PR rather than bypassing repository rules.
