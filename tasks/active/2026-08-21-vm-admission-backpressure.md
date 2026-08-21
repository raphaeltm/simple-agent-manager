# VM task/session admission control and node-packing backpressure

## Problem

Production saw Hetzner `server limit reached` failures because concurrent VM cold starts can each fail to see a reusable running node, then independently provision. A single newly provisioned compatible same-user node may be able to host several of those workspaces, but today's TaskRunner instances have no shared admission gate before provider allocation.

This task implements the smallest production-safe backpressure slice on current `main`: visible durable admission state plus a fenced provisioning lease around the existing TaskRunner node-selection/provisioning boundary. It must preserve existing placement rules: same-user isolation, VM-size compatibility, node health/version checks, project scaling limits, and the atomic workspace reservation CAS.

## Research findings

- Idea `01M0FV9VBP8ZATBG2E63R8GD0M` and research task `01M0G26W1P86CBCG3G4YQYNBMB` identify the root failure: independent TaskRunner DOs run `node_selection → node_provisioning` without a shared user/provider admission gate.
- User task submit, MCP dispatch, trigger submit, and mission dispatch all converge on durable task/session creation plus `startTaskRunnerDO()`. The TaskRunner is the smallest shared enforcement point.
- Current reusable-node selection already enforces same-user isolation, `canSatisfyVmSize`, health, heartbeat, agent-version compatibility, warm-node claiming, and project `maxWorkspacesPerNode`/CPU/memory thresholds.
- `reserveWorkspacePlacement()` is already the final atomic slot owner; this task must reuse it and reselect after lost placement.
- Provider `server_limit_exceeded` must become a retryable admission/capacity wait, not terminal task failure. Auth/invalid config remain terminal.
- Valid admission waits must not be failed by stuck-task reconciliation just because the task is still `queued`.
- The task explicitly forbids staging mutation and merging. Verification is local deterministic tests plus CI; the PR remains draft with a staging plan for a later serialized task.

## Implementation checklist

- [ ] Add additive D1 migration/schema for VM task admissions, provisioning leases, and provider capacity state.
- [ ] Add shared task execution step/labels for `waiting_for_node_capacity`.
- [ ] Add env-backed admission controls: mode (`off|shadow|enforce`), lease TTL, retry bounds, max wait, wake batch/cooldown knobs.
- [ ] Implement an admission service that registers VM tasks idempotently, records placement reasons, acquires/renews/releases fenced leases, reconciles expired leases, and stores sanitized provider capacity evidence.
- [ ] Integrate TaskRunner node selection so no-node-found flows through admission before provisioning, and lease winners re-run selection after acquiring the claim.
- [ ] Integrate TaskRunner provisioning so stale tokens cannot mutate providers, provider server-limit errors become wait/cooldown, and terminal/cancel/failure paths release or cancel admissions safely.
- [ ] Wake/retry admission waits via bounded alarms and direct nudges from node-ready/workspace release cleanup where safe.
- [ ] Preserve trigger/mission semantics: waiting tasks remain visible/active and are not duplicated.
- [ ] Extend admin/task diagnostics and task/session response fields with admission state/reason/next retry where bounded.
- [ ] Add deterministic concurrency/race tests for fan-out suppression, lease fencing/expiry/recovery, provider-capacity wait, cancellation escape, same-user isolation, VM-size compatibility, and existing-node packing.
- [ ] Update docs/configuration and migration/rollback notes.
- [ ] Run required specialist reviews: constitution-validator, test-engineer, cloudflare-specialist, security-auditor, doc-sync-validator; go-specialist only if VM agent code changes.
- [ ] Open a draft PR with exact SHA, local experiment evidence, CI status, migration/rollback notes, no-staging note, staging plan, and any remaining phased scope.

## Acceptance criteria

- Concurrent same-user compatible cold starts perform at most one provider create before that node becomes reusable; waiters remain visibly queued with a stable capacity/admission reason.
- Waiters wake and pack onto compatible same-user existing nodes through the existing selector plus `reserveWorkspacePlacement()`.
- Same-user isolation remains strict; medium never satisfies large, while large may satisfy medium.
- Lease fencing prevents stale owners from provisioning or releasing another owner's claim after expiry/reacquire.
- Hetzner/provider `server_limit_exceeded` is classified as provider-account capacity and waits/retries within bounded configuration.
- Cancelled/terminal tasks leave admission and lease state safely and do not pin capacity forever.
- Ordinary submit, MCP dispatch, triggers, and mission dispatch are covered by the shared TaskRunner gate, or any intentionally phased path is documented with safe behavior.
- Stuck-task reconciliation preserves healthy admission waits and only fails at the admission wait deadline.
- All limits/timeouts/retry bounds are configurable; no new hardcoded policy constants.

## References

- SAM idea `01M0FV9VBP8ZATBG2E63R8GD0M`
- Research task `01M0G26W1P86CBCG3G4YQYNBMB`
- `apps/api/src/durable-objects/task-runner/node-steps.ts`
- `apps/api/src/durable-objects/task-runner/node-selection.ts`
- `apps/api/src/services/workspace-placement.ts`
- `apps/api/src/routes/tasks/submit.ts`
- `apps/api/src/routes/mcp/dispatch-tool.ts`
- `apps/api/src/services/trigger-submit.ts`
- `apps/api/src/durable-objects/project-orchestrator/scheduling.ts`
