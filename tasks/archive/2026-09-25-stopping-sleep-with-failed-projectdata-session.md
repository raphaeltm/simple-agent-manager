# A `stopping` sleep whose ProjectData session is already `failed` retries forever

> **Reconciliation 2026-10-05:** Still open; pointer correction. The failed-session predicate
> is now `apps/api/src/scheduled/session-sleep-lifecycle-repair.ts:51-55` (the `failed` arm at
> `:54`), and the retry when the session is not already closed is at `:167`. The recovery-workspace
> finalize with `agentSessionStatus: 'failed'` moved to
> `apps/api/src/durable-objects/task-runner/state-machine.ts:641-648`. #2223's bounded sleep
> episode does not cover a sleep stuck in `stopping`. Since #2230 a failed VM wake also fails the
> conversation's own task (`state-machine.ts:305`); see SAM idea `01M3MFDMZ5AS0BXPHZWS3CRFED` and
> `2026-10-05-sleeping-task-status-follow-ups.md`.

> **Reconciliation 2026-09-30:** still open (`session-sleep-lifecycle-repair.ts:48,171` unchanged).
> Same class as SAM idea `01M3MFDMZ5AS0BXPHZWS3CRFED`, also unfixed:
> `apps/api/src/durable-objects/task-runner/state-machine.ts:582-589` finalizes recovery workspaces
> with `agentSessionStatus: 'failed'`, which fails a conversation its snapshot says is recoverable.
> Fix the two together.

## Problem

A sleep that has passed its point of no return (`session_snapshots.sleep_status = 'stopping'`)
is finished by `runSessionSleepLifecycleRepair()`
(`apps/api/src/scheduled/session-sleep-lifecycle-repair.ts`) only when the ProjectData session
is already `sleeping` or `stopped` — or, since the failed-task preservation work, `failed` for a
FAILED task. For any other task (for example a completed one) whose ProjectData session was
failed by a terminal reconciler or an `error` activity fanout while its sleep sat at `stopping`,
neither the repair nor the sweep can finish it: `stopping` has no attempt budget, so the sweep
re-selects the row every five minutes indefinitely.

This is pre-existing on `main`. Accepting `failed` for every task was tried and rejected in the
failed-task preservation review (round 2, M1): it marks a snapshot `sleeping` whose ProjectData
session can never wake, and the stuck-task guard then keeps that unwakeable conversation for the
snapshot's whole retention.

## Context

Found by the round 3 review of `sam/preserve-failed-tasks-work-fn8ba7` (idea
`01M1XGHX7NQZQYWQRV5C1PJ60N`, task `tasks/archive/2026-09-25-preserve-failed-task-work.md`).

## Acceptance Criteria

- [x] A `stopping` row whose ProjectData session is `failed` (non-failed task) leaves the sweep's
      candidate set within a bounded number of sweeps (rule 47), with a recorded terminal reason.
- [x] The runtime is torn down and the snapshot is not presented as wakeable.
- [x] A two-sweep regression test against real SQL, plus a control that a `sleeping`/`stopped`
      ProjectData session still completes as sleeping.

## 2026-10-08 implementation scope

SAM task 01M4DV45S0WXQETVAEPVJY5M2K; idea 01M3MFDMZ5AS0BXPHZWS3CRFED.
Existing backlog reused in SAM's pre-created isolated output branch.

Research: failTask terminalizes stable owner before failRecoveryLifecycle; cleanup finalizer
skips snapshot checks for failed/error and scopes the check to the old workspace, although
wake uses a replacement. ProjectData link rejects failed sessions and unknown errors retry.
Sleep repair deliberately excludes failed sessions of non-failed tasks; stopping candidate
selection has no age bound. Recovery budgets decay after clean failures; cooldown is not
permanent loss of recoverability.

