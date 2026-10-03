# Snapshot Capture Cost Must Scale With the Session, Not the Repository

## When This Applies

Any change to session snapshot capture or restore: `packages/vm-agent/internal/server/session_snapshot*.go` and the control-plane snapshot routes and services in `apps/api/src/services/session-snapshot-*.ts`. That covers anything producing artifacts, manifests or diagnostics for a sleep, an eviction or an idle checkpoint.

## Why This Rule Exists

On 2026-10-03 idle VM sessions had stopped sleeping across the fleet: 359 rejected snapshot completions across 54 workspaces since 2026-09-26. Three capture costs grew with things the session never created:

1. **The WIP bundle packed the whole branch history.** It was 246.6 MiB for this repository, after growing about 100 MiB in ten days, and it starved HOME of the shared 256 MiB budget.
2. **The skipped-file list grew with HOME's file count.** It pushed `POST /session-snapshot/complete` past the 256 KiB JSON limit, and the control plane answered 400 "Snapshot request body is too large".
3. **Size checks ran one `docker exec` per tracked file.** At 7,086 files each capture took about 10 minutes with no progress callback, far beyond the control plane's 2-minute no-progress watchdog.

Sleep requires a complete snapshot (#2208), so every attempt failed. The repairable-capture retry loop then re-uploaded the bundle every 10 to 15 minutes, and nothing deleted failed generations: R2 grew from 53 to 137 GB in four days.

## Hard Requirements

1. **Artifacts carry only state the wake side cannot fetch again.** The repository bundle excludes history reachable from the default branch (`snapshotWIPBundleBasis`). Never base an artifact on a ref that can disappear remotely: a stale remote-tracking ref left by a deleted branch makes its commits unfetchable.
2. **A restore that depends on fetchable state fetches it first, and fails visibly if it cannot** (`ensureSnapshotBundlePrerequisites`).
3. **Inspect entries in batches, never one process or `docker exec` per file.** Use one `git cat-file --batch-check`, one `find`, one `tar`.
4. **Diagnostics sent to the control plane fit the receiver's limit.** `boundSnapshotSkippedEntries` sizes the skipped list against `config.jsonBodyMaxBytes`, keeps failures first and summarizes the rest.
5. **Long phases report progress more often than the no-progress watchdog fires.**
6. **A capture generation that cannot complete releases what it uploaded** (`apps/api/src/services/session-snapshot-capture-cleanup.ts`).
7. **New HOME exclusions are capture-only by default** (`homeCaptureExcludePrefixes`). Restore rejects archives containing a restore-time excluded path, so adding a path to `homeExcludePrefixes` stops older snapshots that contain it from waking.

## Required Tests

- **History much larger than the WIP.** Use a repository whose default-branch history dwarfs the work in progress. Assert bundle size and prerequisites, then restore into a fresh clone, including one that lacks the prerequisite.
- **HOME that overflows the budget.** Drive it through `hibernateSessionSnapshot` against a control plane that enforces the JSON limit.
- **Size checks over many entries.** Assert a constant number of commands.
- **Discrimination.** Revert each guard once and confirm only its test goes red (rule 62).

## References

- Task: `tasks/archive/2026-10-03-session-snapshot-sleep-loop.md`
- `.claude/rules/54-vm-agent-rollout-compatibility.md`: old agents and old snapshots keep working
- `.claude/rules/61-guards-must-cover-every-runtime.md`: standalone (Instant) and container (VM) capture paths
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
