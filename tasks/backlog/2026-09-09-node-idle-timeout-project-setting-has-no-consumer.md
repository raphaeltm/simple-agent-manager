# Project "Node Idle Timeout" setting has no consumer

## Problem

`projects.node_idle_timeout_ms` is exposed as an editable field in the project
**Infrastructure → Scaling & Scheduling → Node Scheduling** UI
(`apps/web/src/components/ScalingSettings.tsx`), validated against
`MIN_NODE_IDLE_TIMEOUT_MS` / `MAX_NODE_IDLE_TIMEOUT_MS`, persisted by
`apps/api/src/routes/projects/project-update.ts`, and returned to the client by
`apps/api/src/lib/mappers.ts`. **Nothing reads it.**

`grep -rn "nodeIdleTimeoutMs" apps/api/src/scheduled/ apps/api/src/durable-objects/`
returns nothing, and no service consumes `project.nodeIdleTimeoutMs`. For contrast,
the sibling `warmNodeTimeoutMs` on the same UI section is consumed in several
places (`session-sleep.ts`, `node-selection.ts`, `state-machine.ts`,
`session-sleep-lifecycle-repair.ts`, `dispatch-task.ts`).

Node idleness is actually governed by `NODE_WORKSPACE_IDLE_TIMEOUT_MS` in
`apps/api/src/scheduled/node-cleanup/shared.ts`, which has no per-project override.

The UI carries the comment `{/* Node Idle Timeout — existing dead column, now wired up */}`,
which is now misleading: the field is wired to _persistence_, not to _behaviour_.

## Context

Found while writing the public Compute Pools guide
(`tasks/active/2026-09-09-document-compute-pools.md`, PR #2050). The field was
deliberately left out of that guide — documenting a control that does nothing
would be worse than omitting it — so this is tracked here instead.

This is the rule-06 "UI-to-Backend Data Path Verification" red flag: a form field
whose value reaches the database and stops there.

## Acceptance Criteria

- [ ] Decide the intent: either per-project node idle timeout is a real feature, or it is not.
- [ ] If it IS: thread `project.node_idle_timeout_ms` into the node cleanup sweep's idle
      window (`claimNodeForCleanup()` in `apps/api/src/scheduled/node-cleanup/shared.ts`)
      alongside the existing `NODE_WORKSPACE_IDLE_TIMEOUT_MS` env default, following the
      `resolveProjectScalingConfig` precedence pattern the other scaling fields use. Add a
      behavioural test proving a project override changes which nodes a sweep claims, and
      document the control in the Compute Pools guide's "Warm reuse" section.
- [ ] If it is NOT: remove the field from `ScalingSettings.tsx`, drop it from
      `UpdateProjectRequest`/`Project` types, the update route's validation, and the mapper.
      Leave the column in place (rule 31 — do not recreate a CASCADE-parent table just to
      drop a column) with a comment recording that it is intentionally unused.
- [ ] Either way, correct or delete the stale `existing dead column, now wired up` comment.
- [ ] Add a regression guard so a persisted-but-unconsumed scaling field is caught next
      time — e.g. extend the scaling-settings tests to assert every `SCALING_PARAMS` key and
      every project scaling column has at least one non-test consumer.

## Notes

- `MIN_NODE_IDLE_TIMEOUT_MS` / `MAX_NODE_IDLE_TIMEOUT_MS` and the placeholder
  (`DEFAULT_NODE_WARM_TIMEOUT_MS`) are already exported from
  `packages/shared/src/constants/scaling.ts`.
- Note that this field is NOT in `SCALING_PARAMS`; it is rendered as a hand-written row
  next to the generated ones, which is likely why it escaped the wiring the others got.
