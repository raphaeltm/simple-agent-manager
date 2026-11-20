# Overview "Automations · failing" shows agents' own wake-ups nobody can act on

Idea: `01M7W2JJVM3SK95QJZVT795HM9`. Sibling bug (not in scope): `01M7W2JV0CGSR180GPDK2N3EYM`.

## Problem

Raphaël saw "Automations · 2 failing" on the Project Overview (2026-11-20) and could not act on
either row. Both were one-off wake-ups that agents scheduled into their own chats:

1. Schedule `37f4c602-dc93-463e-83de-1342ef5780a0`: due 2026-11-19 00:30Z, but its task
   `01M7NZTWT6AC98R70CGYJJZE0A` was cancelled at 00:01Z. The runner recorded `failed`,
   "Scheduled target or creator authority is no longer active". Nothing was broken: the chat
   simply ended first.
2. Schedule `0fa2b109-6f39-4683-9653-06db936ab905`: delivered and acted on, but recorded
   `ambiguous` by a receipt bug (separate idea, out of scope).

Agents create dozens of such wake-ups a day as CI/staging fallbacks. A person cannot fix them.

## Research

- `scheduleAttention()` (`apps/web/src/pages/automation/model.ts`) flags every one-off schedule in
  `failed`/`ambiguous`/`expired` updated within `AUTOMATION_ATTENTION_WINDOW_MS` (3 days).
  `attention` drives: Overview `AutomationsSection` ("N failing"), Automation page "Needs your
  attention" (`overview-sections.tsx`), the per-chat automation panel (`chat-automation.tsx`),
  row badges (`ui.tsx`) and the detail page `AttentionCard` (`ScheduleDetail.tsx`). History
  (`activity.ts`) and the detail page's result/Advanced rows show the outcome independently of
  `attention`.
- `ProjectSchedule` carries `promptAuthor` (`human` | `agent` | `sam` | null),
  `creatorChatSessionId`, and `action` (`message_session` has `sessionId`).
- Runner: `runScheduleAlarm()` (`packages/project-data/src/do/project-event-schedules-runner.ts`)
  maps any `ProjectEventValidationError` from `requireScheduleAction()` to `failed`.
  `requireScheduleAction()` (`project-event-schedules-authority.ts`) folds two conditions into
  one message: target task no longer wakeable, and creator lost project role/membership.
  `requireScheduleTarget()` throws when the chat session is not active/sleeping.
- `ProjectEventValidationError` crosses DO RPC by `name`; a subclass must keep that name.
- Existing integration test `apps/api/tests/integration/sleeping-vm-wakes.test.ts` already drives
  the real runner over real SQLite/D1 for "task completed" and "creator suspended" and asserts
  `failed` for both.

## Checklist

- [x] Authority: `ScheduleTargetEndedError` subclass; throw it only on positive evidence the
      target ended (task row exists and is not wakeable; chat session row exists and is not
      active/sleeping). Creator-authority failure gets its own message.
- [x] Runner: target-ended → `cancelled` with reason, `execution_finished_at` set; other
      validation errors stay `failed`.
- [x] Web: a chat's own reminder (`promptAuthor` agent/sam, `message_session` to
      `creatorChatSessionId`) never raises attention; history/detail still show the outcome.
- [x] Tests: integration (real runner + SQLite/D1) for completed, cancelled task, stopped
      chat → cancelled; creator suspended → failed; model unit tests; Overview vertical slice
      through mocked API showing human failure counted and self-reminder not counted.
- [x] Docs: automation docs mention of failing/attention, if any.

## Acceptance criteria

- A wake-up whose target chat ended before it was due is stored as `cancelled` with a reason
  naming the ended chat, and does not appear as failing anywhere.
- A failed agent self-wake-up does not count toward "N failing" on the Overview or "Needs your
  attention", but still appears in History and on its own page.
- A failed schedule a person created still counts as failing.
- Creator lost access still records `failed`.

## Release

Raphaël authorized (inbox reply, 2026-11-20): skip staging, rely on vertical-slice tests, merge
and ship to production.

## Outcome

- Review round (task-completion-validator, cloudflare-specialist, test-engineer) found the first
  cut cancelled **every** schedule into an ended chat, including a person's or a watch's, which
  hid a signal a person can act on. The runner now cancels only a chat's own reminder, using one
  shared predicate (`isChatOwnReminder` in `packages/shared/src/types/project-event-schedules.ts`)
  for both the runner and the web attention model. A person's schedule into an ended chat still
  fails, now with the precise reason "The chat it was meant to message had already ended".
- "Ended" is an allowlist of terminal task statuses (`TASK_TERMINAL_STATUSES`), not "not
  wakeable"; a missing/rebound task row or a draft task keeps the combined refusal.
- Not done (justified): MCP `sam_schedule_*` projection still nulls `lastError` for cancelled
  rows. The only agent that would read a runner-cancelled own reminder is the one whose chat
  ended. History does not list cancelled schedules (same as user cancels); docs say the outcome
  shows on the schedule's own page.
