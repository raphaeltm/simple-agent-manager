# Sleeping Instant workspaces are pushed into deletion and then cannot wake

Consolidates four backlog records plus one idea:

- `tasks/backlog/2026-11-03-sleeping-instant-workspace-queued-for-deletion.md`
- `tasks/backlog/2026-11-03-cf-container-workspace-deletion-stuck-request-failed.md`
- `tasks/backlog/2026-11-02-slept-instant-workspace-deletion-stuck.md`
- `tasks/backlog/2026-11-05-instant-sleeping-container-cannot-wake.md`
- Idea `01M6NK55J6CJSAZHCB9D1PNZ8A`

SAM task `01M6WSRK4VG2EB9RT87BZTXBSX`, branch `sam/stability-fix-instant-cf-ztxbsx`.

## Problem

An idle Instant (cf-container) chat sleeps in place: its container DO sleeps, and the workspace,
node and snapshot rows are marked `sleeping`. A follow-up wakes the same container from its
snapshot. On staging, these workspaces are queued for deletion. Every attempt fails with
`request_failed`, the workspace moves to `stopping`, and the next follow-up is refused with
"The sleeping container runtime is gone and cannot wake in place."

## Evidence (staging, 2026-11-08 05:3xZ)

Five cf-container workspaces were `stopping` while the node and snapshot were still `sleeping`:
`01M6VP7CX38SKTV7DRMZV9VHC0` (attempt 16), `01M6VYJS0WAGWVGJ9A3PJHMHA2` (13),
`01M6WBZT3GYJ2C9E6XT3911X6C` (9), `01M6VXXENFH30CP76RV1A013K1` (13),
`01M6WEZ1BVA9Q2119ARZ0TBFC0` (8).

Worker log timeline for `01M6WEZ1BVA9Q2119ARZ0TBFC0`:

- 02:17:16 `session_sleep.queued` (Task completed). 02:17:24 snapshot `available`/`none`.
- 02:19:31 `vm_agent_container_runtime_sleeping`.
- 02:31:41 `node_lifecycle.workspace_deletion_scheduled` (`delayMs` 60000). This is the
  stale-workspace safety net: `node_cleanup.stale_stopped_workspace_queued` logs for all five
  workspaces on every cron tick.
- 02:32:44 onward: `workspace_deletion.unconfirmed` `VM attempt N (Error: request_failed)`.
- Hourly `node_cleanup.cf_container_terminal_task_destroy_failed`: "Node retirement blocked by
  unconfirmed workspace artifacts". The terminal-container phase picks the row because
  `w.status = 'stopping'` bypasses its sleep-lifecycle exclusion. The artifacts guard stopped it.

Rows for that node: workspace `eviction_generation = NULL`, node `sleeping`, no termination
proof, one snapshot (`sleeping`, `available`, runtime `cf-container`), no placement claims.

## Root causes

1. **Writer.** `sweepStaleStoppedWorkspaces` (`scheduled/node-cleanup/workspace-phases.ts`)
   selects `sleeping` workspaces that have a preserved snapshot, with no runtime check. A
   sleeping VM must release its VM (the primary writer, `scheduleSleepingWorkspaceDeletion`,
   queues it immediately). A sleeping Instant container *is* the wake target: the primary writer
   returns early for cf-container, and teardown belongs to the snapshot purge
   (`session-snapshot-purge.ts:156`) once retention expires. The safety net did not follow the
   primary writer's policy (rule 58).
2. **Deletion cannot converge.** `requestWorkspaceDeletion` (`services/workspace-deletion.ts`)
   throws `Error('Container deletion requires workspace generation')` for a non-running
   cf-container node whose workspace has no `eviction_generation`. Instant workspaces are never
   evicted, so the column is NULL and **every** deletion of a slept Instant workspace fails,
   explicit or automatic. `deletionFailureDiagnostic` maps that plain `Error` to
   `request_failed`. `requireNodeWorkspaceArtifactsDeleted` has the same requirement. Every
   other deletion identity check treats the generation as nullable (`?? null`, `IS ?`).