- [x] Return a recoverable stable wake task to sleeping before terminal hooks; fence attempt ownership.
- [x] Preserve authoritative restorable snapshots through replacement cleanup; genuine loss remains visible.
- [x] Heal failed ProjectData sessions only under an authorized snapshot wake claim.
- [x] Classify status refusal as permanent across RPC error serialization.
- [x] Bound stopping selection on immutable stopping age; repair failed non-failed-task sessions to terminal failure with reason and cleanup.
- [x] Real alarm → failure → finalizer SQL regression, parent-hook assertion, unrecoverable control, next-wake and status-refusal coverage.
- [x] Two-sweep real SQL regression for stopping repair.
- [x] Local checks and specialist reviews.
- [ ] Coordinated staging lease and live verification.
- [ ] PR/CI/CodeRabbit/merge/production; idea evidence and channel cleanup.

No migration planned. Shared channel reliability-wave-1008; expiry owns expired end state,
8h task owns failure-preservation preparing/stopping reaper predicate. Rules 47, 58, 62, 66.

## Implementation and regression evidence

Recoverable stable wakes now retain a sleeping task without terminal parent notifications.
The failure marker is durable before the task transition, so interrupted cleanup resumes
without replaying restoration. ProjectData is returned to sleep under the observed identity;
the wake claim remains held through runtime cleanup and is released only afterward.
Failed mirrors heal only under the same snapshot/task/attempt authority, using failed-only SQL.
Snapshot preservation includes replacement workspace ownership and failed-wake cooldown, bounded
by snapshot expiry. Genuinely unavailable snapshots still terminalize visibly.

Stopping selection now stops retrying after the existing in-flight ceiling. Lifecycle repair
records terminal_failed with a reason for failed sessions whose task is not failed, closes
compute, and removes them from subsequent candidates. Existing sleeping/stopped controls remain.

Local verification: 110 focused alarm/handoff/finalizer/predicate/repair checks and 86 surrounding
idle-cleanup/sleep/agent-session tests pass. Six isolated mutation checks fail for the intended
assertion when task preservation, finalizer preservation, failed-mirror healing, cleanup replay,
stopping age, or failed-session repair is removed. The status-link-refusal regression enters
through TaskRunner.alarm -> workspace_creation -> actual ProjectData link SQL and asserts
first-alarm settlement without restoration or terminal parent hooks.
Full API rerun PASS: 827 files / 11,630 tests; all other root test tasks passed. Root lint,
typecheck and build passed, with affected API rechecks. File-size, source-contract, runtime-state
and runtime-boundary checks passed. Coordinated staging/PR/deployment evidence is pending below.

## Incident lesson

The failure was not a failed snapshot: a temporary replacement-runtime failure was incorrectly
treated as the conversation's terminal outcome, then a second finalizer overwrote the earlier
sleep transition. Helper-only tests missed this composition and the false parent notification.
The durable process guard is rule 62's production-entry regression requirement, applied here to
the real alarm/failure/finalizer path, plus rule 47's two-sweep convergence assertion. No extra
standing rule is needed; the regression and guard-removal proofs enforce the existing guidance.

Candidate/I/O budget: production wakes are about 5-10/day. Recoverable failure adds bounded
identity/CAS work to one attempt and avoids terminal fanout and repeated deadline polling.
Stopping candidates shrink after the existing age ceiling; repair keeps its existing default
25-row batch and per-row snapshot verification/ProjectData/cleanup calls. No migration or new
timer, unbounded query, external API, or environment variable was added.

## First staging verification (2026-10-08, lease 92)

Deployment 37826798709 passed including smoke at code 7fe65052c; Cloudflare Worker
38560c60-7ab4-48c6-a4a0-c42d1b6c156e was verified serving at 100%. CI 37826717410 passed.
Authenticated Playwright dashboard, projects and settings loaded without page errors.
One owned cx23 conversation replied `WAKE_PROBE_READY` and handed back idle; normal sleep
returned 200 with an available, non-degraded snapshot. Its replacement node never reported
ready and was deleted by readiness cleanup. The real wake failure at 19:21 returned the
task and ProjectData session to sleeping, retained null completed_at and the exact snapshot
generation/artifact keys/expiry, and emitted no failed task status event. Playwright showed
the preserved conversation, Sleeping status and a recoverable wake error.

