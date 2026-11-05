# Task fails "boot-failed node" for a node that became healthy

## Problem

On staging, task `01M6NHFEGH0QSDPXSJKYBY8532` (Claude Code VM, lightweight workspace, project
`hono`) failed at step `node_agent_ready` with:

> Cannot safely replace boot-failed node 01M6NHFR6BTNF6YGAJT8YEZDFK: ownership or empty-node proof missing

The node was created at 09:43:51Z and reported `agent_ready_at` 09:46:55Z (about 3 minutes, the
normal boot time for cx33 that morning). The task failed at 09:51:36Z. The node then stayed
`running`/`healthy` with no workspace, counted against the user's node capacity, and blocked the
next two tasks in `waiting_for_node_capacity` until it was deleted by hand.

So the TaskRunner judged the node boot-failed even though it became ready, then refused to
replace it, and nothing released it.

## Context

Found 2026-11-05 during live-steering staging verification (PR #2536). Three VM tasks were being
provisioned concurrently on the same user at the time.

## Acceptance Criteria

- [ ] Find why `node_agent_ready` declared the node boot-failed although `agent_ready_at` was set
      about 5 minutes before the failure (race between readiness callback and the step deadline,
      or reading the wrong record).
- [ ] A node the task gives up on is either reused, released to the warm pool, or deleted; it
      must not keep holding the user's node capacity with no workspace.
- [ ] Regression test through the real TaskRunner step with the readiness callback landing late.
