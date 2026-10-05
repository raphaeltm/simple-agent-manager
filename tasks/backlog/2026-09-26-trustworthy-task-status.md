# Make SAM Task Status Trustworthy

> **Reconciliation 2026-10-05:** PR #2230 (`ee80b0ee0`) added the task status `sleeping`. VM
> sleep teardown now writes it (`apps/api/src/services/session-sleep-teardown.ts:212-229`). The
> stuck-task sweep selects only `queued`/`delegated`/`in_progress`
> (`apps/api/src/scheduled/stuck-tasks.ts:326,343,360`), so a VM conversation task slept after
> #2230 can no longer get the day-7 `failed` verdict. This is from reading the code; production D1
> has not confirmed it. Still open:
>
> 1. Instant (`cf-container`) tasks stay `in_progress` while asleep
>    (`session-sleep-teardown.ts:212-213`). They still depend on
>    `isHumanResumableConversationTask` (`apps/api/src/services/task-sleep-preservation.ts:206-236`),
>    which still joins the `session_snapshots` row that the 7-day purge deletes.
> 2. VM tasks slept before #2230 were not backfilled. They stay `in_progress` on the old path until
>    their snapshots age out.
> 3. Decide the end state of a `sleeping` task whose snapshot the purge retires. Today it stays
>    `sleeping` with no bound:
>    - the purge stops only the ProjectData session
>      (`apps/api/src/scheduled/session-snapshot-purge.ts:141`);
>    - `sleeping` can only move to queued/delegated/in_progress/cancelled
>      (`apps/api/src/services/task-status.ts:37`);
>    - a wake is refused as `sleeping_snapshot_missing`
>      (`apps/api/src/services/session-recovery.ts:230`).
> 4. The production-shape regression test (a conversation task with no snapshot row).
> 5. Staging verification of #2153.

> **Status (2026-09-30 weekly reconciliation): partially shipped, moved back to backlog.**
>
> - **Shipped** in PR #2153 (`1cd4194db`, merged 2026-09-26, production deploy run 36280892213):
>   a late `toStatus: failed` callback against an already-terminal task now returns the unchanged
>   task (`apps/api/src/routes/tasks/callback.ts`), and the stuck-task sweep gained a
>   conversation fallback.
> - **Not fixed in production:** the fallback, `isHumanResumableConversationTask`
>   (`apps/api/src/services/task-sleep-preservation.ts:176`), still joins a `session_snapshots` row
>   with `sleep_status = 'sleeping'`. The 7-day snapshot purge deletes that row before the sweep's
>   day-7 verdict, so the fallback never matches. Read-only production D1 shows **ten**
>   conversation tasks failed with "Task runtime is no longer live after 480 minutes … Last
>   liveness result: workspace_deleted" after the fix deployed, from 2026-09-27 02:36Z
>   (`01M2Y90KN3VB50A2T18AG4HV1N`) to 2026-09-30 02:36Z (`01M35Y40SZ6JNRTXGW8PP58368`).
>   Since 2026-10-04 the same verdict reads "Task runtime is no longer live (workspace_deleted);
>   task started N minutes ago." (`tasks/archive/2026-10-04-task-recovery-liveness-signal-audit.md`).
> - **Remaining work:** make the day-7 conversation verdict independent of the purged snapshot
>   row, and decide which status an idle conversation with an expired snapshot should get. Policy
>   `a974b04f` says normal lifecycle endings must not look like failures. The regression test
>   must seed the production shape (conversation task, no snapshot row) rather than an expired
>   row that still exists. Tracked in SAM idea `01KZNGJG1DCH8DBC835Y0272P4`.

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
  - _Reconciled 2026-09-30, left unticked:_ PR #2153 records no staging verification.
- [x] Open PR, complete CI, CodeRabbit, merge, and production deploy monitoring.
  - _Reconciled 2026-09-30:_ PR #2153 merged 2026-09-26T23:18Z; production deploy run 36280892213 succeeded 23:54Z.

## Acceptance Criteria

- An idle `taskMode: conversation` task with an expired sleep snapshot is not marked `failed` by the stuck-task sweep.
- The same sweep still fails non-conversation task rows with genuinely dead runtimes.
- A late `toStatus: failed` callback after a task is already `completed` returns the unchanged terminal task and writes no failure.
- Regression tests enter through the real sweep and callback route, with the sweep guard proven against a real SQL engine.

## References

- `apps/api/.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`
- SAM idea `01KZNGJG1DCH8DBC835Y0272P4`
- `tasks/archive/2026-09-14-stuck-task-sweep-preserves-sleeping-conversations.md`
