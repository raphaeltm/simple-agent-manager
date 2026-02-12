# Idle Shutdown Follow-Up (Backlog)

Date: 2026-02-11  
Scope: `specs/014-multi-workspace-nodes`

## Decision

Automatic idle shutdown is deferred and explicitly out of scope for the multi-workspace Nodes feature.

Current behavior target:
- Node and Workspace lifecycle changes are explicit (`stop`, `restart`, `delete`).
- No automatic stop/delete is triggered by idle timers.

## Why Deferred

- Existing idle behavior is coupled to the legacy 1 Workspace = 1 VM model.
- Multi-workspace Nodes require a clear strategy for Node-level vs Workspace-level idleness before re-introducing auto-shutdown safely.

## Revisit Criteria

- Stable Node/Workspace/Agent Session hierarchy in production-like staging.
- Clear policy choice:
- Node-level idle only, or
- Workspace-level idle only, or
- Hybrid with conflict resolution and explicit precedence.
- End-to-end tests covering reconnect, long-running background jobs, and multi-workspace same-node workloads.

## Suggested Future Work Items

- Define canonical idle semantics and state transitions.
- Add explicit product UX for idle warnings and countdowns.
- Add telemetry for false-positive shutdowns and user interruption rates.
- Re-introduce auto-shutdown behind a feature flag with staged rollout.
