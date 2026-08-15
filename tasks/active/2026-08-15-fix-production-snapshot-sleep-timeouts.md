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

Staging verification of the race fix on 2026-08-15 then proved the sleep side complete but exposed a
wake-side contract gap. Fresh VM node `01M02RBPRESCV29VTACQ5NMCBY` heartbeated branch vm-agent
`139dafc7f3ca868a6704a8572e9fec8cca8b5ec3`; task `01M02RBKBPC3YS3H9K7KTQSCQP`, session
`b5035ca7-1374-44ce-81af-f0c80252b2c9`, workspace `01M02RK46QMGKB3HFBQTSTJG04`, slept
successfully. D1 recorded a consistent degraded transcript-only snapshot:
`status='degraded'`, `degradation='transcript-only'`, `sleep_status='sleeping'`,
`capture_generation=NULL`, `snapshot_generation='01M02RNYPVSHB3X7BVKDZCGF4X'`, `manifest_json`
present, `sleeping_at='2026-08-15T13:11:53.580Z'`, and the workspace/agent session were both
`sleeping`. The manifest visibly skipped `workspace-snapshot` because snapshot capture made no
progress for 120000ms.

The subsequent prompt wake failed with `recovery_error='Strict session restore failed (degraded)'`.
The vm-agent correctly returned `status='degraded'` when ACP `LoadSession` could not restore exact
agent context, but the control-plane bootstrap treated that expected degraded result as fatal.
Additionally, vm-agent retained the previous ACP identity after a failed strict restore so a naive
fresh start could retry `LoadSession` instead of creating a new ACP session. The staging node and
workspace were deleted immediately after collecting the D1 evidence; staging returned to zero active
nodes/workspaces.

Staging verification of the first degraded-wake fallback patch on commit
`6e28023aaa498e44a83bed4f56fa0f0c37eea5d0` proved the sleep path again and exposed the final
vm-agent routing-state gap. Task `01M02TQT2ZPNDMSTK8Z7HTXD1J`, session
`6130673f-ce2b-4a5f-af07-d038f9e505ec`, workspace `01M02TWCEF0D90WM9D2W1VFX4J`, node
`01M02TQXAMTM1WD3YNAFZ2GXGR`, slept successfully with snapshot
`01M02TXW1VKMA581XRD8CVKZY2`: `status='degraded'`, `degradation='transcript-only'`,
`sleep_status='sleeping'`, `capture_generation=NULL`, `snapshot_generation='01M02V0M50PPG193XJH8DA3VZK'`,
manifest present, workspace/agent `sleeping`. Wake then failed with
`recovery_error='Node Agent request failed: 409 {"error":"session is not running"}'`; the recovery
agent-session row later showed `session already exists` on retry. That proved vm-agent strict restore
failure marked the routing session `error`; cleanup must return the same routing session to
`running`, clear the error, and clear stale ACP identity before control-plane fresh fallback calls
`/start`. The staging node/workspaces were deleted immediately after collecting evidence; staging
returned to zero active nodes/workspaces.

Staging verification of the vm-agent routing reset patch on commit
`d23b81f55dff47db1dff084f7644ea6025949569` then proved the sleep path again and exposed the
ProjectData ACP lifecycle half of the same degraded-wake problem. Task
`01M02WKCG01G4B9JF6MHC9HH60`, session `3178c079-cb0c-43f5-8d43-e7093960970b`, workspace
`01M02WVJS0RVG24QJZ25MT0JAB`, node `01M02WKFV0GX3DQP1VJMS70CPH`, slept successfully with
snapshot `01M02WY953DA46DP3NV5GNJBWC`: `status='degraded'`,
`degradation='transcript-only'`, `sleep_status='sleeping'`, `capture_generation=NULL`,
manifest present, and workspace/agent `sleeping`. Wake created recovery task
`01M02X57Y2BPYQ44K3T69FW89R`; strict restore degraded as expected, vm-agent accepted the fresh
fallback, but ProjectData rejected the final control-plane transition with
`recovery_error='Invalid ACP session transition: failed → running (session 01M02X6ADX0KKMPNG3YFGV5ES2)'`.
That proved the strict-restore error path had already transitioned the ProjectData ACP row for the
same vm-agent session ID to `failed`. A generated replacement ProjectData row is not a valid fix
because vm-agent activity callbacks address `/acp-sessions/{sessionId}`, where `{sessionId}` is the
vm-agent/control-plane agent session ID. The fix therefore resets that same ProjectData ACP row back
to `assigned`, clears the strict-restore terminal fields, then lets the successful fresh fallback
transition the same row to `running`. The staging node/workspaces were deleted immediately after
collecting evidence; staging returned to zero active nodes/workspaces.

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
- [x] On degraded restore, explicitly clear vm-agent strict-restore host/ACP identity and let the
      recovery TaskRunner start a fresh ACP session against the restored workspace.
