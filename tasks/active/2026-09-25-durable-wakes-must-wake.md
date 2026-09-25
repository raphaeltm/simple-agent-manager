# Durable wakes must wake, or fail visibly

SAM task `01M3CJQJT3MP8P0CSYDW299MGV` (coordinator `01M3CHX9QYJ6GHWQEXY532FYSA`) ·
idea `01M0SD6W5SR7FWFVWTK7DWV318` · branches `sam/durable-wakes-must-wake-299mgv` (PR-A) and
`sam/wake-restore-survives-retry-299mgv` (PR-C)

## Problem

On 2026-09-25 the prioritization coordinator (session `175ec121`, task `01M3BJ38QGBRNX4P1M7A5B539K`)
dispatched three children, registered `wait_for_subtasks` (deadline 08:06:20Z), ended its turn and
slept at 08:05:03Z. At 08:06:22Z the durable orchestration event was persisted into the session and
nothing followed: no wake, no recovery task, no status event, no notice. The session still shows
"sleeping" with the event as its last message. The user saw a coordinator that "didn't wake up".

## Root cause (verified read-only in prod D1 + Workers Observability, rule 39)

The wake was **not** refused because the snapshot was transcript-only. It was refused because the
predecessor workspace's deletion was still pending, and that transient refusal was treated as final.

| Time (UTC) | Evidence |
|---|---|
| 08:04:47.792 | `session_sleep.snapshot_degraded_after_no_progress` (progressIdleTimeoutMs 120000): the capture made no progress, so the sleep wrote a transcript-only snapshot (`session-sleep-snapshot-wait.ts:155`). |
| 08:05:05.207 | `node_lifecycle.workspace_deletion_scheduled` workspace `01M3BJ3D…`, `deleteAt 08:10:05Z`, `delayMs 300000` (`WORKSPACE_STOPPED_TTL_MS` default 5 min). |
| 08:05:11.613 | `session_sleep.completed` (degraded / transcript-only). |
| 08:06:22 | Task-wait deadline: delivery `31acfc00` enqueued, attempt 1 claimed (ProjectData alarm, requestId `5d48b261…`). |
| 08:06:24.203 | `prompt_delivery_failed`, `reason terminal_target`, attempt 1, 1824 ms. **The only log line in that alarm request.** |
| 08:10:12 | Deletion attempt 1: `request_timeout`, quarantined for retry. |
| 08:11:17 | `workspace_deletion.confirmed` (`vm_agent_confirmed`, attempt 2). A retry after this would have woken the session. |

Path: `task-wait-supervisor.ts:295` enqueues a `parent_wakeup` delivery → `prompt-delivery-runner.ts:370`
→ `vm-prompt-delivery-adapter.ts:489` (workspace `sleeping`) → `ensureSessionRecovery`
(`session-recovery.ts:688`) → `assertReplacementDeletionConfirmed` (`replacement-deletion-fence.ts:47`,
NodeLifecycle `getAttemptState().pending` is true for the scheduled deletion) →
`{unavailable, 'workspace_deletion_unconfirmed'}` → adapter maps **every** refusal to
`{failed, terminal_target}` (`vm-prompt-delivery-adapter.ts:504`) → `applyPromptDeliveryResult`
terminal, no retry (`prompt-delivery.ts:418`). The wait had already resolved at enqueue
(`task-wait-supervisor.ts:313`), so nothing re-armed it.

Why nothing was written anywhere:
- Refusals before a claim write nothing to D1 (`session-recovery.ts:674-716`, `claimSessionSnapshotRecovery` only reads).
- The delivery's `last_error` lives in DO SQLite `session_inbox`; no UI reads it. `mailbox.delivery_updated` has no web consumer.
- Even a real wake failure is invisible: `failRecoveryLifecycle` posts no chat message or attention marker, and `useWakeProgress.ts:92-98` hides the banner on `failed` ("surfaces through the resume-error path", which only fires when the REST call throws, and the durable path returns 202).
- TTL expiry (`expireDuePromptDeliveries`) writes no event, broadcast or log.

Scope of the class: every wake (human follow-ups too; they are durable `user_followup` deliveries) that
lands in the five minutes after a sleep is refused the same way. Production shows this is rare
(two terminal delivery failures in the prior week), but systematic.

