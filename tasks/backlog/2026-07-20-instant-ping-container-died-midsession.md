# Instant container died mid-session during production verification ping; no parent-side terminal path for dead-node children

> **Reconciliation 2026-10-05:** #2230 widened this. VM teardown now sets tasks to `sleeping` (`apps/api/src/services/session-sleep-teardown.ts:214-230`), and MCP `ACTIVE_STATUSES` (`apps/api/src/routes/mcp/_helpers.ts:322`) does not include it, so `stop_subtask` and `send_message_to_subtask` refuse a slept child (`routes/mcp/orchestration-comms.ts:146`), even though `sleeping → cancelled` is an allowed transition (`services/task-status.ts:37`). That part is tracked with the other `sleeping` gaps in `2026-10-05-sleeping-task-status-follow-ups.md`. The node-not-running refusal this file describes is unchanged (`orchestration-comms.ts:190-204`).

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - Instant sessions now recover across container loss (PR #1660, 9a7ceab7a).
>   - The stuck-task sweep treats an Instant lifecycle in true `error` as conclusively dead and
>     fails the task, putting the liveness reason in `errorMessage`
>     (`apps/api/tests/unit/stuck-task-container-liveness.test.ts:67`;
>     `apps/api/src/scheduled/stuck-tasks.ts:1366,1408`).
> - **Still open:** `stop_subtask` (and `send_message_to_subtask`) still reject a child whose
>   node is not `running` before any DB transition
>   (`apps/api/src/routes/mcp/orchestration-comms.ts:192-203`). Add the DB-side terminal path
>   plus a regression test (a live-node child must still get the runtime stop first).
> - **Moot/dropped:**
>   - Root-causing this specific death: the PR #1660 evidence points to container rollouts (this
>     incident happened during a post-deploy check, though that is not proven), and recovery now
>     handles that case.
>   - Checking how long the sweep took for task `01KY03K1GHVK2HMBWRNQ82YC94`: superseded by the
>     sweep behaviour above.

## Problem

During post-deploy verification of PR #1643 (dispatch_task runtime routing), a
production Instant (cf-container) session died after a successful boot and
agent start, and the surrounding lifecycle tooling could not resolve it:

1. The container node entered `status: error` mid-session (some time between
   15:52 and 16:15 UTC), while the agent was mid-turn.
2. The task stayed `in_progress` with `errorMessage: null` — indistinguishable
   from healthy work — for at least 25 minutes after the last observed agent
   activity.
3. The parent task could neither message nor stop the child:
   `send_message_to_subtask` and `stop_subtask` both fail with
   `MCP error -32602: Child workspace node is not running (status: error)`.
   `stop_subtask`'s contract says it updates the task to `failed`, but it
   refuses before reaching the DB transition when the node is dead — exactly
   when a terminal transition is most needed.

The dispatch-routing feature itself worked: the dispatch response reported
`runtime: cf-container` / `runtimeReason: explicit-cf-container` (profile-
resolved), no VM was provisioned, the chat session was created asynchronously,
`get_task_details` returned the new `sessionId` field, task-mode bootstrap
instructions were injected, the container booted, and the agent produced
output. The failure is in the instant runtime/lifecycle layer, not the routing.

## Context (discovered 2026-07-20, ~15:51–16:20 UTC, production)

- Parent task: `01KXZZ84T5EHS0XJ8ZT6ZT6B67` (PR #1643 follow-up session)
- Child ping task: `01KY03K1GHVK2HMBWRNQ82YC94`
- Chat session: `a3cd2d30-e615-4009-a130-14b1dda1d62b`
- Workspace: `01KY03K4GJGAE2KQ9TGTE67RHC`; agent session: `01KY03KNM25B9YB9SHFTT0SH3Q`
- Timeline: dispatched 15:51:21 → session created 15:51:24 → bootstrap
  injected 15:51:56 → agent first output 15:52:02 → agent began chunk-reading
  the oversized `get_instructions` payload (109 KB, overflowed to a file)
  15:52:03 → no further persisted activity → 16:15+ parent control calls
  rejected with node `status: error`.
- Likely contributing factor: the agent's only in-flight work was reading the
  ~109 KB `get_instructions` overflow file (known payload-size issue; byte-cap
  direction already captured in project knowledge/ideas).
- Related but distinct: `tasks/backlog/2026-07-19-instant-launch-stuck-queued-on-disconnect.md`
  covers launch-phase disconnects (task stuck `queued`); this incident is
  post-boot death (task stuck `in_progress`).

## Acceptance Criteria

- [ ] Root-cause the container death from cf-container node observability
      (why did the node enter `error` while the agent was mid-turn?).
- [ ] Verify node-error reconciliation terminal-failed task
      `01KY03K1GHVK2HMBWRNQ82YC94`, record how long it took, and ensure the
      resulting `errorMessage` names the node error (not a generic stuck-task
      message). If no sweep caught it, that is the primary bug.
- [ ] `stop_subtask` (and any parent-side lifecycle control) can terminally
      fail a child task whose node is dead or errored, via a DB-side
      transition, instead of erroring out — with a regression test per the
      lifecycle-control guidance in `.claude/rules/02-quality-gates.md`
      (assert the terminal transition happens even when the runtime command
      cannot be delivered, and that a live-node child still gets the runtime
      stop first).
- [ ] Fold the oversized `get_instructions` payload factor into the existing
      byte-cap idea/work rather than duplicating it.
