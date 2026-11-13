# Flaky: node-lifecycle-decisions test orders two rows written in the same millisecond

## Problem

`apps/api/tests/workers/node-lifecycle-decisions.test.ts` "records handed_to_warm alongside the DO
marked_warm decision" expects `['node_lifecycle:marked_warm', 'warm_handoff:handed_to_warm']`.
`listNodeLifecycleDecisions` (`services/node-lifecycle-decisions.ts`) orders by
`created_at DESC, id DESC`, and `id` is `ulid()`. When both decisions land in the same
millisecond, the order depends on the random part of two ULIDs, so the test fails about half the
time in that case. The same tie affects the operator-facing decision list (two decisions of one
handoff can appear in either order).

## Context

Seen in manual CI run 43384184489 (branch sam/task-f1-close-findings-jnfgr5, Durable Object
Workers shard 1/3) while working on task F1; the branch does not touch node lifecycle code.

## Acceptance criteria

- [ ] Decisions written by one operation keep their write order when `created_at` ties (a
      monotonic id, or a sequence column)
- [ ] The test asserts order with a forced same-millisecond write, and passes repeatedly
