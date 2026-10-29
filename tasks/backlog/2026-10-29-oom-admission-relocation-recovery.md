# OOM admission and relocation recovery

SAM task: 01M63AEHMDRQKR45YAYXTAXJ3W. Parent: 01M6364S1M4WHNR1JJZ062B82Y.

## Scope and authorization

Complete measured-memory admission and eviction startup retry recovery, preserving configured reservations, user isolation, ownership and termination proofs. User explicitly waived staging; no production lifecycle/stress fixtures. Deliver green non-draft PR, specialist and best-effort CodeRabbit review, merge and production deployment/basic smoke.

## Research

- Current reservation accounting admits observed memory pressure above safe physical headroom. Preserve declared reservations and add measured headroom admission consistently in ranking and atomic allocation.
- Eviction recovery startup failures retain a snapshot but are classified report-only. Startup clears the source chat binding, so callback replay must resolve exact fenced snapshot identity to recover the same conversation.
- Oct28 source workspaces 01M61R65WX5J59DP9AD3T8ERVC and 01M61RCAQSP61S913NNN74MDGM have moved snapshots identified by eviction_recovery_workspace_id, not current workspace_id. Both chats relocated; first task completed, second sleeping. Coordinate source retirement with cleanup owner; no blanket deletion.
- Hetzner412 is already transient capacity; verify functioning fallback and diagnostics, avoid rewrite.

## Acceptance and checklist

- [ ] Measured pressure prevents unsafe packing; declaration/profile unchanged; concurrent allocation cannot reuse headroom.
- [ ] Startup failure retains conversation and replay retries using exact ownership/generation; stale callbacks cannot steal successor.
- [ ] Recovery retry budget remains bounded with visible terminal exhaustion.
- [ ] Fallback diagnostics distinguish recovered capacity attempt from task terminal failure; reconcile production evidence.
- [ ] Meaningful regression tests and appropriate quality checks pass.
- [ ] Specialist reviews and task-completion validation complete before archive.
- [ ] Green PR, best-effort CodeRabbit, merge, deployment and basic smoke evidenced.

## Coordination

feature.reliability-20261029: cleanup owner owns retirement/legacy fallback and stopped-node clocks; this task owns admission and eviction/recovery. Production evidence and residual blockers must be reported to parent.