### Q2: why the capture degraded
The sleep's final checkpoint reported no progress for 120 s (`manifest.skipped: "Workspace snapshot
made no progress for 120000ms"`). The node was already failing its control-plane uploads: at 08:09:23-26
the old VM agent was still calling `session-snapshot/progress`, `upload-url` and `complete` and got
`410 GONE`. The node-side cause belongs to the parallel node-health task. A degraded snapshot is
restorable (`restorableSnapshotCondition`, `isRestorableSnapshot`): the wake restores what exists and
starts a fresh agent context (`agent-session-bootstrap.ts:shouldStartFreshAfterSnapshotRestore`),
verified on staging in August ("wake verified").

### Q3: what the user sees, and should see
| Step | Today | After this work |
|---|---|---|
| Wake inside the deletion window | Delivery fails at once; chat shows only the queued message; composer may keep "prompting" | Wake is deferred and retried; the session wakes once the old workspace is gone |
| Wake refused for good (expired snapshot, no credentials, exhausted budget…) | Same silence | A SYSTEM notice in the chat names the reason and the next step; the session carries a "Wake failed" attention marker; the pending-wake spinner is released |
| Deferred wake never completes within the delivery TTL (1 h) | Silent expiry | Same visible notice, naming the last reason it waited on |
| Degraded snapshot wakes into a fresh agent | Only a log line (`snapshot_restore_degraded_starting_fresh`) | A SYSTEM notice says what was not restored; the fresh agent is told to read its own transcript |

## Research findings

1. **Refusal names today are a mix of conditions and catch-alls** (`session-recovery.ts:674-797`,
   `session-snapshot-recovery-lifecycle.ts:396-409`). Only the eviction callback compares them
   (`workspace-eviction-callback.ts:56-60`, a local `RETRYABLE_EVICTION_RECOVERY_REASONS` set). The
   delivery adapter interpolates them into an error string and fails everything.
2. **PR #2145 (open, merges after this work)** adds `services/session-recovery-refusals.ts`
   (`isTransientSessionRecoveryRefusal`, a string set) and a delivery retry for three reasons
   (`vm-prompt-delivery-target.ts`). Its own backlog item
   (`2026-09-25-split-permanent-session-recovery-refusals.md`) records that permanent causes share
   those names and that the split belongs at the producer.
3. **Permanent causes hidden in "transient" names:** a malformed stored resource plan and every
   `PlacementResolutionError` return `session_recovery_placement_placement`; deterministic
   `PlacementResolutionError`s thrown from `resolveTaskStartPlacement` fall into the generic catch
   as `session_recovery_placement_transient`. `archive_migration_fenced` covers both a migration in
   progress (clears) and an archived/frozen session (does not).
4. **Dead-lettered deletions** keep `getAttemptState().pending` true
   (`node-lifecycle-workspace-deletion.ts:272`). They are not permanent: node termination proof
   (`nodes.runtime_termination_confirmed_at`) still releases the fence. Deletion max residence is
   24 h, the delivery TTL 1 h. Decision: keep every deletion-fence refusal "retry", bound by the
   delivery TTL, and make TTL expiry visible. This also keeps `node-lifecycle*.ts` untouched
   (owned by the parallel node-health task).
5. **`recovery_error` has two writers and no readers** (`session-snapshot-recovery-lifecycle.ts:650`,
   `session-recovery-authority.ts:413`). Every `recovery_status='failed'` writer must stamp
   `recovery_failed_at` (`session-snapshot-failed-writer-coverage.test.ts`), so a refusal must NOT
   reuse `recovery_status='failed'` (it would re-anchor the attempt-budget decay without spending an
   attempt). Sweeps that CAS on `session_snapshots.updated_at` only select rows with
   `sleeping_at IS NULL`, so a refusal record on a sleeping row cannot disturb them.
6. **Visible-failure template exists:** `markIdleCleanupAttentionRequired` (`idle-cleanup.ts:58-169`):
   attention marker + one system message + activity event + `message.new` broadcast. System messages
   render as `SystemMessageBubble` today. The session list recognises only `needs_input` markers
   (`chat-session-utils.ts:getAttentionState`). Any human message resolves all markers
   (`message-persistence.ts:183-191`), which is the right release for a failed-wake marker.
7. **Client pending-wake state** (`useSessionLifecycle.ts:467-486`) is released only when the
   session's own task is failed/cancelled; a refused wake never produces that, so "prompting"
   lingers until navigation.
