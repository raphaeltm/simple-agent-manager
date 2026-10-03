# Idle VM sessions never sleep: snapshot capture never completes

## Problem

Idle VM sessions stay awake indefinitely. Example: chat `66b483cd-1671-4a7e-8b74-f88606671cb3`, workspace `01M3ZY783NZETH6BG65QM94GQ6`, which made 14 automatic sleep attempts on 2026-10-03.

Every attempt runs a final session snapshot, and the snapshot never completes. Since #2208 (`7a9782c90`), sleep requires a complete (`available`/`none`) snapshot (`verifyAndBeginSleepTeardown` in `apps/api/src/services/session-sleep-execution.ts`). The session therefore stays awake. The automatic sweep retries forever because degraded rows, and rows with a capture generation in flight, bypass `SESSION_SLEEP_MAX_ATTEMPTS` (`failSessionSnapshotSleepBeforeTeardown`).

Each failed capture also leaves its uploaded `wip.bundle` behind in R2.

## Research Findings (read-only production evidence, 2026-10-03)

1. **The WIP bundle contains the full branch history.** Both `createWIPBundleWithGitState` (standalone/Instant, `session_snapshot_archive.go`) and `createContainerWIPBundleWithGitState` (VM devcontainer, `session_snapshot_container.go`) run `git bundle create <file> <worktreeRef> <indexRef>` with no basis.
   - R2 analytics show 16 `wip.bundle` PUTs of exactly 246.6 MiB for session 66b483cd (3.85 GiB total).
   - A local `git bundle create x.bundle HEAD` on origin/main `6793fcd8a` is 258,618,921 B, the same size.
   - The history bundle was 138.7 MiB on 09-10, 236.3 MiB on 09-20, and 246.6 MiB on 10-03.
2. **The bundle starves HOME.** `captureWIP` subtracts the bundle from the 256 MiB budget (`c.budget -= size`), leaving about 9.4 MiB for HOME and the external Codex root.
   - `buildContainerSnapshotArchiveList` appends one `manifest.skipped` entry per file that no longer fits ("snapshot budget exhausted").
   - The parent session measured its HOME: `~/.codex` alone is about 82 MiB in 1,444 files.
3. **The completion receipt exceeds the JSON cap.** `POST /session-snapshot/complete` carries the manifest, and `readJsonBody` rejects bodies over `jsonBodyMaxBytes` (default 256 KiB) with 400 "Snapshot request body is too large".
   - `sam-observability-prod` `platform_errors` has 359 such rows across 54 workspaces since 2026-09-26 15:50Z.
   - The VM agent then reports `/failure`. The capture never completes and its artifacts are orphaned.
4. **One `docker exec` per tracked file makes captures take about 10 minutes.** `oversizedContainerIndexEntries` runs `git cat-file -s` once per index entry; the SAM repo has 7,086 tracked files.
   - Workers Logs show about a 10-minute gap between the `prepared` and `wip-capture` progress callbacks on every cycle.
   - The API's final-snapshot watchdog (`SESSION_SNAPSHOT_PROGRESS_IDLE_TIMEOUT_MS`, 2 min) would degrade such a capture even if it eventually succeeded.
   - `skipOversizedContainerUntracked` has the same per-file `stat` pattern.
   - The standalone `skipOversizedStagedIndexEntries` spawns one `git cat-file -s` process per entry.
5. **Regenerable state is captured in HOME.**
   - `.codex/cache` holds a 28 MiB remote plugin catalog plus a tools cache.
   - `~/.npm-global` holds agent CLI binaries of 245–289 MB each (EffProp sessions).
   - `.local/share/uv` holds uv tool installs and Python, including symlinks that mark snapshots `entries-skipped`.
   - None of these are in `homeExcludePrefixes`. `.npm`, `.local/bin`, `.local/lib`, `.cargo` and `.nvm` already are.
6. **Failed generations leak in R2.** `prepareSessionSnapshot` overwrites `capture_generation` and, for never-completed rows, the key columns without deleting the superseded generation's objects. A degraded completion of a row that already has a completed generation never deletes the completing generation's unrecorded uploads. Nothing deletes the artifacts of a reported capture failure.
7. **A stale remote-tracking ref must not become a bundle prerequisite.** `TestCreateWIPBundlePreservesHeadWhenRemoteTrackingRefIsStale` covers a branch that was pushed and then deleted remotely. Excluding everything reachable from `--remotes=origin` would make that commit an unfetchable prerequisite and lose work.
   - Decision: exclude only history reachable from `refs/remotes/origin/HEAD` (the default branch). If it is absent, keep today's full bundle.
8. **Restore runs `git fetch <bundle>` before `restoreSnapshotGitState`.** Bundles with prerequisites need those commits locally first.
   - VM bootstrap uses a full `git clone --branch`. Instant uses `--filter=blob:none`; experiment with git 2.55 shows thin bundles restore into both.
   - `git bundle list-heads` works outside a repository for bundles with prerequisites.

## Implementation Checklist

