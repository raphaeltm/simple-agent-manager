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

## Direction

Use a signal that only real work moves, for both the drain and the sleep's abort checks: the
latest persisted message (`chat_messages.created_at`, also `workspace_activity.last_message_at`),
plus harness progress. A bare `prompting` re-report must change neither. Check the existing
check-in watchdog and the session-activity reconciliation probe (`apps/api/.claude/rules/57-*`) for
why neither ended this turn.

## Acceptance Criteria

- [ ] Drain anchor and `idlenessStateChanged` ignore bare re-reports and follow persisted work
- [ ] Worker test: real re-reports with no messages → the real sleep sweep sleeps the session
      (not just eligibility); proven red on current code
- [ ] Control: a Claude Code agent persisting tool-call messages after `complete_task` keeps draining
- [ ] Existing `failed-task-preservation` and `session-sleep-bounded-fallback` suites stay green