8. **C(a), wake agent install bound to the request:** `handleRestoreAgentSession`
   (`session_snapshot.go:207`) runs provision + HOME/WIP download + `RestoreAgent` (which installs a
   missing agent binary) under `r.Context()`. VM nodes sit behind the Cloudflare proxy
   (`dns-node-backend.ts:79-85`, `proxied: true`), whose ~100 s origin limit returns 524 long before
   the 5 min `SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS`. The cancelled install fails the restore, and the
   handler caches `{status:'degraded'}` for the attempt, so the retry starts a fresh agent even when
   the snapshot was complete. `runSessionRestore` already has a joinable per-session attempt
   registry (`session_restore_retry.go:23`); prior art for a job-owned context:
   `startBackgroundSessionSnapshot` (`session_snapshot_coordinator.go:84`,
   `SESSION_SNAPSHOT_OPERATION_TIMEOUT`, 15 min, wired through cloud-init).
9. **C(b), a retried wake step cannot commit:** `agent-session-step.ts:119-131` calls
   `failSessionSnapshotRecovery` on the first error (added in #1785, before `failTask` →
   `failRecoveryLifecycle` recorded the same failure on the terminal path, `state-machine.ts:362,427`).
   - Guarded (durable) wakes: the retry's `assertRecoveryAuthority` finds `recovery_status='failed'`
     and throws the permanent `SessionRecoveryAuthorityRevokedError`: zero effective retries.
   - Unguarded wakes: the retry restarts the agent, then `wakeSessionForSnapshotRecovery` /
     `completeSessionSnapshotRecovery` refuse (they need `waking`/`restored`) until retries run out.
   - While `failed`, the snapshot is claimable again, so a second wake can race the retrying runner.
10. **Retries reuse a revoked MCP token** (`agent-session-bootstrap.ts:381-384`): the first attempt
    stores the token, hands it to the TaskRunner (`onMcpToken`), then revokes it on error; the retry
    passes it back as `existingMcpToken` and never re-stores it. The agent starts with a dead SAM MCP
    token. This hits ordinary task runs too. The TaskRunner already revokes its token in `failTask`
    (`state-machine.ts:404-416`), so the bootstrap must not revoke a token it handed off.

## Design decisions (policy 1b930820: decided, documented, not escalated)

- **A: option (i).** A degraded (including transcript-only) snapshot keeps waking into a fresh agent
  context, as it already does. What was missing is the visible half: a SYSTEM notice naming what was
  not restored, and a fresh-start prompt that points the agent at its own transcript
  (`get_session_messages`). The coordinator's state lives in SAM tasks, so it can carry on. Option
  (ii) would strand work the platform can resume.
- **B: one authority for what a refusal means, at the producer.** `session-recovery-refusals.ts`
  holds a typed table: each reason → the action the caller takes (rule 72):
  - `retry`: the condition clears on its own.
  - `report`: it will not; tell the human.
  - `drop`: the wake is no longer wanted.
  Consumers branch on the action, never on reason strings. The same module name as #2145's forces
  its rebase to reconcile rather than silently keep two classifiers.
- **Every reported refusal is recorded** on the snapshot row (`recovery_error`, the resumer's record,
  rule 58), as a chat notice plus a `wake_failed` attention marker, and as a structured log. Deferrals
  are logged at every deferral; they become a visible failure only if they outlive the delivery TTL.
- **`recovery_attempts_exhausted` is `report`**, with the last attempt's error. Three real VM
  provisioning attempts have failed inside the decay window; retrying every backoff tick for an hour
  would multiply that spend. The human gets the reason and can retry once the window resets.
- **C(a):** the restore becomes accepted work on an attempt-owned context bounded by
  `SESSION_SNAPSHOT_OPERATION_TIMEOUT` (no new config). The request only observes it; a retry joins
  it. No protocol change, so old and new control planes both work (rule 54).
- **C(b):** delete the step's premature `failSessionSnapshotRecovery`; the terminal path already
  records the failure. The bootstrap stops revoking a token it handed off.

## Implementation checklist

### PR-C: a wake's restore survives its request, and its retry commits (`sam/wake-restore-survives-retry-299mgv`)
- [ ] VM agent: run the snapshot restore on an attempt-owned context (`SESSION_SNAPSHOT_OPERATION_TIMEOUT`); the handler observes, a retry joins; request cancellation cannot fail or degrade it (rules 43, 71)
- [ ] VM agent tests: through `handleRestoreAgentSession`, cancel the request mid-restore, assert the restore's context stayed live and a second request gets the completed result; teardown/timeout control; proven discriminating
- [ ] TaskRunner: remove `failSessionSnapshotRecovery` from `agent-session-step.ts`'s catch
- [ ] Bootstrap: do not revoke an MCP token after `onMcpToken` handed it off; keep revoking when it was not
- [ ] Tests: real step, first attempt fails transiently, retry commits (guarded and unguarded); retry's token is live; retries exhausted → recovery ends `failed` via `failTask`; discriminating reverts recorded
- [ ] Docs sync (self-hosting/config docs only if behavior text exists)
- [ ] Staging (rule 22, 6b): cx23 VM session → sleep → wake onto a fresh node whose devcontainer lacks the agent → restore survives > 100 s install → agent answers; delete everything created

