# VM Size Minimum Selection Post-Mortem

## What Broke

A task or project could request a larger VM size, but node reuse treated the requested size as a preference instead of a minimum. A `large` request could therefore reuse a `medium` node when no exact `large` node was selected first.

## Root Cause

The standalone selector and TaskRunner node selection paths sorted by exact VM-size match, but did not reject undersized candidates. The original standalone selection path was introduced around `apps/api/src/services/node-selector.ts:selectNodeForTaskRun()` in commit `c002c20c0`; warm-node selection was added in commit `6be266364`. The TaskRunner reuse path in `apps/api/src/durable-objects/task-runner/node-steps.ts:tryClaimWarmNode()` and `findNodeWithCapacity()` was added in commit `f5a2cecff` with the same preference-only semantics.

## Timeline

- 2026-02-23: Standalone node selection established capacity and load checks without VM-size minimum filtering.
- 2026-02-24: Warm-node reuse added to standalone selection without VM-size minimum filtering.
- 2026-04-03: TaskRunner node selection helpers added with exact-size preference but no undersized-node rejection.
- 2026-05-01: User reported a possible `large` default resulting in `medium` execution; investigation confirmed the reuse path could allow this class of failure.

## Why It Wasn't Caught

Existing tests checked selector structure and default resolution, but did not execute realistic D1/DO node selection scenarios with mixed VM sizes. Source-contract tests could confirm that a preference sort existed, but not that undersized nodes were excluded.

## Class Of Bug

Selection logic treated a hard compatibility constraint as a soft ranking preference. This is especially risky in reuse paths where the system optimizes for existing capacity before provisioning new infrastructure.

## Process Fix

`.claude/rules/10-e2e-verification.md` now requires behavioral coverage for compatibility constraints in resource selection. Tests must exercise mixed compatible and incompatible candidates through the real selector path, not just inspect source or helper functions.
