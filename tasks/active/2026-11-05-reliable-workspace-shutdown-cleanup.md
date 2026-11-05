# Reliable workspace shutdown: final quiesced snapshot, durable preservation receipt, source cleanup

## Problem

Production 2026-11-05 (idea `01M6N9JMBRDN1NQ8VZNEF7FMQ7`, investigation session `9c946bb5`,
critique task `01M6NA29J4CG4P83VCTQZ2KD1F`). Node `01M6MCE1FQT7AAYH82P1Z7XVKC` evicted three
workspaces for memory pressure at 01:09–01:10 UTC. All three conversations resumed on other
nodes within 2–8 minutes, which is the scheduler working. The bug is what stayed behind: the
evicted source workspaces never got physical-deletion proof, the node stayed `running` and
empty for more than five hours with repeated `unproven_workspace_deletion` refusals, and it was
finally removed by an approved operator action. Separately, workspace `01M6MK1T8EQA8QNS3HMRRSN753`
stopped at 04:35, was D1-claimed for deletion (status `stopping`, attempt 1), lost its chat
binding to a wake, and its deletion was dead-lettered at 04:36 ("identity or status changed").
It is still `stopping`, unbound, with no proof (production D1, read 2026-11-05 08:09).

Raphaël: evictions are fine when the session continues elsewhere; leftover source artifacts
keeping nodes alive are the bug. Authorized: implementation, thorough local and staging tests,
production release (basic smoke only).

## Research Findings (main 5566f7545)

1. **Only a verified full sleep grants preservation.** `markSessionSnapshotSleepingWithConfig`
   (`apps/api/src/services/session-snapshot-sleep-lifecycle.ts`) is the only writer of
   `cleanup_identity_json.$.preserved = 1`. Eviction snapshots are taken from the live container
   (`packages/vm-agent/internal/resourcemon/eviction.go` `performEviction`: snapshot, then
   `docker stop`), so they cannot prove the final dirty/untracked state, and nothing grants them.
   The deletion queue (`node-lifecycle-workspace-deletion.ts` `schedule`/`processDueEntry`), the
   attempt (`workspace-deletion.ts` `requireAutomaticPreservation`) and the safety-net sweep
   (`scheduled/node-cleanup/workspace-phases.ts` `sweepStaleStoppedWorkspaces`) all require it.
2. **Nothing schedules deletion of an evicted source.** No `scheduleWorkspaceDeletion` caller on
   the eviction (`routes/projects/workspace-eviction-callback.ts`) or recovery path. Deleting the
   source before its wake is restored would break the failed-wake retry cron
   (`scheduled/workspace-eviction-recovery.ts` requires `source.status = 'evicted'`), so deletion
   must follow a successful restore.
3. **Preservation is read from the mutable per-chat snapshot row.** `findPreservationSnapshot`
   (`workspace-deletion-preservation.ts`) requires `session_snapshots.workspace_id = source`.
   The successor's first capture rewrites `workspace_id`/`node_id`/`cleanup_identity_json`
   (`session-snapshot-prepare.ts`) and its completion deletes the previous generation's R2 keys
   (`session-snapshot-persistence.ts` `completeSessionSnapshot`). After that the source has no
   preservation record at all.
4. **`chatSessionId` is part of the deletion identity.** It is compared in
   `sameDeletionIdentity`, `deletion-entry` matchers, `sameOwnership*`, and every
   `chat_session_id IS ?` predicate in `workspace-deletion.ts`, the D1 claim
   (`node-lifecycle-workspace-deletion-support.ts`) and `finalizeWorkspaceStopInNode`. A wake
   legitimately nulls the source's binding (`reactivateSleepingTask`, `session-recovery.ts`), so a
   queued or claimed deletion is fenced and dead-lettered. `finalizeWorkspaceLifecycleClosure`
   reads the *current* row's chat, so a NULL binding already skips the successor's conversation.
5. **Empty running node is starved of warm handoff.** `recordCleanupRefusal`
   (`cleanup-refusal.ts`) installs `cleanup_backoff_until` for any refusal but only starts
   `cleanup_blocked_since` for `stopped`/`destroying`. Cron order runs `idle_orphan_nodes` before
   `empty_node_warm_handoff` (`scheduled/node-cleanup/index.ts`), and the handoff selector skips
   nodes in backoff. An empty running node refused only for artifact proof is refused, backed
   off, refused again, and never handed to warm, so the stopped-node deadline
   (`sweepStrandedNodes`) never starts.
6. **Helper.** `eviction_snapshot_helper.go` already captures an exited OOM victim: `docker
   commit` + `--volumes-from` + `--network none --cap-drop ALL`, quiet `tail -f` entrypoint, and
   the ordinary capture via `docker exec`. Cleanup is best-effort only; nothing reaps a leaked
   helper; a leaked `--volumes-from` helper makes `docker volume rm sam-ws-<id>` fail
   (`workspace_deletion.go`), pinning the node again. The helper label overrides the root label,
   so deletion never sees it. Commit cost scales with the writable layer.
