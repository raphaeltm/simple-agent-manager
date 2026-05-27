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

## Implementation Checklist

- [ ] Gather production evidence for recent `peer disconnected before response` failures.
- [ ] Download and inspect at least one relevant debug package when accessible.
- [ ] Identify exact ACP code path that creates or propagates the error.
- [ ] Determine whether the process exit/disconnect path triggers crash recovery or direct failure.
- [ ] Implement targeted hardening for uncovered peer disconnect cases.
- [ ] Add focused Go tests covering the failure and recovery behavior.
- [ ] Run VM agent tests and broader project checks appropriate to touched files.
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