The automatic next attempt exposed an additional defect before merge: reactivation spread
the previous attempt's durable wakeFailureMessage into the new attempt, causing immediate
replay of the old failure. Reactivation now clears it only for a distinct authorized claim.
A regression drives the real first failure alarm, new-claim reactivation and real next
node-selection alarm. Before the fix it reports the first restore error; after the fix it
evaluates the new placement. No placement/failure handler is mocked. All 32 alarm tests pass,
and the lifecycle/security delta reviewer passed the reset and per-attempt field audit.

Lease 92 was released with result=fail, cleaned=yes. Both owned VMs are deleted (replacement
termination proof 19:21:07, original delete 200), active owned workspaces are zero, and the
test chat was stopped. No third VM was created. Final coordinated staging verification of
the marker reset is pending; do not treat the first deployment as the final staging gate.
Post-allocation finalizer and parent-hook behavior are covered by local real-alarm SQL tests;
the live failure occurred before replacement workspace allocation.

## Final-candidate staging attempt (2026-10-08, lease 117)

Candidate cc066585d integrates main 33db414e0. Full CI 37845861298 and staging deployment
37845866548 passed. The earlier manual CI run's single capacity-pool 15-second test timeout
passed both the focused rerun and this complete CI run. The final integration reviewer passed.
Authenticated Playwright dashboard, projects and settings returned 200 without page errors;
the screenshots were reviewed. An owned conversation slept with an available snapshot, woke
on a ready replacement node, and replied `FINAL_WAKE_RESUMED`. It then slept and restored
again on the same node. The snapshot-preserving normal path works on the final deployment.

The exact failed-wake then successful-retry staging gate remains pending. A scoped D1 fault
injection was rejected because the debugging token is read-only (7500); no mutation happened.
An authenticated direct runtime-delete probe could not reach the node hostname because its
TLS handshake failed, so that attempt also restored normally. Neither attempt is counted as
failure-path verification. The local red/green alarm regression and prior live failure remain
valid, but do not substitute for the final same-runner failure/retry sequence.

A retry of explicit sleep was needed after one snapshot completion-verification error; it
then succeeded. Earlier in the lease a sleep timeout coincided with node DNS lookup errors.
These observations were shared with the boot-performance peer and are not attributed to this
change. No extra infrastructure changes were made.

Both owned cx23 nodes were deleted with 200 responses, GET /api/nodes returned an empty list,
and the owned chat was stopped with workspaceDeleted=true. Remaining owned workspace history
is a deleted tombstone with runtime-deletion proof; no owned runtime is active. Lease 117 was
released result=fail, cleaned=yes, with a direct handoff to the expiry follow-up and a request
to requeue after it. At most two VMs were used. PR #2276 remains closed until the exact gate.

The follow-up probe must use the authenticated owner workspace Stop API for a VM
replacement during its still-waking agent-session phase. Unlike explicit workspace DELETE,
the VM Stop path preserves an already-sleeping source snapshot and does not cancel its task.
Do not use the cf-container Stop branch, which intentionally deletes its snapshot. Direct
node management tokens cannot mutate a workspace without its matching workspace claim;
that rejection is correct. Direct origin access is also intentionally blocked by the VM's
Cloudflare-only firewall. Neither boundary should be bypassed for the test.

## Live failure and successor-allocation regression (2026-10-08, lease 127)

Candidate 81329dc9a integrates timing instrumentation main 096afcd8f. Full CI
37853293761 and deployment 37853287563 passed; Worker version
286c8ba0-1c0f-4a85-afa2-3784aad317cf served 100%. Core authenticated Playwright
pages returned 200 with no errors, and screenshots were reviewed.

The owner VM Stop API stopped the actual waking replacement at 22:44:07.381,
while recovery attempt 01M4ETZ62900JVVFV574RCW3M1 still held its claim. The real
restore timeout settled at 23:04:58.318: task and ProjectData session sleeping,
completed/ended timestamps null, available snapshot with identical generation,
R2 keys, hashes and expiry, and zero failed task-status events. Playwright showed
the conversation sleeping with a recoverable error. This preservation gate passed.

