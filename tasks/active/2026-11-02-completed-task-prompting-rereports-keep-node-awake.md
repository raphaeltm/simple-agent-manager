# A completed task whose agent keeps re-reporting `prompting` never sleeps

## Problem

Production 2026-11-02: node `01M69PPA2GA4WQBQMTDB97CXZ2` lived ~37 h. Task `01M6CP3W…` had
completed, but its agent re-reported `prompting` about every minute for 8.5 h with
`runtimeWorkState` `inactive`. Every admitted re-report rewrites `session_state.activity_at`
(`upsertSessionState`), and `classifySessionIdleness` drains a completed/failed task from
`max(activityAt, completedAt)`, so the drain never elapsed, the session never slept and its
workspace kept the node alive. Rule 53 class: a liveness clock used as an idleness signal.

## What a first fix got wrong (reverted from PR #2494)

Anchoring the drain on `max(completedAt, promptStartedAt, runtimeWorkProgressAt)` instead:

1. **Sleeps working Claude Code agents mid-turn.** `runtimeWorkProgressAt` only moves for
   background tasks/subagents on Claude Code (`harnessWorkSourceForAgent` in
   `packages/vm-agent/internal/acp/session_host_harness_work.go`); ordinary tool calls do not
   advance it. An agent that calls `complete_task` and keeps working for more than 15 minutes
   would be judged idle. `tests/integration/failed-task-preservation.test.ts` encodes the intended
   behaviour ("the drain follows activity").
2. **Does not release the node anyway.** `sleepWorkspaceSession` aborts when
   `idlenessStateChanged` sees `activityAt` move during capture/verification
   (`services/session-sleep-execution.ts`, `services/session-sleep-eligibility.ts`), so a session
   re-reporting every minute would abort its own sleep and spend attempts until the bounded
   fallback. The first fix's test only checked eligibility, not the sleep.

Saved first-cut test (drives real `reportActivity` re-reports):
`apps/api/tests/workers/completed-task-stuck-prompting-sleep.test.ts` in commit `2ad24019b`.
(2026-11-03: that commit was never pushed and is not reachable; the test is rewritten here.)

## Direction

Use a signal that only real work moves, for both the drain and the sleep's abort checks: the
latest persisted message (`chat_messages.created_at`, also `workspace_activity.last_message_at`),
plus harness progress. A bare `prompting` re-report must change neither. Check the existing
check-in watchdog and the session-activity reconciliation probe (`apps/api/.claude/rules/57-*`) for
why neither ended this turn.

## Second production occurrence (2026-11-03)

Raphaël flagged node `01M6EHBZ85GDPDQS5JSAYCKF4Z` (up ~15 h, nothing running). Its only workspace
`01M6ERBW8A4M11D3Q72E9F46WK` belonged to task `01M6EEESKHF1STH9N1X6VVMTW8`, completed 2026-11-02
18:58Z. The ACP prompt started at 18:53:24 (the turn that called `complete_task`) never logged
completion. Snapshot `01M6EF0Q68EG2720ZVBNBX2SVJ` stayed `scheduled` and was deferred about every
10 min for 13 h; `idle_cleanup.workspace_idle_timeout` fired six times and logged
`workspace_idle_candidates_inconclusive … preserved`. Same pattern on `01M6F7MEWMKVKWAXXZA20YDKQ1`
(task completed 01:01Z, `sleep_error` = "Workspace agent is not idle (prompting)").
Raphaël authorized shipping straight to production without staging.

## Research findings (2026-11-03)

- The VM agent re-reports `prompting` every 60 s while a prompt is open
  (`ACTIVITY_REREPORT_INTERVAL`, `packages/vm-agent/internal/config/config.go`). The admission
  coalesce window is 2 s (`DEFAULT_ACP_ACTIVITY_COALESCE_WINDOW_MS`), so nearly every re-report
  reaches ProjectData.
- `upsertActivityState` (`durable-objects/project-data/session-state.ts`) rewrites `activity_at` and,
  when runtime-work fields are present, `runtime_work_updated_at` on every applied report;
  `refreshWorkingActivityForChatSession` rewrites `activity_at` on every persisted message. So
  `activity_at` mixes real work (messages, edges) with bare re-reports.
- `classifySessionIdleness` (`services/session-idleness.ts`) drains terminal tasks from
  `max(activityAt, completedAt)`.
- `idlenessStateChanged` (`services/session-sleep-eligibility.ts`) compares `activityAt` and
  `runtimeWorkUpdatedAt`, both moved by bare re-reports → sleep capture aborts.
- `cancelSleepForActiveActivity` (`services/acp-activity-callback-flush.ts`) runs on every applied
  `prompting` report and resets a `preparing` claim (`sleepClaimId = NULL`) even in preserve mode,
  so a re-report during capture also cancels the sleep at `beginSessionSnapshotStopping`.