### PR-A: a wake either happens or fails visibly (`sam/durable-wakes-must-wake-299mgv`; after T1's `session-recovery.ts` split lands)
- [ ] Carry #2145's pure-move splits (`vm-prompt-delivery-target.ts`, `session-snapshot-wake-outcome.ts` / `-recovery-conditions.ts`) as cherry-picks so rule 18 holds and #2145's rebase drops them
- [ ] `session-recovery-refusals.ts`: typed reason union, action table (`retry`/`report`/`drop`), human-facing descriptions; exhaustive `Record` so a new reason cannot be unclassified
- [ ] Producer split (write-up 3): `stored_resource_plan_invalid`, `placement_unsatisfiable` (every `PlacementResolutionError`), `placement_credentials_missing`, `placement_lookup_failed`; `archive_migration_in_progress` vs `session_archived`; `recovery_start_failed` with the message as detail; exhausted carries the last `recovery_error`
- [ ] Producer records each `report` refusal on `session_snapshots.recovery_error` (sleeping row, never over a live claim) and logs `session_recovery.refused` / `.deferred` with every ID
- [ ] Delivery adapter: `retry` → retry, `report` → failed `wake_refused`, `drop` → failed `terminal_target`
- [ ] Eviction callback: branch on the action (replaces `RETRYABLE_EVICTION_RECOVERY_REASONS`); `report` raises the visible failure too
- [ ] ProjectData: `raiseSessionWakeFailure` (notice + `wake_failed` marker + broadcasts + activity + log, de-duplicated by the active marker), shared with idle-cleanup's template where it removes real duplication
- [ ] Delivery runner raises it for applied `wake_refused` failures; delivery expiry raises it for undelivered prompts to a sleeping session
- [ ] Degraded wake: SYSTEM notice naming what was not restored (once per recovery task); fresh-start prompt points the agent at its transcript
- [ ] Web: `wake_failed` attention state in the session list; a failed wake releases the pending-wake "prompting" state; Playwright audit (375 px, 1280 px)
- [ ] Docs: public docs for sleep/wake behavior and the new notice; env reference unchanged unless a var is added
- [ ] Staging: real durable wake inside the deletion window wakes; a reported refusal shows the notice + marker; control: normal wake; human wake consistent; clean up

## Acceptance criteria
- [ ] A durable wake that hits a pending predecessor deletion is retried and wakes the session once the deletion is confirmed (workers test through `registerTaskWait` → alarm → adapter → real NodeLifecycle; fails on pre-fix code).
- [ ] A durable wake refused for a reason that cannot clear produces, in the same pass: a SYSTEM notice in the session, an active `wake_failed` attention marker for the parent task, `recovery_error` on the snapshot row naming the condition, and a structured log line, with a liveness assertion beside every absence assertion.
- [ ] A restorable snapshot still wakes normally (control); a human follow-up to the same session behaves the same as the durable wake.
- [ ] A deferral that outlives the delivery TTL produces the same visible failure.
- [ ] A degraded wake posts one notice and tells the fresh agent where its transcript is.
- [ ] A restore whose request is cancelled keeps running, and the retry receives the completed (not degraded) result.
- [ ] A wake step that fails transiently retries and commits; the woken agent's MCP token is live.
- [ ] Every new guard proven discriminating by a surgical revert, with the reddened test named in the PR.

## References
- `apps/api/.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`, `.claude/rules/74-proxy-signals-must-match-the-condition.md`, `apps/api/.claude/rules/72-error-categories-must-match-the-recovery-action.md`, `.claude/rules/62-tests-must-observe-the-real-trigger.md`, `packages/vm-agent/.claude/rules/71-request-context-must-not-outlive-its-request.md`, `apps/api/.claude/rules/43-long-running-mcp-tools.md`
- PR #2145 write-ups: `tasks/backlog/2026-09-25-{wake-agent-install-bound-to-request,recovery-step-retry-cannot-commit,split-permanent-session-recovery-refusals}.md` on `sam/preserve-failed-tasks-work-fn8ba7`
- T1: `sam/sleeping-session-wakes-survive-dnf8ea` (splits `session-recovery.ts`, merges first)
