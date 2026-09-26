# Make SAM Task Status Trustworthy

## Problem

The 2026-09-26 audit found two task-status defects:

1. Conversation-mode tasks that sit idle until the sleep snapshot reaches its seven-day TTL are marked `failed` by stuck-task recovery, even though an idle conversation can still be resumed by the human through the chat transcript and durable prompt path.
2. A late terminal failure callback must never regress a task that already reached a successful terminal state, including tasks whose PR has already merged.

## Research Findings

- `apps/api/src/scheduled/stuck-tasks.ts` is the real day-7 writer. It routes in-progress dead-runtime verdicts through `transitionTaskToTerminal`, after `withholdTerminalVerdictForSleepingSession`.
- `apps/api/src/services/task-sleep-preservation.ts` currently preserves only a restorable or in-flight sleep snapshot. Once `session_snapshots.expires_at <= now`, the guard returns `none`, so the sweep writes `failed`.
- `apps/api/src/routes/chat-prompt-route.ts` accepts human follow-ups through durable prompt delivery, and conversation tasks remain task-backed. Snapshot restore is only one wake mechanism; snapshot expiry is not a conversation failure verdict.
- `apps/api/src/routes/tasks/callback.ts` is the real late-failure callback surface. Its SQL update path is race-safe, but a late failed callback loaded after a task is already `completed` falls into the invalid-transition path instead of returning an unchanged terminal task.
- `apps/api/src/services/task-terminal-transition.ts` already protects shared terminal writers with an active-status CAS and refuses existing terminal rows.
- Tests for the stuck-task guard must use real SQLite via `createSqliteD1`; mock `.where()` tests cannot prove SQL predicates discriminate.

## Checklist

- [x] Trace the day-7 conversation auto-fail writer through the real sweep.
- [x] Trace the late-failure callback path and shared terminal writer guard.
- [x] Extend the sweep terminal gate with a task-mode conversation fallback after snapshot expiry.
- [x] Return unchanged 200 responses for late terminal callbacks that target an already-terminal task.
- [x] Add real-SQL sweep tests proving expired-snapshot conversations are preserved while task-mode rows still fail.
- [x] Add callback-route regression proving a late failed callback cannot regress a completed task.
- [x] Run focused tests.
- [x] Run full quality gates.
- [x] Run specialist review.
- [ ] Verify on staging.
- [ ] Open PR, complete CI, CodeRabbit, merge, and production deploy monitoring.

## Acceptance Criteria

- An idle `taskMode: conversation` task with an expired sleep snapshot is not marked `failed` by the stuck-task sweep.
- The same sweep still fails non-conversation task rows with genuinely dead runtimes.
- A late `toStatus: failed` callback after a task is already `completed` returns the unchanged terminal task and writes no failure.
- Regression tests enter through the real sweep and callback route, with the sweep guard proven against a real SQL engine.

## References

- `apps/api/.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`
- SAM idea `01KZNGJG1DCH8DBC835Y0272P4`
- `tasks/archive/2026-09-14-stuck-task-sweep-preserves-sleeping-conversations.md`