3. **Unclear refusal.** When a container is genuinely gone, the refusal text tells the person
   nothing about what to do next.

## Writers that can move a wakeable sleeping Instant workspace toward deletion (rule 44)

| Writer | Path | Behaviour before | Action |
| --- | --- | --- | --- |
| Stale-workspace safety net | `workspace-phases.ts` `sweepStaleStoppedWorkspaces` | Selects `sleeping` cf-container rows | Exclude sleeping cf-container rows. The queue guard below also refuses them |
| Sleep teardown | `session-sleep-teardown.ts` `scheduleSleepingWorkspaceDeletion` | Returns early for cf-container | None |
| Terminal-container phase | `terminal-cf-container-phase.ts` | Excludes sleep-owned rows unless `w.status = 'stopping'` | None. Rows repaired to `sleeping` fall out of its predicate again |
| Task-runner cleanup | `task-runner.ts:249`, `task-runner/state-machine.ts:459` | Runs at task-run cleanup; the workspace is not sleeping then | Covered by the queue guard |
| ProjectData session cleanup | `project-data/index.ts:3279` | Best-effort schedule | Covered by the queue guard |
| Workspace stop route | `workspace-stop.ts:192` | Explicit stop; the row becomes `stopped`, not `sleeping` | None |
| Preservation receipt | `workspace-preservation-receipt.ts:245` | Only after a replacement restore; Instant has none | None |
| Explicit delete / archive / operator delete | `routes/workspaces/crud.ts`, `routes/tasks/crud.ts`, `task-terminal-cleanup.ts` (destructive session end), `operations-actions/executors.ts`, all `cleanupWorkspaceForDeletion({ mode: 'explicit' })` → `claimAttempt` | Intended | Keep. Fixed to converge (root cause 2) |
| Trial expiry | `scheduled/trial-expire.ts` (`cleanupWorkspaceForDeletion({ mode: 'automatic' })` → `claimAttempt`, then strict node delete) | Deliberate end-of-entitlement teardown of an expired anonymous trial's workspaces. Before this PR it hit the same NULL-generation throw | Keep as a deliberate deletion (documented in the guard module). Guarding it would leave every such row as an immortal sweep candidate (rule 47), and an expired trial cannot continue the chat. Strict node deletion still requires every workspace on the node to carry deletion proof first |
| Terminal-node repair | `scheduled/terminal-node-lifecycle-repair.ts` (`mode: 'automatic'`, `requireRuntimeTerminationProof`) | Only for nodes already terminal; has its own `hasProtectedSleep` check | None. `wakeableSleepingInstantSql` requires the node to be `sleeping`, so the two cannot overlap |

The NodeLifecycle queue (`schedule()` and `processDueEntry()`) is the one place every automatic
writer that *schedules* passes through. It now refuses a non-explicit entry for a wakeable
sleeping Instant workspace and repairs a row that a failed automatic attempt left `stopping`. The
repair releases only the exact entry it judged (compare-and-set on claimId, attemptCount and
mode), and restores D1 only by compare-and-set on the observed `error_message` and `updated_at`.
A claim that lands in the D1 await gap therefore always wins (rule 45; review finding from
cloudflare-specialist).

## Status allowlists and denylists checked (rule 79)

- `WORKSPACE_DELETION_ELIGIBLE_STATUSES` includes `sleeping`. VMs need it; the cf-container
  case is handled by the new guard, not by removing the status.
- Automatic claim status predicates (`claimWorkspaceDeletionInD1`, `claimDeletionTransition`)
  include `sleeping`. They are only reached after the queue guard.
- `sweepStaleStoppedWorkspaces` `status IN ('stopped','sleeping','stopping','evicted')`: adds
  the cf-container exclusion for `sleeping`.
- `sweepTerminalCfContainers` `w.status IN (...)` plus `w.status = 'stopping' OR NOT owns`:
  unchanged. It is correct once the row is back to `sleeping`.
