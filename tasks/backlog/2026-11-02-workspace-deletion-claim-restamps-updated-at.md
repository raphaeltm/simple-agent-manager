# Workspace deletion retries re-stamp `updated_at` and delay the empty-node handoff

## Problem

`claimWorkspaceDeletionInD1` (`apps/api/src/durable-objects/node-lifecycle-workspace-deletion-support.ts`)
sets `updated_at = now` on every deletion attempt, including retries of a row that is already
`stopping`. `LAST_WORKSPACE_ACTIVITY_SQL` (`apps/api/src/scheduled/node-cleanup/shared.ts`), read by the
empty-node warm-handoff backstop (`scheduled/node-cleanup/empty-node-warm-handoff.ts`), treats that
column as workspace activity, so each retry pushes the backstop out again. This is the
liveness-as-idleness class from `apps/api/.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
(a retry writer moving a clock another step schedules on).

## Context

Found while investigating node `01M69PPA2GA4WQBQMTDB97CXZ2` (production, 2026-11-02), in
`tasks/active/2026-11-02-node-escape-unpinning-wait-reasons.md` (finding "Fix B"). Not the cause of
that node's 37-hour life (that was the completed-task drain, fixed in the same PR). Deletion retries
back off to one hour, so the delay is bounded at about an hour per retry, and bounded stranded-node
retirement (#2478) still retires the node. Deferred from that PR because `updated_at` on `stopping`
rows has other readers (stuck-stopping and deployment sweeps), so leaving it stale needs a reader
inventory first.

## Acceptance Criteria

- [ ] Every reader of `workspaces.updated_at` for `stopping` rows is listed with what it decides
- [ ] The handoff backstop no longer moves when a deletion attempt is retried (either the claim stops
      re-stamping, or the backstop reads a column only real workspace activity writes)
- [ ] A worker test drives real failed deletion attempts and the real handoff sweep, and asserts the
      node is handed off on time; proven red against the current code
- [ ] No other sweep changes behaviour (one test per affected reader)
