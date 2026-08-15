# Fix production snapshot sleep timeouts that strand workspaces awake

**Priority**: Production incident
**Created**: 2026-08-15
**SAM task**: `01M02HNZPJ82CQGV07DG2BGFGQ`
**Output branch**: `sam/investigate-fix-production-workspace-2bgfgq`

## Problem

Production completed/idle VM sessions are failing their final workspace snapshot and remain
`RUNNING` instead of releasing compute. At approximately 2026-08-15 11:45 UTC, production D1 had
four `session_snapshots` rows dated 2026-08-15 with:

```text
sleep_status='failed'
sleep_error='Workspace snapshot did not complete within 300000ms'
```

Two additional rows from 2026-08-14 failed with degraded snapshot errors. This began immediately
after the 2026-08-14 snapshot upload changes in PR #1821 and PR #1822.

The current behavior breaks the aggressive-sleep policy: completed and idle sessions must sleep
promptly and release compute, while preserving resumable state and surfacing snapshot degradation or
retry state visibly.

## Production evidence

Initial D1 inspection on 2026-08-15 found the failing class split into three concrete states:

1. Two active stuck snapshots on current vm-agent nodes, not stale binaries:
   - snapshot `01M023WR56SPVV8XKWETK9BYTQ`, chat
     `235e41bf-b88d-400f-94f8-2941787b9962`, workspace
     `01M023KDPA21MNTT5ENA4H6TFY`, node `01M01ZQ4D2DKJKBVSZHCN68J4H`
   - snapshot `01M0205H7ZNDD8F6SQC6WBC1GJ`, chat
     `728ba604-a74c-42d9-9063-77accd3a2915`, workspace
     `01M01ZWHYHRQNWTH7GE0AYVNQH`, node `01M01ZQ4D2DKJKBVSZHCN68J4H`
   - node `01M01ZQ4D2DKJKBVSZHCN68J4H` was created on
     `2026-08-15T05:53:33.602Z` and heartbeated `agent_version`
     `68701ee479be24dc285fbaec07a697d3a8374fa0`
   - both rows remained `status='pending'`, had a `capture_generation`, no
     `snapshot_generation`, `sleep_attempts=9`, and workspaces still `running`
2. One active stuck row on a current vm-agent completed as degraded but still failed sleep:
   - snapshot `01M019VD...`, workspace `01M019MR8SG4G9P0VT27HMY0RA`, node
     `01M019CSMZPS37ASAWW5TB0JTA`
   - node heartbeated current `agent_version`
     `68701ee479be24dc285fbaec07a697d3a8374fa0`
   - snapshot `status='degraded'`, `degradation='home-skipped'`, with a manifest that skipped
     `$HOME` because the archive exceeded the remaining 256 MiB budget
   - `sleep_status='failed'`, `sleep_error='Automatic sleep retry budget exhausted'`, workspace
     still `running`
3. One older-row degraded relay failure on a stale vm-agent path:
   - snapshot `a65557eb-c300-4ace-9e15-696997a7af73`, workspace
     `01KZXVCREXM055NQE6287Y6ABX`
   - stale node version `718fe83...` produced `degradation='transcript-only'`
   - manifest skipped both WIP and HOME uploads with:
     `remote error: tls: handshake failure` against relay node
     `01M0077ZFVV7K7YE0X0XT5A589`
   - the relay node itself was current for the PR #1822 generation:
     `agent_version='b54d268c5425f62549c6d6c2bff05834d9fed4d6'`

Cloudflare Worker log queries were inconclusive because production log sampling is enabled at 1%;
absence of matching log events was not treated as evidence of absence.

## Root cause

The active production failures are not explained solely by stale binaries. Current vm-agent nodes can
leave `session_snapshots.capture_generation` pending until the Worker-side 300s wait expires, and
the control plane then burns the retry budget while leaving the workspace awake.

The code path had two fail-closed gaps:

1. A vm-agent background snapshot failure after `/session-snapshot/prepare` logs locally but never
   calls back to put the D1 row into a terminal `failed` or `degraded` state. The Worker only polls
   `capture_generation` and times out after a fixed wall clock.
2. The sleep path currently requires `status='available' AND degradation='none'` before releasing
   compute. Production already has resumable degraded manifests (`home-skipped`,
   `transcript-only`) that should sleep per the updated incident policy instead of stranding VMs.

There was also a rule-43 shape issue: snapshot capture scales with workspace contents, but the
Worker wait used a fixed 300s wall clock without an explicit progress/idle watchdog contract.

The stale-node relay TLS failure remains part of the evidence and must be covered by the release
contract: degraded relay outcomes must be durable, visible, retryable where appropriate, and must not
permanently strand the workspace.

Staging verification of the first fix attempt on 2026-08-15 exposed one additional race before PR:
fresh VM node `01M02PETXYHTVCPV13QFW9WHCR` heartbeated the branch vm-agent
`50c1c3fba82925f7bf29d8a5d25e1fff56e9b7b7`, task
`01M02PEQRBHJ1HGCWA5DJM3VWE` reached idle, and explicit sleep returned 200. However the late
background capture prepared a newer generation after sleep finalization and overwrote the D1 row
back to `status='pending'`, `capture_generation='01M02PT8VZADS7M0037F3WS4A6'`, while preserving
`sleep_status='sleeping'` and clearing no resumable `manifest_json`/`sleeping_at`. That proved the
sleep path also needed generation-safe final-state re-read and stale prepare protection. The failed
staging node/workspace were deleted immediately after collecting the D1 evidence; staging returned
to zero active nodes/workspaces.

## Implementation checklist

- [x] Make the final snapshot wait use an environment-configurable no-progress watchdog instead of
      an undersized fixed wall-clock for size-scaled capture.