7. `handleStopWorkspace` closes agents/PTYs but never `docker stop`s; deletion removes the
   container. Normal sleep capture happens with the agent idle and is verified; unchanged here.

## Design

- **Final quiesced eviction capture (VM agent).** Keep the live pre-stop capture (it is still
  the fallback that guarantees relocation and the "never stop without a snapshot" invariant).
  After `docker stop`, run a bounded final capture through the generalized helper. It is
  reported `quiesced` only if, before and after the capture, the source container is not running
  with an unchanged start time and no other running container mounts the workspace volume or
  host root. OOM victims captured through the helper are already quiesced. Failure keeps the
  live capture: relocation proceeds exactly as today, without preservation.
- **Helper hygiene.** Workspace-scoped labels on helper container and committed image, memory
  and PID limits, free-disk precheck against the writable-layer size, bounded timeout, reap on
  startup and before deletion removes containers/volume.
- **Preservation grant for evictions (API).** `/session-snapshot/complete` records `quiesced` in
  `cleanup_identity_json`; the eviction callback's snapshot-sleep statement grants
  `preserved = 1` only for a quiesced, complete generation of exactly that source.
- **Durable per-generation receipt.** New nullable `workspaces.preservation_receipt_json`,
  copied from the snapshot row in the same batch that grants preservation (full sleep and
  quiesced eviction). A successful wake stamps `restoredAt`. Preservation then reads the receipt
  (identity match AND (artifacts verified in R2 OR restored)), with the existing snapshot-row
  path kept for rows granted before this change.
- **Schedule source deletion after a restored wake** (`completeSessionSnapshotRecovery` caller),
  plus the safety net selects receipt-bearing sources.
- **Directional chat detachment.** Deletion identity accepts the current binding becoming NULL
  (authorized detachment), never a different chat and never NULL → bound.
- **Warm handoff not starved.** An artifact-only refusal of an empty, not-yet-warm running node
  does not install a backoff, so the same tick's warm handoff releases it normally and the
  existing stopped-node deadline bounds any residue.

## Implementation Checklist

- [ ] VM: generalize helper (stopped-source verification, labels, limits, disk precheck)
- [ ] VM: final quiesced capture after stop in `performEviction`; quiescence check; `quiesced` in completion
- [ ] VM: report final-capture failure so the capture generation is released
- [ ] VM: reap helpers at startup and before deletion removes container/volume
- [ ] API: migration 0224 `workspaces.preservation_receipt_json` + schema
- [ ] API: completion records quiesced; eviction statement grants preserved for quiesced generation
- [ ] API: receipt writer in full-sleep finalize and both eviction batches
- [ ] API: restore completion stamps receipt and schedules source deletion
- [ ] API: preservation check reads receipt (artifacts or restored) with legacy fallback
- [ ] API: safety-net sweep selects receipt-bearing sources
- [ ] API: directional chat-detachment acceptance across deletion identity + stop finalize
- [ ] API: cleanup refusal does not starve warm handoff of an empty running node
- [ ] Docs: architecture/lifecycle docs updated
- [ ] Tests (Go): controller ordering/failure; helper flow with fake docker (labels, limits, writer refusal, restart mid-capture, cleanup); deletion reaps leaked helper before volume rm; startup reaper; real-Docker round trip (stop → helper capture → restore: HOME, staged/unstaged/untracked)
- [ ] Tests (TS, real SQL / workers): quiesced eviction grants receipt; live eviction does not; successor capture before cleanup still preserved via restoredAt; chat detachment mid-deletion completes; X→Y chat still fenced; lost deletion response; non-target tenant untouched; warm handoff after artifact-only refusal; stopped-node deadline then applies
- [ ] Staging: real VM eviction → final capture → restore elsewhere → source container+volume+root removed with proof → empty node released; neighbor untouched; cleanup
- [ ] Production: basic smoke, read-only observation; report `01M6MK1T` quarantine (needs authorized remediation path)

## Acceptance Criteria

- [ ] A memory-pressure or OOM eviction whose final capture is quiesced yields physical-deletion proof for the source after the wake is restored, without operator action.
- [ ] A live-only (non-quiesced) eviction capture never grants preservation.
- [ ] A successor capture before source deletion does not strand the source.
- [ ] A wake that detaches the chat during deletion does not dead-letter it and never touches the successor; a different chat still fences.
- [ ] An empty running node refused only for artifact proof reaches warm handoff in the same tick; residue is bounded by the existing deadline.
- [ ] Helpers never outlive their capture across agent restarts and never block volume removal.
- [ ] Verified end to end on staging with a real VM.

## Notes

- Out of scope: over-eviction tuning (unproven hypothesis), Stop semantics, cf-container runtime
  (no Docker; container retirement path is separate).
- Task file kept on the feature branch rather than pushed to `main` separately.
