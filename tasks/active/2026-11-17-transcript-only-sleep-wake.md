# Transcript-only sleep fallback is unwakeable on VMs

SAM task `01M7MZJ9SABQGBK3DS6H5GGR8Z`, idea `01M7MMR6KK57PVFS3E57NJZ3N0`.

## Problem

When a VM chat's sleep exhausts its snapshot budget and the bounded fallback records no Git
recovery point, the snapshot is left `degradation = 'transcript-only'` with a slept fallback
record whose `recoveryPoint` is null. Every later wake fails and the chat is stuck for good.

Production: chat `edc476d7-2efb-42dd-8f73-f6e10d51407c` failed four wakes on 2026-11-17 with
`Strict session restore failed (transcript-replay)`.

## Root cause (contract mismatch across two hops)

1. `sessionSnapshotRestoreResponse()` (`apps/api/src/services/session-snapshot-restore-response.ts`)
   answers `{available: false, reason: 'transcript_only_sleep_fallback'}`.
2. The VM agent's `restoreSessionSnapshot()` (`packages/vm-agent/internal/server/session_snapshot_restore.go`)
   maps `!Available` to a successful `{status: 'transcript-replay', reason}`, without touching the
   agent session (it stays pristine) and after the workspace was already provisioned by
   create-workspace.
3. `shouldStartFreshAfterSnapshotRestore()` (`apps/api/src/services/agent-session-bootstrap.ts`)
   accepts only `restored` or `degraded` and throws on `transcript-replay`.

Policy a3780107 / 2adacc8f require a labelled degraded recovery that starts fresh from the
transcript in exactly this case. The VM recovery task already sends the transcript-only wake
prompt (`sessionRecoveryInitialPrompt(record)` in `session-recovery-task.ts`), so only the
bootstrap classification is wrong. Instant has its own working path
(`instantTranscriptFallbackStart`).

## Research findings

- No test fed the VM agent's `transcript-replay` answer into the bootstrap (rule 23 gap). The Go
  tests only `strings.Contains` the status.
- `transcript-replay` is also returned for `snapshot_missing_or_unavailable` (snapshot vanished
  between claim and restore). That case is out of scope and stays strict: the tolerance is
  scoped to the transcript-only reason (rule 67).
- The wake's later commit (`completeSessionSnapshotRecoveryGeneration`) does not depend on the
  restore status, and `snapshotRestoreComplete` stays false so no source workspace is released.
- `agent-session-bootstrap.ts` is 535 lines; split before adding (rule 18).
- Worker-only fix: deployed VM agents already send `reason`. No rollout coupling (rule 54).
- Upstream trigger (WIP ~473 MB over the 256 MB budget forced `wip-skipped`, then transcript-only)
  is a separate follow-up, noted on the idea, not in this PR.

## Checklist

- [ ] Move ACP lifecycle helpers from `agent-session-bootstrap.ts` into their own module
- [ ] Classify the restore outcome: `restored`, `degraded`, or `transcript_only`
      (`transcript-replay` + `transcript_only_sleep_fallback`); everything else still throws
- [ ] Share the reason constant between the restore response and the classifier
- [ ] Persist an honest transcript-only system notice (no restore claimed)
- [ ] Shared contract fixture `tests/fixtures/session-snapshot-restore-transcript-only-v1.json`
- [ ] Go: real restore handler maps the fixture's control-plane body to the fixture's VM body
- [ ] TS: real fallback sleep produces the fixture's control-plane body through the real route
- [ ] TS: real TaskRunner `handleAgentSession` fed the fixture's VM body starts the agent fresh,
      commits the wake and moves the task to `in_progress`
- [ ] Controls: `snapshot_missing_or_unavailable` and unknown statuses still fail
- [ ] Discrimination: revert the classifier change, confirm the TaskRunner test goes red
- [ ] Note the WIP-over-budget follow-up on the idea

## Acceptance criteria

- A VM wake of a transcript-only sleeping chat starts a fresh agent with the transcript-only wake
  prompt and the task reaches `in_progress` (test + staging where possible).
- A restore answer of `transcript-replay` for any other reason still fails closed.
- The chat gets a system notice that does not claim a restore.