- [x] Add durable snapshot progress reporting from current vm-agents so slow-but-progressing capture
      extends the wait while stalled/no-progress capture is terminalized.
- [x] Make vm-agent progress callback interval/timeout explicit env-backed config and pass those
      values through cloud-init and Instant container launch.
- [x] Ensure vm-agent archive/capture work observes context cancellation and reports progress during
      long HOME walks or uploads.
- [x] When a background capture stalls after `/prepare`, durably complete the generation as a
      degraded transcript-only snapshot (or another explicit degraded terminal state) so the
      workspace can sleep and stale late completions are rejected by generation matching.
- [x] Prevent late snapshot `prepare` calls from reopening or corrupting a finalized sleeping
      snapshot row, and preserve degraded checkpoints the same way available checkpoints are
      preserved during replacement capture.
- [x] Re-read D1 after synthetic degraded completion and proceed only when the same generation is
      terminal and has no active `capture_generation`.
- [x] Treat verified degraded snapshots as releasable for completed/idle sleep, while retaining
      visible degradation/sleep warning state.
- [x] Make degraded sleeping snapshots claimable for the VM wake path so the release contract and
      wake contract use the same restorable/degraded predicate.
- [x] Verify degraded snapshot manifests and any artifacts they do contain before teardown.
- [x] Preserve fail-visible retry behavior for true pre-teardown errors without permanently
      stranding an awake workspace.
- [x] Add rule-02 regressions for slow-but-progressing snapshots and stalled/no-progress snapshots.
- [x] Add cross-boundary contract coverage for snapshot progress and degraded completion handling.
- [x] Update public lifecycle/API docs so they match the incident policy: complete/idle sessions may
      sleep on a verified degraded snapshot instead of keeping compute alive forever.
- [ ] Verify on staging with fresh vm-agent nodes: a real session sleeps end-to-end, workspace
      releases, and the session is resumable on wake.
- [ ] Delete all staging nodes/workspaces immediately after verification.
- [ ] Open PR, wait for CI, merge, monitor production deployment, and re-query production D1.

## Acceptance criteria

- Current vm-agent snapshots that make progress beyond 300s are not failed solely because of a fixed
  Worker wall clock.
- Current vm-agent snapshots that stop making progress after prepare become a durable terminal
  degraded snapshot rather than a permanently pending capture.
- A completed/idle workspace with a verified degraded snapshot releases compute, records visible
  degradation/warning state, and remains restorable.
- Failed sleeps remain visible and retryable; exhausted pre-teardown failures do not leave a
  completed/idle workspace awake indefinitely when a degraded resumable state can be preserved.
- Regression tests cover slow-progress vs stalled/no-progress behavior and the degraded sleep
  release path.
- Staging proves real VM sleep/wake with zero residual staging VMs at rest.
- CI is green, the PR is merged, production deploy completes, and production D1 shows the incident
  rows no longer progressing into new stranded `RUNNING` workspaces.

## Local validation evidence

- API lint passed: `pnpm --filter @simple-agent-manager/api lint`.
- API typecheck passed: `pnpm --filter @simple-agent-manager/api typecheck`.
- Full API unit suite passed: 539 files, 7,240 tests.
- Focused API regressions passed: 7 files, 80 tests covering scheduled repair of exhausted rows,
  degraded sleep release, slow-progress vs no-progress final snapshot behavior, progress route
  contract, degraded artifact verification, Instant container env pass-through, provision-node
  cloud-init env pass-through, and D1-backed active-generation terminalization.
- Cloud-init validation passed: typecheck, build, full unit suite (193 tests).
- Focused vm-agent snapshot tests passed with Go 1.25.0.
- `go build ./...` and `go vet ./...` passed in `packages/vm-agent`.
- Full `go test ./...` in `packages/vm-agent` is blocked in this local container by existing
  Docker-dependent tests failing with `exec: "docker": executable file not found in $PATH`
  (`internal/pty`, `internal/server`).
- `pnpm format:check` passed.
- After the first staging verifier found the late-prepare race, focused API regressions passed
  again: `pnpm --filter @simple-agent-manager/api test -- tests/unit/session-snapshots.test.ts
  tests/unit/services/session-sleep.test.ts tests/unit/scheduled/session-sleep.test.ts
  tests/unit/routes/workspaces-session-snapshots.test.ts` (4 files, 59 tests), followed by API lint
  and API typecheck.

## Coordination constraints

Avoid files owned by concurrent work:

- `apps/api/src/durable-objects/task-runner/state-machine.ts`
- `apps/api/src/durable-objects/project-data/idle-cleanup*`
- `apps/api/src/durable-objects/task-runner/workspace-branch.ts`
- `apps/api/src/durable-objects/task-runner/workspace-steps.ts`
- `apps/api/src/scheduled/node-cleanup/*`
- `apps/api/src/services/workspace-placement.ts`
- `packages/vm-agent/internal/server/agent_ws.go`

Expected implementation surface:

- `apps/api/src/services/session-sleep.ts`
- `apps/api/src/services/session-snapshot-*`
- `apps/api/src/routes/workspaces/session-snapshots.ts`
- `packages/vm-agent/internal/server/session_snapshot*`

## References

- `apps/api/src/services/session-sleep.ts`
- `apps/api/src/services/session-snapshot-persistence.ts`
- `apps/api/src/services/session-snapshot-upload-relay.ts`
- `.claude/rules/39-debug-before-redesign.md`
- `.claude/rules/43-long-running-mcp-tools.md`
- `.claude/rules/54-vm-agent-rollout-compatibility.md`
- `.claude/rules/27-vm-agent-staging-refresh.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