- `sweepOrphanedWorkspaces` selects only `running/creating/recovery`: not affected.
- `vm-prompt-delivery-target.ts` `SLEEPING_CONTAINER_WAKEABLE_STATUSES` excludes `stopping`,
  which is correct: a repaired row is `sleeping` again.

## Decision: genuinely gone container

Restoring a cf-container snapshot into a fresh runtime would require a new recovery path:
`ensureSessionRecovery` explicitly refuses cf-container (`session-recovery.ts:249`), and the
parallel VM-wake work is editing that area. With both root causes fixed, a genuinely gone
container should happen only after explicit deletion or snapshot expiry. This PR makes the
refusal tell the person what to do: the message and conversation are kept, and they can fork
the chat or start a new one. The fresh-runtime restore is filed as an idea.

## Implementation checklist

- [x] Nullable workspace generation in container deletion (`workspace-deletion.ts`,
      `node-workspace-retirement-guard.ts`)
- [x] Log the error name and message (not persisted) on `workspace_deletion.unconfirmed`, so the
      throw site is visible next time
- [x] Shared predicate and repair helper for "wakeable sleeping Instant workspace"
      (`services/instant-sleeping-deletion-guard.ts`)
- [x] Safety net excludes sleeping cf-container rows (`workspace-phases.ts`)
- [x] Queue `schedule()` refuses non-explicit entries for wakeable sleeping Instant and repairs
      `stopping` rows
- [x] Queue `processDueEntry()` does the same for already-queued entries (stuck rows converge)
- [x] Clearer `container_runtime_unavailable` refusal text
- [x] Tests: the safety net through `sweepStaleStoppedWorkspaces` with real SQL (Instant
      excluded, VM still queued); queue guard and repair; explicit delete of a slept Instant
      workspace with NULL generation converges; the real integration path (sleep → safety
      net → follow-up wakes)
- [x] Fix `instant-idle-sleep-wake.test.ts` refusal expectations (new text; no test keeps the
      broken behaviour as its contract)
- [x] Discrimination checks: revert each guard and confirm the intended tests go red
- [x] Docs sync (grep for the refusal text and safety-net descriptions)
- [ ] Archive the four backlog files, and update the idea (fresh-runtime restore filed as idea `01M6WVP5YWVX5VGMVGANJKP3N7`)

## Acceptance criteria

- [ ] Every writer named, and wakeable Instant workspaces excluded
- [ ] Rows wrongly moved to `stopping` behind a `sleeping` snapshot become wakeable again
- [ ] A follow-up to a chat whose container is genuinely gone tells the person what to do; the
      message is never silently lost
- [ ] Deleting a slept Instant workspace converges
- [ ] Regression tests through the real sweep and wake entry points, with a VM control and a
      discrimination check
- [ ] Staging: an Instant chat sleeps past the sweep window and a follow-up wakes it; deleting
      a slept Instant workspace completes; the five stuck staging rows repair; test sessions
      are cleaned up
- [ ] Production checked (`ops_find_anomalies`, `ops_search_errors`) before and after

## Implementation notes

- The integration fixture used `eviction_generation = 'generation-1'`, but production rows are
  NULL: staging had 87 cf-container and 34 VM workspaces since October, all NULL. The fake value hid
  root cause 2. Switching the fixture to NULL showed that **archiving a slept Instant session**
  hit the same throw. That is fixed by the same change.
- Discrimination, each reverted separately with the intended tests going red:
  - generation fix: the explicit-delete workers test and the integration archive test;
  - safety-net exclusion: the integration safety-net test, for both sleep writers;
  - queue guard: three queue tests;
  - explicit exemption: one test;
  - restore compare-and-set: the interleaving test;
  - due-path guard: the due-repair test.
- Full unit/integration suite on 29017da4b: 15,553 tests, 15,551 passed, 0 failed, 2 skipped.
- Production baseline 2026-11-08 05:39Z: no deletion-quarantine or snapshot-failure anomalies,
  no "cannot wake in place" errors, and no cf-container `stopping` rows.