- [x] VM agent: compute the WIP bundle basis from `refs/remotes/origin/HEAD` (shared helper) and pass `^<sha>` to `git bundle create` in BOTH runtimes. Fall back to a full bundle when there is no default-branch ref. (`session_snapshot_bundle.go`, 6030caa15)
- [x] VM agent: before `git fetch <bundle>` in BOTH restore paths, parse the bundle's prerequisites and fetch any missing ones from `origin` (refresh all origin branches once, then exact commits). Legacy full bundles have none, so this is a no-op for them.
- [x] VM agent: batch the oversized-entry checks into a single `git cat-file --batch-check` per list (`session_snapshot_entries.go`):
  - [x] container staged index entries
  - [x] container untracked entries
  - [x] standalone staged index entries
- [x] VM agent: exclude `.codex/cache`, `.npm-global`, `.local/share/uv` and the external Codex root's `cache`. Changed during implementation: these went into the new CAPTURE-ONLY `homeCaptureExcludePrefixes`, not `homeExcludePrefixes`, because restore rejects archives that contain excluded paths and older snapshots legitimately contain these.
- [x] VM agent: bound `manifest.skipped` against the prepare response's `config.jsonBodyMaxBytes` (fallback 256 KiB). Keep diagnostics first, then the largest entries, truncate long strings, and add a summary entry.
- [x] API: delete a superseded capture generation's R2 artifacts when `prepareSessionSnapshot` replaces it. The row's recorded keys are re-read and kept, which covers the completed-in-between race. (94912da29)
- [x] API: delete a failed capture generation's home/wip R2 artifacts in `recordSessionSnapshotCaptureFailure`. The manifest key is kept for a transcript-only completion.
- [x] API: delete the completing generation's uploaded-but-unrecorded artifacts in `completeSessionSnapshot`, and an in-flight capture's uploads in `deleteSessionSnapshotState`.
- [x] Docs: update `apps/www/src/content/docs/docs/guides/instant-sessions.md` (bundle basis, exclusions, skipped-list bound, the post-#2208 "degraded snapshots do not release compute" behavior) and add an October note to `recent-product-changes.md`. (ad9615893)
- [x] Tests: Go real-git tests for (`session_snapshot_sleep_loop_test.go`):
  - [x] basis exclusion
  - [x] the stale-ref control
  - [x] prerequisite fetch on restore
  - [x] batched checks (bounded exec count)
  - [x] exclusions
  - [x] skipped bound, end-to-end through `hibernateSessionSnapshot` against a control plane that enforces the 256 KiB limit
- [x] Tests: API tests on a real SQLite D1 for the artifact-deletion paths, plus a control proving the completed generation's keys are kept and a controlled-ordering race test (`session-snapshot-capture-cleanup.test.ts`).

## Deferred (tracked as SAM Ideas, not in this PR)

- Retry budget for repairable (degraded or in-flight) sleep captures. This is a product decision: either sleep with a visible degraded warning, or stay awake and stop retrying. It interacts with failed-task preservation release.
- `waitForFinalSessionSnapshot` attributes a pre-acceptance capture failure to the new request. After this fix that costs one extra retry; the existing test pins the current behavior.
- A sweep of the existing orphaned `session-snapshots/` objects in R2. This PR stops new leaks.
- Already-running nodes keep the old agent (rule 54). Their stuck sessions do not self-heal until archived or retired.

## Acceptance Criteria

- [ ] A SAM-sized repository produces a WIP bundle containing only commits not on the default branch, plus the snapshot commits.
- [ ] A basis bundle restores into a fresh clone, including when the prerequisite commit has to be fetched.
- [ ] A commit reachable only from a stale remote-tracking ref is preserved: it is not a prerequisite, and the restore succeeds.
- [ ] Oversized-entry checks run a constant number of commands regardless of how many files are tracked.
- [ ] The completion request stays under `jsonBodyMaxBytes` even with thousands of skipped entries.
- [ ] Superseded, failed, and unrecorded capture artifacts are deleted from R2, while the completed generation's artifacts are kept.
- [ ] Staging: a fresh VM session on a real repository sleeps automatically with a complete snapshot, then wakes and restores its work.

## Implementation Notes

- Pure-move refactors first (rule 18): 6b989efd8 (Go snapshot files) and 27653910b (API prepare module).
- Discrimination (rule 62): each fix was reverted in isolation and only its intended tests went red.
  - Go (7 mutations): no basis; basis on all remote refs (the stale-ref test went red); no prerequisite recovery; unbounded skipped list; no capture-only exclusions; caches made restore-rejecting; per-entry lookups.
  - API (6 mutations): every cleanup path, plus the keep set and the manifest key.
- The task file ships with the PR because a direct push to main is blocked by repository rules (required status checks).

## References

- `.claude/rules/54-vm-agent-rollout-compatibility.md`, `.claude/rules/61-guards-must-cover-every-runtime.md`, `.claude/rules/27-vm-agent-staging-refresh.md`
- #2208 (`7a9782c90`), #2115 (exact Git state restore), #2035 / #1828 (retry exemption)
- Knowledge: SleepWakePerformance, ProductionCostInvestigation
