# Preserve healthy agents and failed-task snapshots

Source: idea 01M4DR5SFBBZZ99SFVKYD8ZD0X; SAM task 01M4DV3CTCZBNN09E2CMK37W66.

## Problem
Node-wide 8h prompt deadlines kill productive tasks before the control-plane absolute ceiling. Error activity callbacks also remove failed-task snapshot ownership, allowing the orphan sweep to destroy unpushed work during capture.

## Research
- server.go selects prompt timeout once from boot TASK_ID; agent_ws.go already resolves per-session task context.
- SessionHost newPromptContext and watchPromptTimeout enforce the duration deadline.
- sleep-preserved-task-status.ts requires a resumable agent even during a claimed preservation snapshot; both VM and Instant reapers consume it.
- Existing snapshot in-flight age and attempt limits must still release stale/exhausted captures.
- Existing failed-task integration tests provide real SQLite and sleep lifecycle with replaceable VM capture boundary, suitable for a controlled orphan-sweep midpoint.

## Checklist
- [ ] Remove task prompt duration kills using session-scoped task identity; retain control-plane inactivity classification and absolute ceiling.
- [ ] Protect bounded failure-preservation captures after agent error while retaining abandoned-workspace cleanup.
- [ ] Exercise real prompt execution/timeout and orphan-sweep ordering; prove guards by mutation.
- [ ] Assess cheap safe failure-cause improvement; document outcome.
- [ ] Update affected configuration documentation.
- [ ] Run local quality checks and independent specialist reviews.
- [ ] Coordinate staging lease, refresh binary, provision and verify real VM, clean resources.
- [ ] PR, CI, best-effort CodeRabbit wait, merge and production deployment evidence.
- [ ] Append evidence to idea, complete only after both fixes deploy; publish MERGED/DONE and cancel subscription.

## Acceptance
Healthy task prompt progress survives the previous duration timeout; normal cancellation and API absolute ceiling remain operative. A failed-task snapshot completes despite an error callback and intervening orphan sweep. Stale/exhausted captures remain reclaimable. Regression tests fail when each protection is removed.

## Rules
VM rules 27/54; root rules 62/67; /do review and staging gates. Shared channel reliability-wave-1008 kickoff staging lease and migration claims. No migration planned.