- The check-in watchdog and the session-activity probe both consult the VM agent, which truthfully
  reports the ACP prompt as still open, so neither ends these turns. Why the Claude Code turn never
  returns is a VM-side question: deferred to a SAM Idea (see Checklist).
- A non-terminal (conversation) task with a never-ending turn (`01M6E2FVMVMXVD499DKR3J2V64`) is
  not covered by this fix: its turn has not ended, so the safety gate correctly refuses sleep.
  Bounding a hung non-terminal turn is part of the same deferred Idea.

## Design

A dedicated work clock, `session_state.work_at`, moved only by real work:
- an activity edge (activity changed, a newer `prompt_started_at`, `runtime_work_state` or
  `runtime_work_progress_at` changed, or a first report),
- a persisted message (`refreshWorkingActivityForChatSession`).
A same-turn re-report keeps it. NULL on legacy rows falls back to `prompt_started_at`, then
`activity_at`.

## Checklist

- [x] DO migration `071-session-state-work-clock` adds `work_at INTEGER`
- [x] `upsertActivityState` computes work edge vs same-turn re-report; sets `work_at` only on edges;
      returns the outcome
- [x] `refreshWorkingActivityForChatSession` also sets `work_at`
- [x] `getSessionState` returns `workAt` (split read section out of `session-state.ts`, rule 18)
- [x] `classifySessionIdleness` terminal drain anchors on `max(completedAt, workAt ?? promptStartedAt
      ?? activityAt, runtimeWorkProgressAt)`
- [x] `idlenessStateChanged` compares `workAt` instead of `activityAt` / `runtimeWorkUpdatedAt`
- [x] DO `reportActivity` surfaces `'same_turn_rereport'`; `cancelSleepForActiveActivity` skips it
- [x] Worker test: completed task + real re-reports, no messages → real sweep sleeps the session;
      proven red on current code
- [x] Control: messages persisted after `complete_task` keep it draining
- [x] Control: a new turn (edge) still cancels/fences the sleep
- [x] Docs: update session-sleep docs if they describe the drain clock
- [x] SAM Idea: tracked in existing idea `01M5VG7QCDGW77VY1N4QCDJRQK` (hung final turn; items 2-3:
      idle sweep releasing a terminal task's workspace, capture the hang's debug package) and
      `01M4JMDPRP7FCY6CVJEDQ0TW5A` (hung turn on a live conversation). Progress note posted.

## Acceptance Criteria

- [x] Drain anchor and `idlenessStateChanged` ignore bare re-reports and follow persisted work
- [x] Worker test: real re-reports with no messages → the real sleep sweep sleeps the session
      (not just eligibility); proven red on current code
- [x] Control: a Claude Code agent persisting tool-call messages after `complete_task` keeps draining
- [x] Existing `failed-task-preservation` and `session-sleep-bounded-fallback` suites stay green

## Implementation Notes (2026-11-03)

- `markPromptAccepted`, `recordTurnEnd` and `terminalizeChatSessionActivity` also stamp `work_at`.
  The one `activity_at` writer outside `session-state.ts` is the probe's `working` branch
  (`session-activity-reconciliation.ts:applyProbeOutcome`); it deliberately leaves `work_at` alone,
  because "the VM still has the turn open" is re-report evidence, not progress (pinned by test).
- Review round 1 (adversarial): new-turn detection compared against `prompt_started_at`, which
  `markPromptAccepted` sets to the accept time, so on durable delivery every re-report looked like a
  new turn. Fixed with `reported_prompt_started_at` (same migration 071), the raw reported value,
  and a monotonic server-time `work_at` on the message path.
- Residual, accepted: a silent foreground tool call longer than 15 min after `complete_task` (Claude
  Code Bash is capped at 10 min; background tasks and Codex/OpenCode tool calls are harness work).
  Tracked in idea `01M5VG7QCDGW77VY1N4QCDJRQK`.
- `same_turn_rereport` mirrors the upsert's runtime-work apply guard, so a runtime-work difference
  the upsert will not write cannot move the clock.
- Behaviour change, intended: a FAILED task whose turn only re-reports now sleeps (keeping its
  snapshot) after the drain, instead of waiting for `FAILED_TASK_PRESERVATION_MAX_WAIT_MS` and
  posting a work-loss notice. The max-wait tests now model a turn that keeps producing work.
- Discrimination: reverting only the abort check reddens the vertical slice and
  "ignores a same-turn re-report between two reads"; reverting only the drain anchor reddens 5
  tests (3 classifier cases, hung failed task, vertical slice); removing the fence skip reddens
  "keeps an in-flight sleep claim through same-turn re-reports".
- Raphaël waived staging for this fix (2026-11-03): "Get it into prod ASAP, skip staging."