- [x] Reset the vm-agent routing session from strict-restore `error` back to `running` during
      degraded fallback cleanup so the fresh `/start` request is accepted.
- [x] Reset the same ProjectData ACP row from strict-restore `failed` back to `assigned` during
      degraded fallback, preserving the vm-agent callback session ID and clearing stale terminal
      fields before marking the fresh session `running`.
- [x] Reset the D1 `agent_sessions` row to `running` after degraded fresh fallback succeeds so a
      strict-restore error callback cannot leave the recovered session visibly failed.
- [x] Use a wake-specific recovery prompt so degraded fresh fallback waits for the queued follow-up
      instead of rerunning the source task title.
- [x] Verify degraded snapshot manifests and any artifacts they do contain before teardown.
- [x] Preserve fail-visible retry behavior for true pre-teardown errors without permanently
      stranding an awake workspace.
- [x] Add rule-02 regressions for slow-but-progressing snapshots and stalled/no-progress snapshots.
- [x] Add cross-boundary contract coverage for snapshot progress and degraded completion handling.
- [x] Add degraded-wake regression coverage for control-plane fallback and vm-agent strict-restore
      cleanup.
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
- After the second staging verifier found the degraded wake gap, focused API regressions passed:
  `pnpm --dir apps/api test -- --run tests/unit/durable-objects/task-runner-agent-session.test.ts
  tests/unit/services/session-recovery.test.ts tests/unit/services/session-sleep.test.ts
  tests/unit/session-snapshots.test.ts` (4 files, 39 tests).
- Post wake-fallback patch API lint passed: `pnpm --dir apps/api lint`.
- Post wake-fallback patch API typecheck passed: `pnpm --dir apps/api typecheck`.
- Post wake-fallback patch full API suite passed: 540 files, 7,242 tests.
- Post wake-fallback patch `pnpm format:check` and `git diff --check` passed.
- Same-ID ACP recovery patch focused unit passed:
  `pnpm --filter @simple-agent-manager/api test -- tests/unit/durable-objects/task-runner-agent-session.test.ts`
  (1 file, 11 tests).
- Same-ID ACP recovery patch API typecheck passed:
  `pnpm --filter @simple-agent-manager/api typecheck`.
- Same-ID ACP recovery patch API lint passed:
  `pnpm --filter @simple-agent-manager/api lint`.
- Same-ID ACP recovery patch full API suite passed:
  `pnpm --filter @simple-agent-manager/api test` (540 files, 7,242 tests).
- Same-ID ACP recovery patch `pnpm format:check` and `git diff --check` passed.
- Added ProjectData worker regression coverage for the same-ID `failed → assigned → running`
  recovery primitive. Local `@cloudflare/vitest-pool-workers` execution for the single filtered test
  timed out after 180s without a test result in this container; staging Worker deploy and live
  verification remain the authoritative validation for that DO RPC path.
- The current local container no longer has `go`/`gofmt` on PATH, so the new vm-agent cleanup test
  is pending GitHub CI's Go 1.25 toolchain. The Go change is limited to
  `packages/vm-agent/internal/server/session_snapshot.go` and
  `packages/vm-agent/internal/server/session_snapshot_test.go`.

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
