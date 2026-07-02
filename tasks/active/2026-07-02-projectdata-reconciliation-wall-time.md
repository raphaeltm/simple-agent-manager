# Fix ProjectData Reconciliation Alarm Wall-Time Regression

## Problem

The ProjectData Durable Object alarm path is spending excessive wall time inside the task-session reconciliation sweep. PR #1348 broadened candidate selection, which un-stalled reconciliation, but it exposed synchronous VM-agent delivery calls to dead or unreachable nodes from inside the DO `alarm()` handler. A dead node can burn the full node-agent timeout, and multiple candidates can serialize into 40s+ alarm invocations.

This task implements the fixes from SAM idea `01KWH2QKQHND5WG54FVVZPW577`.

## Constraints

- Execute via `/do`.
- Use branch `sam/fix-projectdata-alarm-wall-01kwh5`.
- Human-approved exception from Raphaël: skip staging deployment/verification. Do not trigger `deploy-staging.yml`. Note this explicitly in the PR description.
- All new timeouts, thresholds, and caps must be env-configurable with `DEFAULT_*` constants.
- Follow `.claude/rules/45-durable-object-concurrency-mutex.md`, `.claude/rules/11-fail-fast-patterns.md`, `.claude/rules/42-no-untracked-degrading-placeholders.md`, and `.claude/rules/43-long-running-mcp-tools.md`.

## Research Findings

- `apps/api/src/durable-objects/project-data/index.ts` invokes reconciliation work from the DO alarm.
- `apps/api/src/durable-objects/project-data/reconciliation.ts` contains candidate selection, check-in send, cancel handling, and workspace delivery target resolution.
- `apps/api/src/durable-objects/project-data/attention-expiry.ts` handles expired attention markers and is the existing deadline-based terminal path for unanswered check-ins.
- `apps/api/src/durable-objects/project-data/message-persistence.ts` resolves check-in attention markers when the agent responds.
- `apps/api/src/services/node-agent.ts` has the current node-agent request timeout used by VM-agent HTTP calls.
- `packages/shared/src/constants/reconciliation.ts` contains shared reconciliation timing constants.
- The main failure mode is a missing Layer 0 liveness check: dead or missing nodes are retried every sweep before any attention marker can fail the task.
- Two zombie escape hatches must be closed:
  - `cancel_prompt` and `observe_prompt` actions do not create attention markers, so dead-node candidates can loop forever.
  - `resolveWorkspaceDeliveryTarget()` returning null for workspaces with no `node_id` logs and skips with no terminal action, so those candidates can loop forever.
- Check-in send can be moved to `ctx.waitUntil()` after the reconciliation attention marker is persisted. Send failure is already handled by marker expiry.
- Cancel delivery must preserve the 409 stale-mirror repair path.

## Implementation Checklist

- [ ] Add env-configurable liveness heartbeat freshness threshold and reconciliation sweep candidate cap using `DEFAULT_*` constants.
- [ ] Add a Layer 0 node/workspace liveness gate before any VM-agent delivery in reconciliation.
- [ ] Route dead/missing-node candidates to terminal cleanup/failure rather than attempting VM-agent fetches.
- [ ] Ensure dead-node `cancel_prompt` and `observe_prompt` candidates are terminally handled and are not re-selected on the next sweep.
- [ ] Ensure workspace-without-`node_id` candidates are terminally handled and are not re-selected on the next sweep.
- [ ] Move check-in sends off the alarm critical path with `ctx.waitUntil()`, preserving `reconciliation.send_prompt_failed` structured logs.
- [ ] Keep cancel 409 stale-mirror repair behavior while limiting alarm-path wall time.
- [ ] Bound each sweep by candidate cap and process the capped batch with `Promise.allSettled`.
- [ ] Add regression tests for:
  - dead node leads to terminal path and no fetch;
  - healthy node still delivers;
  - dead-node `cancel_prompt` and `observe_prompt` candidates do not loop;
  - workspace with no `node_id` does not loop;
  - unrelated newer reporter rows remain unchanged;
  - check-in marker is persisted before async send;
  - async send failure logs and does not reject alarm work;
  - cancel 409 repair still fires;
  - many candidates do not serialize.
- [ ] Run local validation: targeted tests, then relevant repo quality checks.
- [ ] Run required specialist reviews and address findings.
- [ ] Open PR with wall-time reasoning and the explicit no-staging exception.

## Acceptance Criteria

- Reconciliation does not make VM-agent HTTP calls for dead, missing, stale-heartbeat, or no-node workspaces.
- Zombie candidates from marker-less actions and missing node targets receive a terminal disposition.
- Check-in delivery no longer blocks the alarm after the marker is persisted.
- Cancel stale-mirror repair remains covered by tests.
- Per-alarm work is capped and parallelized so wall time is bounded by the slowest candidate in the capped batch rather than serial `N * timeout`.
- Tests prove the regression cases and reporter scoping behavior.
- PR is pushed to `sam/fix-projectdata-alarm-wall-01kwh5`, CI is checked, and staging is explicitly skipped per instruction.
