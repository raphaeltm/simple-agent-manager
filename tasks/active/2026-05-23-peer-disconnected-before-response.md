# Investigate recurring ACP peer disconnect task failures

## Problem

SAM tasks keep failing with:

```json
{"code":-32603,"message":"Internal error","data":{"error":"peer disconnected before response"}}
```

The failure originates in the ACP layer when the agent process disconnects before completing a response. The investigation must determine whether recently merged crash recovery via `LoadSession` covers this case, and implement additional hardening if it does not.

## Constraints

- Execute with the `/do` workflow.
- Do not merge the PR. Leave it ready for human review.
- Coordinate staging deployment with other active staging deploys before triggering.
- Use production/staging evidence and debug packages before making claims.

## Research Plan

- Inspect recent failed tasks and identify nodes/workspaces that emitted `peer disconnected before response`.
- Download relevant debug packages and inspect VM agent logs, Docker logs, process state, ACP traces, and system OOM/timeout indicators.
- Trace the error origin in `packages/vm-agent/internal/acp/`.
- Check task completion callback handling in `packages/vm-agent/internal/server/server.go`.
- Check ProjectData task/session state handling in `apps/api/src/durable-objects/project-data/`.
- Compare observed failure mode against the recently merged crash recovery path via `LoadSession`.
- Check for stale workspace or container state that may still run pre-crash-recovery behavior.

## Research Findings

- Production D1 (`sam-prod`) contains 24 tasks with the exact `peer disconnected before response` error between 2026-05-15 and 2026-05-22. The latest observed failure updated at 2026-05-22T07:09:41.503Z.
- The LoadSession crash-recovery feature merged in commit `34fe25e4` at 2026-05-22T12:12:36Z, about five hours after the latest observed production failure. Current main therefore has a recovery path the observed failures did not have.
- Pattern by task mode: 18 task-mode failures with no profile hint, 5 conversation-mode failures with no profile hint, and 1 conversation-mode failure using profile `01KS4XBW9QPMMBXP8EWH8EHBY2` (`AMP Tester`, `openai-codex`).
- Pattern by node: failures cluster on deleted nodes, especially `01KS4SVNP7EDWB3842HQRQKEB8` (4) and `01KRRZP2JBQAPJ2G6SWCT52Y3V` (3). All recent affected nodes queried are now `deleted`, so normal debug-package download is no longer available. A current-node debug package attempt through the API using the available MCP token returned 401; localhost VM-agent debug endpoint was not reachable from the workspace.
- The current workspace is not stale: production D1 shows workspace `01KSA6ZMP1ECGPJ7R4JE4HA63D` running on healthy node `01KSA6W131DKG0X0FS7TE0423B`, linked to this task `01KSA6VYJJDGECCCX8H6NPGGG5`, with no task error.
- Code path: `SessionHost.finishPromptWithError` classifies `peer disconnected` as a crash prompt error via `isCrashPromptError`. If `agentSupportsLoadSession` is true and an ACP session ID is available, it calls `beginCrashRecovery`, waits for `monitorProcessExit`, restarts the agent, calls ACP `LoadSession`, then notifies prompt completion with stop reason `recovered`. The VM-agent task callback maps `recovered` to `executionStep=awaiting_followup` instead of `toStatus=failed`.
- Gap found: if the crash is not recoverable because LoadSession is unavailable, the existing code fell through to generic prompt failure and surfaced the raw JSON-RPC error blob. That is still a terminal failure, but it is not actionable and gives no crash report context.

## Implementation Checklist

- [x] Gather production evidence for recent `peer disconnected before response` failures.
- [x] Download and inspect at least one relevant debug package when accessible.
- [x] Identify exact ACP code path that creates or propagates the error.
- [x] Determine whether the process exit/disconnect path triggers crash recovery or direct failure.
- [x] Implement targeted hardening for uncovered peer disconnect cases.
- [x] Add focused Go tests covering the failure and recovery behavior.
- [x] Run VM agent tests and broader project checks appropriate to touched files.
- [ ] Run required specialist review for Go/VM agent changes.
- [ ] Deploy to staging only after checking active staging deployments.
- [ ] Create PR on `sam/investigate-resolve-recurring-peer-01ksa6` and do not merge.

## Acceptance Criteria

- Root cause is documented with code-path evidence and available log/debug evidence.
- Peer disconnects caused by agent process death are handled by crash recovery when resumable instead of immediately failing the task.
- Non-resumable peer disconnects still produce actionable failure detail.
- Tests prove the peer-disconnect handling behavior.
- PR is ready for human review and explicitly not merged.

## References

- `packages/vm-agent/internal/acp/`
- `packages/vm-agent/internal/acp/session_host_prompt.go`
- `packages/vm-agent/internal/acp/session_host_process.go`
- `packages/vm-agent/internal/server/server.go`
- `apps/api/src/durable-objects/project-data/`
- `.claude/rules/14-do-workflow-persistence.md`
- `.claude/rules/32-cf-api-debugging.md`
