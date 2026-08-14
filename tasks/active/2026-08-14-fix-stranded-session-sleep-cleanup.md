# Fix stranded session sleep cleanup

**Priority**: Top production priority
**Created**: 2026-08-14
**SAM task**: `01KZZ94XPF7CFPK0WGSRVSZ67R`
**Idea**: `01KZZ9Y0B4957R9KR40TNEE3KP`

## Problem

Production VM workspaces remain running after their tasks complete or their chats become idle. At
2026-08-14 04:55 UTC, two shared workspace nodes hosted six D1-running workspaces: two were active,
three belonged to completed tasks whose first sleep attempt had failed, and one was an eight-hour
idle conversation with no snapshot row. The completed sessions stayed at sleep attempt one even
after their persisted retry time passed.

This creates avoidable server cost and can consume the shared Hetzner capacity limit. Session sleep
is now the reversible safety boundary, so completed and genuinely idle sessions should release
workspace compute promptly without sacrificing resumability.

Explicit product constraint: keep the existing warm-node retention window. Warm nodes are an
intentional fast-resume optimization; aggressive cleanup applies to sessions and workspaces, not
the warm-pool policy.

## Research Findings

1. Commit `00169b016` (PR #1785, deployed 2026-08-13) changed terminal cleanup to call
   `sleepWorkspaceSession()` synchronously before `cleanupTaskRun()`. The MCP `complete_task` tool
   marks the task completed while its ACP prompt is still running, so the sleep call observes
   `prompting` or `unknown`, consumes an attempt, and throws after the task is already terminal.
2. `failSessionSnapshotSleepBeforeTeardown()` persists `sleep_status='failed'` and a retry time,
   but `runSessionSleepSweep()` only selects `status='available' AND degradation='none'`. Production
   failed rows were pending or degraded, so their retry timestamps were permanently ineligible.
3. A session with no snapshot row cannot enter the snapshot-driven sweep at all. The idle activity
   callback is best-effort, so a bounded workspace-to-snapshot reconciliation path is required.
4. Commit `9a03f6579` (PR #1760) correctly made fresh ACP/node heartbeats conclusive runtime
   liveness. That signal must continue protecting in-flight work, but it must not act as user
   activity for resumable sleep. ProjectData `session_state.activity/activity_at` is the appropriate
   sleep signal.
5. Failed idle/prompting preconditions currently consume the bounded snapshot/teardown retry
   budget. A safety precondition should defer the due time without consuming a destructive-attempt
   budget; only a failure after a sleep claim should consume an attempt.
6. One live production Codex session generated a degraded snapshot because the default 100 MiB
   aggregate budget was exhausted by legitimate harness/session state. Its observed state was about
   140 MiB. R2 retention is materially cheaper than retaining a VM; a 256 MiB default preserves the
   fail-closed contract while covering the observed production shape.
7. Successful sleep marks the workspace sleeping and schedules deletion, but terminal cleanup is
   currently responsible for invoking `cleanupTaskRun()` and engaging the warm-node state machine.
   Once completion becomes asynchronous, successful sleep itself must finish compute accounting and
   task-run cleanup so the last workspace leaves the node warm for the unchanged retention window.
8. Relevant lessons: `tasks/archive/2026-08-06-fix-idle-sweep-silent-task-completion.md`,
   `.claude/rules/47-control-loop-io-budget.md`,
   `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`, and
   `.claude/rules/35-vertical-slice-testing.md`.
9. Recovered conversations can move to replacement workspace/node/agent-session IDs. A missed idle
   callback left the existing snapshot row bound to the old, deleted workspace unless sleep-intent
   creation explicitly refreshed its ownership metadata.
10. Serially awaiting up to ten five-minute final captures inside cron would give the widened sweep
    a roughly 50-minute worst-case I/O path. Claims need a short configurable wall budget, followed
    by durable scheduled-event work after the claim is persisted.
11. Async sleep cleanup must reload and propagate `projects.warm_node_timeout_ms`; falling back to
    the platform default would shorten a project's intentional warm retention window.
12. The VM idle default cannot also become the Instant idle default. Snapshot-completion scheduling
    must preserve Instant's separately configurable `CF_CONTAINER_SLEEP_AFTER` while explicit
    completed-task intents remain immediate on either runtime.
13. Live staging showed that task submissions own their chat through
    `session_summaries.task_id`; `tasks.chat_session_id` is normally null on this path. Eligibility
    and teardown must resolve that authoritative link, with the task column retained only as a
    compatibility fallback, or a completed task is misclassified as an ordinary idle conversation.

## Implementation Checklist

- [x] Replace synchronous completed-task sleep with a durable immediate sleep intent that can be
      queued while the current prompt is still running.
- [x] Preserve the earliest existing sleep deadline when a later idle checkpoint completes.
- [x] Make pending, available, degraded, and failed snapshots with due sleep intents claimable;
      retain final artifact verification before teardown.
- [x] Defer prompting/recent-idle/unknown activity without consuming a sleep attempt, using
      ProjectData activity rather than ACP/node heartbeat timestamps.
- [x] Add a bounded reconciler for awake VM workspaces whose snapshot or sleep intent is missing;
      ensure each candidate is isolated and gains a persisted sleep deadline.
- [x] Sleep completed sessions on the first idle observation after end-turn and ordinary idle VM
      sessions after 15 minutes by default.
- [x] Raise the default aggregate session-snapshot budget from 100 MiB to 256 MiB, keeping it
      environment-configurable and retaining fail-closed artifact verification.
- [x] After verified sleep, stop workspace compute tracking, schedule workspace deletion, and run
      the existing idempotent task cleanup so an otherwise-empty managed node enters the unchanged
      warm-retention state.
- [x] Rebind an existing snapshot's ownership metadata when recovery moved the conversation to a
      replacement workspace, without overwriting its last verified artifacts.
- [x] Bound synchronous cron claim work and dispatch claimed final capture/teardown through the
      scheduled event lifetime; isolate every candidate and preserve project warm-timeout overrides.
- [x] Persist pre-claim/reconciliation backoff so control-plane failures leave the hot candidate
      set, and preserve Instant's separate idle duration when checkpoint completion schedules sleep.
- [x] Resolve completed-task ownership through the session summary for both eligibility and
      post-sleep task cleanup; cover the production submission shape where the task chat link is null.
- [x] Unblock staging and production deploys from Pulumi 3.256.0's R2 checksum regression by using
      the upstream-verified `when_supported` request-checksum mode for the reusable deploy job.
- [x] Add discriminating tests for terminal completion during a prompt, pending/degraded retry,
      missing-snapshot reconciliation, heartbeat-independent idle eligibility, attempt preservation,
      two-sweep candidate convergence, and post-sleep cleanup.
- [x] Update public lifecycle/configuration documentation and add the process rule preventing
      precondition failures or incomplete snapshot states from becoming immortal sleep candidates.
- [ ] Run full local quality, specialist review, staging lifecycle verification, CI, merge, and
      production verification against D1 state.

## Acceptance Criteria

- A completed task returns successfully after persisting an immediate sleep intent; it does not try
  to snapshot or stop compute from inside the completing prompt.
- On the first scheduled sweep after the prompt reports idle, the session captures and verifies a
  final snapshot, sleeps, stops its workspace, and schedules workspace deletion.
- Pending/degraded/failed snapshot rows with overdue sleep deadlines are retried and cannot remain
  stuck solely because they are not already `available/none`.
- A running/recovery workspace with a persistent chat and no snapshot row gains a bounded,
  retryable sleep intent.
- Prompting and recent-idle sessions are never torn down. Their deferral does not consume the three
  snapshot/teardown attempts, and fresh heartbeats do not extend the genuine idle clock.
- Ordinary VM sessions sleep after 15 minutes of ProjectData-recorded inactivity by default;
  completed sessions sleep as soon as they are idle.
- Snapshot teardown remains fail closed: only a verified `available/none` generation releases live
  compute. The 256 MiB aggregate budget is configurable.
- Successful sleep stops compute tracking and leaves an empty managed workspace node warm under the
  existing warm-node retention configuration. No warm timeout constant or default changes.
- The scheduled loop has bounded candidates, per-candidate isolation, persisted deadlines, and a
  two-sweep regression proving candidates converge or remain on an explicit bounded retry path.
- Recovered sessions refresh snapshot routing to the current workspace before the sweep claims them.
- Cron performs only bounded D1/ProjectData claim work synchronously; claimed runtime I/O runs from the
  scheduled event after the durable claim, and project-specific warm retention reaches every warm
  transition path.
- Control-plane failures persist a future retry deadline without consuming a teardown attempt, and
  ordinary Instant checkpoints retain `CF_CONTAINER_SLEEP_AFTER` rather than the VM idle default.
- Local checks, specialist reviews, staging end-to-end verification, CI, production deployment, and
  production D1 verification are green.

## Post-Mortem

### What broke

Completed and idle sessions retained live VM workspaces. The new reversible sleep path failed on the
still-running completion prompt, and the persisted retry state was never selected again unless the
snapshot was already perfect.

### Root cause

PR #1785 composed two individually safe requirements in the wrong order: terminal cleanup required
sleep before runtime cleanup, but terminal completion ran before ACP `end_turn`. The retry sweep then
treated a verified complete snapshot as a candidate prerequisite even though producing that final
snapshot is part of the sleep operation itself. Best-effort idle checkpoint creation was also the
only route into the snapshot-indexed sweep.

### Timeline

- 2026-08-07: PR #1760 shipped runtime-liveness protection for quiet long-running work.
- 2026-08-12: PR #1785 merged durable session sleep/recovery.
- 2026-08-13: the sleep implementation reached production.
- 2026-08-14: production inspection found three one-attempt failed sleeps and one long-idle session
  with no snapshot across the two active shared workspace nodes.

### Why it was not caught

Tests asserted that terminal cleanup synchronously called sleep before `cleanupTaskRun`, but did not
model that `complete_task` itself executes inside the prompt whose activity gate sleep checks. Sweep
tests seeded only `available/none` snapshots, encoding the restrictive selector instead of testing
pending, degraded, missing, and prompt-to-idle lifecycle states across D1 and ProjectData.

### Class of bug

Cross-control-plane lifecycle composition and retry-candidate mismatch: a precondition owned by a
later runtime event was evaluated synchronously, then the failure state was persisted outside the
selector that was supposed to retry it.

### Process fix

Update the scheduled-handler/liveness rule to require that lifecycle precondition failures do not
consume destructive retry budgets and that every persisted retry state—including incomplete
prerequisite state—remains selectable or has a separate reconciler with a durable escape path.

## References

- `apps/api/src/services/task-terminal-cleanup.ts`
- `apps/api/src/services/session-sleep.ts`
- `apps/api/src/services/session-snapshot-sleep-lifecycle.ts`
- `apps/api/src/services/session-snapshot-recovery-lifecycle.ts`
- `apps/api/src/services/session-snapshot-persistence.ts`
- `apps/api/src/scheduled/session-sleep.ts`
- `apps/api/src/routes/projects/agent-activity-callback.ts`
- `apps/www/src/content/docs/docs/guides/instant-sessions.md`
- `apps/www/src/content/docs/docs/reference/configuration.md`
