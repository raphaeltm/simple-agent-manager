# Sleeping VM conversation archive

SAM task: 01M4AXHCABJMF6TYXCFH5V843E
Source Idea: 01M47PYF4XAJ0GZZ8KJP3XBBKH

## Problem and research
VM sleep now persists task status sleeping (#2230), but the conversation close route only accepts in_progress/delegated. Normal dock Archive therefore fails. The close route uses owner-scoped workspace cleanup, with workspace/runtime identity fencing and snapshot purge before final lifecycle closure. The shared transition table also lacks sleeping→completed. MCP completion belongs to an active runtime; do not allow stale sleeping callbacks. Cancellation already includes sleeping; delete has no status restriction.

## Checklist
- [ ] Reconcile latest main and active task/PR scopes; coordinate siblings and staging occupants.
- [ ] Accept sleeping conversation close and audit complete/cancel/delete allowlists.
- [ ] Preserve authorization and strengthen archive task race fencing if required.
- [ ] Verify immediate owned workspace/snapshot cleanup, retry/failure safety and idempotence without unrelated deletion.
- [ ] Add real SQLite route regression tests including failure, races and authorization.
- [ ] Update affected documentation and source Idea.
- [ ] Run applicable lint/typecheck/test/build and independent specialist reviews.
- [ ] Coordinate staging deployment and archive a sleeping VM chat from normal dock; clean owned resources.
- [ ] Task-completion validation before archiving evidence.
- [ ] PR/CI, best-effort CodeRabbit, merge, production deployment proof.

## Acceptance
Sleeping VM chat archives from normal confirmed dock action. Owned restore snapshots/workspace are removed through authorized existing cleanup; other owners remain untouched. Racing wake/assignment changes fail safely; repeated archive cannot duplicate lifecycle events or strand retryable cleanup. Awake dock remains Sleep. Real SQLite tests execute lifecycle writes. Staging and production evidence recorded before completion.

## References
apps/api/src/routes/tasks/crud.ts; services/task-status.ts; services/workspace-cleanup.ts; services/workspace-deletion.ts.
Rules 09, 13, 25, 79; sibling tasks 01M4AXFSY11GR95XTD2N68ZE6F and 01M4AXGMEWDEH8KRRQ4X0CW824.
