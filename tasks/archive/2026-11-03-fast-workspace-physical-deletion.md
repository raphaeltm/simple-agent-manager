# Fast Workspace Physical Deletion (Stop Takes ~31 Minutes)

## Problem

Raphaël (2026-11-03): "It is bonkers how unreliable the workspace stopping process is.
This didn't use to be a problem."

When a workspace stops, it stays in `stopping` for about 31 minutes, showing
`Workspace deletion unconfirmed: VM attempt N (NodeAgentHttpError: http_status_503)`,
before it finally reaches `deleted`.

## Evidence

Debug package for node `01M6H35EAR5TD0VA361PXXFWT5` (agent `970edd0`) and production D1:

| Workspace                  | VM stop (agent log) | VM cleanup finished | D1 `deleted`                |
| -------------------------- | ------------------- | ------------------- | --------------------------- |
| 01M6H3CSV3Q6WGAB5MZCCM9RZA | 16:46:12            | ~17:02              | 17:17:59                    |
| 01M6H6NZBZFZNK5H83DGGGBHKH | 17:41:12            | ~17:57              | 18:13:47                    |
| 01M6H6W12KAJKRDK20NR3D5VGV | 19:05:53            | ~19:21              | 19:37:28                    |
| 01M6H6CAZ6DSMFFKMWAG7S9F6Z | 19:41:16            | pending at 19:47    | still `stopping`, attempt 4 |

The agent logs `Workspace physical cleanup remains pending ... workspace filesystem cleanup
budget exhausted; retry required` once a minute for ~15 minutes per workspace.

## Root Cause

1. **Entry-bounded deletion (#2463, 2026-10-28).** `removeDeletionRoot`
   (`packages/vm-agent/internal/server/workspace_deletion_path.go`) removes at most
   `WORKSPACE_DELETION_MAX_ENTRIES` (default 512) filesystem entries per attempt, and the
   background reconciler (`startWorkspaceDeletionReconciler`) runs one attempt per minute.
   A SAM clone has ~10.4k entries (9,739 files + 619 directories), so physical cleanup
   takes about 20 minutes. Before #2463 deletion finished in one attempt.
2. **The caller's timeout cancels the inline attempt.** The NodeLifecycle DO calls the VM
   with `getNodeAgentBackgroundRequestTimeoutMs` (5s). `handleSafeDeleteWorkspace` ran
   `applyWorkspaceDeletion` under `r.Context()`, so when the API gave up the in-flight
   `docker rm`/`volume rm`/walk was cancelled mid-way, leaving the work to the next
   minute's reconciler tick.
3. **Exponential retry hides the completion.** While cleanup is pending the VM answers 503,
   and the deletion queue backs off 1, 2, 4, 8, 16 minutes
   (`workspaceDeletionRetryDelayMs`). Cleanup finished at ~20 min, but the next attempt is
   at 1+2+4+8+16 = 31 min. This backoff existed since #2019 and was harmless while
   deletion finished in one attempt.

## Design

Keep every safety property of #2463 (identity-pinned root, `os.Root` confinement, mount and
symlink rejection, durable resumable intent). Change only how much work an attempt does
and who owns it:

- Bound an attempt by **time** (its context deadline, `WORKSPACE_DELETION_ATTEMPT_TIMEOUT`,
  30s), not by an entry count. Remove `WORKSPACE_DELETION_MAX_ENTRIES`.
- Once the handler holds the lifecycle lock, the durable intent and inline attempt belong
  to **one bounded attempt**, not to the HTTP connection: run them under
  `context.WithoutCancel(r.Context())` plus the attempt timeout, so a caller timeout no
  longer cancels half-done Docker and filesystem work.
- If the inline attempt does not finish, **wake the background reconciler immediately**
  instead of waiting for the next minute tick.

The API side is unchanged: its next retry (1 min) now finds the deletion finalized.

## Checklist

- [x] Reproduce timings from the debug package and production D1
- [x] Remove the entry budget from `removeDeletionRoot`; bound by context; read each
      directory once with `ReadDir(-1)`
- [x] Return a retryable, explicit error when the attempt deadline interrupts the walk
- [x] Detach the post-lock handler work from the caller's connection (bounded by the attempt
      timeout)
- [x] Add a reconciler wake channel; wake it when an inline attempt leaves cleanup pending
- [x] Split reconciler code out of `workspace_deletion.go` to stay under 500 lines
- [x] Remove `WorkspaceDeletionMaxEntries` config and update docs
      (`configuration.md`, `env-reference` skill)
- [x] Tests: a large tree (> old 512 budget) deletes in one attempt; deadline interrupts
      and a later attempt resumes; caller cancellation does not abort the inline attempt
      (through the real handler); a failed inline attempt wakes the reconciler, which then
      finalizes without a tick
- [x] File backlog task for the false `container_oom` classification (exit 137 from
      `docker rm -f`)

- [x] Process fix: `.claude/rules/81-work-bounds-must-state-throughput.md` (state throughput and worst-case
      time at the outer probable limit; deadline-bound must-finish work; test past every count)

## Why It Was Not Caught

- #2463's PR listed "removes at most 512 host entries per operation" as a cost-safety property. Nobody
  computed 512/min against a 10k-entry repository.
- Unit tests used 4-file directories. Staging used a tiny fixture repository, so deletion finished in
  one attempt and both cycles passed.
- Lifecycle timings are log-only (`recordLifecycleTimings`). Deletion failures log at warn, which is
  not persisted to `platform_errors`. `updated_at` is rewritten on every retry, and the first persisted
  signal is the 24h dead-letter. Production ran ~31-minute stops for six days with no automated signal.
- Follow-up (separate PRs): a lifecycle state-age watchdog feeding the incident pipeline, stored
  lifecycle durations with a daily regression check, and nightly limit tests.

## Acceptance Criteria

- [x] A workspace with more than 512 entries is physically deleted in a single attempt
- [x] Cancelling the delete request after the lock is held does not cancel deletion
- [x] A pending inline deletion is resumed by the reconciler without waiting for the ticker
- [x] Safety tests from #2463 (symlinks, root swap, mounts, fences) still pass
- [x] Staging: a stopped workspace on a fresh node reaches `deleted` within ~2 minutes

## Staging Evidence

Fresh node `01M6HKK872S2WQWW3NTDVD2SAS` (agent `7069e6030`), project `hono` (>512 entries).
Explicit `DELETE /api/workspaces/01M6HKK8FE2903WEPBA4FADBK5` returned
`200 {"deletionStatus":"confirmed"}` within seconds, and the workspace was gone at the first poll.
Node deleted afterwards.

## References

- `packages/vm-agent/internal/server/workspace_deletion.go`, `workspace_deletion_path.go`
- `apps/api/src/durable-objects/node-lifecycle-workspace-deletion.ts` (`runClaimedAttempt`)
- `apps/api/src/durable-objects/node-lifecycle-workspace-deletion-support.ts`
  (`workspaceDeletionRetryDelayMs`)
- PR #2463 (entry budget), PR #2019 (proof-driven deletion), PR #2492
- `packages/vm-agent/.claude/rules/71-request-context-must-not-outlive-its-request.md`
