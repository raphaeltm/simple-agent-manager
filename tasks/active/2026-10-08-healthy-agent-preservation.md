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

- [x] Remove task prompt duration kills using session-scoped task identity; retain control-plane inactivity classification and absolute ceiling.
- [x] Protect bounded failure-preservation captures after agent error while retaining abandoned-workspace cleanup.
- [x] Exercise real prompt execution/timeout and orphan-sweep ordering; prove guards by mutation.
- [x] Assess cheap safe failure-cause improvement; document outcome.
- [x] Update affected configuration documentation.
- [ ] Run local quality checks and independent specialist reviews.
- [ ] Coordinate staging lease, refresh binary, provision and verify real VM, clean resources.
- [ ] PR, CI, best-effort CodeRabbit wait, merge and production deployment evidence.
- [ ] Append evidence to idea, complete only after both fixes deploy; publish MERGED/DONE and cancel subscription.

## Acceptance

Healthy task prompt progress survives the previous duration timeout; normal cancellation and API absolute ceiling remain operative. A failed-task snapshot completes despite an error callback and intervening orphan sweep. Stale/exhausted captures remain reclaimable. Regression tests fail when each protection is removed.

## Rules

VM rules 27/54; root rules 62/67; /do review and staging gates. Shared channel reliability-wave-1008 kickoff staging lease and migration claims. No migration planned.

## Implementation evidence

- TaskManaged is bound per SessionHost from session task context (legacy boot context only for its own workspace). Task-managed prompts skip duration deadlines; upstream cancellation/deadlines remain honored. Removed obsolete ACP_TASK_PROMPT_TIMEOUT.
- Both reapers bind existing SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS cutoff and preserve an exact project/chat/workspace preparing/stopping claim after agent error. No migration or widening of resumable agent statuses.
- Real HandlePrompt test emits transcript progress for 9 simulated hours; mutation fails at8h with fatal_error. Scope test distinguishes sibling unmanaged session. Caller deadline remains fatal.
- Real orphan sweep runs while hibernate boundary is deferred; after error flip it preserves running workspace, then capture settles sleeping with WIP artifact. Guard removal stops workspace at midpoint. Initial fixture lacked node_class; mutation revealed exclusion and fixture was corrected to managed.
- Separate mutation checks prove project/workspace/claim/age/status restrictions.
- Typed context deadline and EOF errors now report stable deadline/agent_crash causes without exposing raw provider error text.
- Typecheck19 tasks passed. Go ACP/config/server suites passed. Affected API suites77 tests passed plus cleanup SQL fixture suites. Full quality checks in progress.

Review findings addressed: canonical environment reference retired old knob; Instant real reaper midpoint added; chat/sleeping-state and stopping clock/fallback mutation controls all red when removed. Local specialist reviews (Go, Cloudflare, environment, constitution, test, task completion, docs) PASS. Full lint13/13 and build9/9 passed. Full test run capped at two workers after resource-driven import/worker startup timeouts; still running.