The next automatic attempt 01M4EW7FQP8MADZBPYFQQM0K2E started at 23:05:30 and
reached workspace creation, proving the stale failure marker was cleared. It failed
at 23:06:54 with the workspaces.chat_session_id unique constraint. The failed
replacement retained its chat binding; the next wake detached only the snapshot's
original workspace. The unique index includes deleted workspaces too. Separately,
failure cleanup changed the deleted replacement back to stopped. Both need fixes
and a regression that crosses the real successor allocation boundary with that
unique index enabled; the earlier placement-only regression missed this edge.

The fixture was stopped/cancelled and both cx23 nodes deleted by 23:09 (the second
was autoallocated during a cleanup race). GET /api/nodes returned []; owned
workspace rows were absent or deleted with null node/chat links. Lease 127 was
released result=fail, cleaned=yes (channel sequence 136), and the boot peer was
notified directly. PR #2276 remains closed; no production completion is claimed.

The successor fix now detaches only the failed replacement's unique chat binding,
after guarded resleep/cleanup and before releasing its recovery claim. One SQL
statement fences workspace/project/user/chat, snapshot task/attempt/workspace,
waking status, and sleeping task ownership. Database errors propagate so the real
alarm retries cleanup; an already-detached row is safe to replay. Both cleanup
status writes preserve deleted tombstones.

New real-alarm tests reproduced the stopped/deleted replacement UNIQUE failures
before the fix, then passed real successor workspace allocation after it. A
controlled SQL-boundary race proves a newer attempt keeps its binding; removing
only the SQL attempt predicate makes that assertion fail. A one-shot detach D1
outage proves durable cleanup retry without replaying restore or terminal hooks.
The final-delta reviewer passed these changes. All 36 alarm tests and 54 surrounding
state-machine/handoff/recovery tests pass; API typecheck and changed-file ESLint pass.

## Final staging verification PASS (2026-10-09, lease 150)

Final source b486cd6e3 integrates main 195f9f7ca. CI 37866742430 and staging
37866738403 succeeded. Worker 051df90d-d628-436b-b665-40e5a03f0d84 served 100%.
Independent integration review and 42 alarm/task-repair checks passed. Authenticated
dashboard/projects/settings returned 200 with no page errors; screenshots reviewed.

Owned task 01M4F2G92XFY3GZD32TEP9GXQ6 / chat
8020bb88-14c2-472a-94a6-917fddc149e9 replied FINAL_READY, then slept with an
available snapshot at 00:57:37.081. The owner API stopped the replacement runtime
at 01:09:41.535 while attempt 01M4F2YZB0CSFDCNWC0QQR8B58 was waking. The runtime
was automatically deleted before the real restore deadline. At 01:30:35, failure
settled with task/chat sleeping, null completion/end timestamps, identical snapshot
generation/artifact keys/hashes/expiry, and zero failed task-status events. The
failed replacement stayed deleted and relinquished its chat binding.

Automatic attempt 01M4F4H7XT036GCG9JR15EV98J reused the same task and second VM,
allocated successor 01M4F4HBQRVKX7QWCNTR68XMXK, and restored at 01:32:10. The
browser showed the new FINAL_RESUMED assistant reply and no page errors. The
independent completion reviewer checked the saved failure/success and browser
artifacts: A/B/C/E/F PASS, D N/A; the exact live failure-to-retry gap is closed.

At most two cx23 VMs were used. At 01:33 the chat stop returned 200 and both node
deletions returned 200. GET /api/nodes returned []; the query for all three owned
workspaces returned []. Lease150 released PASS/cleaned=yes (channel153), with a
direct handoff to VM-boot. No shared pool/profile/project configuration was changed.

Release follow-through remains pending: reopen PR2276, final PR checks and trusted
CodeRabbit request/wait, merge, production deployment, then source idea completion
and channel/task completion. The implementation and staging gates are complete.
