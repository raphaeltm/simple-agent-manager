# Inbox: agents hand finished answers to the person as Result items

## Problem

People read their inbox, not chats. Agents are told to file an inbox item when they need
something (`ask`, `review`, `assign`), but a finished answer has no home: the turn-end rule
says "finished: say so", which means saying it in a chat nobody reads. Raphaël (chat
`9f9e2bfb-8c1d-496f-9ebe-d8c6a30d391d`, task `01M7NSNS0264C7KDZEQ3JW0GDE`, 2026-11-17/18):

> a human will never see anything in this chat session unless you put it in the inbox. That
> includes artifacts to be reviewed, questions to be answered, responses to questions, etc.
> ... agents should be careful to only put things that really matter in there and to phrase
> things in a very human manner.

He chose "Add a Result item" (inbox ask `ask:01M7NSVYAW1PS6GFJQFC2W9TN0`) over reusing review.

## Research findings

- Turn-end rule: `apps/api/src/routes/mcp/instruction-inbox-guidance.ts`
  (`INBOX_TURN_END_INSTRUCTION`), injected by `instruction-tools.ts` for task-backed tokens.
  State (1) "finished: say so" never reaches the person.
- Conversation mode line "You are in a conversation with a human. Respond to their messages
  directly." (`instruction-tools.ts`) pulls the other way.
- Ask kinds: `ASK_KINDS` / `INBOX_ITEM_KINDS` (`packages/shared/src/types/inbox.ts`). `asks.kind`
  is free text validated in the app (migration 0245): no migration needed.
- Filing: `packages/operations/src/inbox-agent-core.ts` (`fileAgentReview`, `file`,
  `AGENT_KINDS_SQL` gates update/cancel). `InboxAskAnnouncement.kind` (`ports.ts`).
- Notification on filing: `announceAgentAsk` (`apps/api/src/services/inbox/agent-asks.ts`) →
  `notifyNeedsInput` whose title is `${label} needed: …` (wrong wording for a result).
- Answering: `answerAsk` (`packages/operations/src/inbox-write-core.ts`) closes with
  `closeAsk` then `notifyClosedAsk` (wakes the agent). The sweep (`services/inbox/sweep.ts`)
  retries closed rows with `notified_at IS NULL`, so a silent close must set `notified_at` in the
  closing write. Open PR #2862 adds the same `closeAsk(..., { silent })` option; match it.
- Agent notice text: `buildInboxAskPrompt` (`apps/api/src/services/inbox/ask-notice.ts`).
- MCP: tool def `tool-definitions-inbox-tools.ts`, group method `tool-groups.ts`, handler
  `inbox-tools.ts`, table `tool-handler-table.ts`.
- Web: `KIND_META`, `hasPinnedControls` (`inbox-model.ts`), `ReviewControls` /
  acknowledge switch (`InboxAnswerControls.tsx`), one-tap `staticOneTaps` (`InboxQuickView.tsx`),
  chat card labels (`InboxItemCard.tsx`). The chat card already renders any `inbox_write` that
  returns `inboxItem`.
- Rule 79 denylist audit over the kind enum: `INSIGHTS_PEOPLE_ASK_KINDS` (asks of people; a
  result is not an ask, stays excluded), `filter=reviews` (results stay out of Reviews, in
  Needs you), `inbox-rows.ts` validates against `ASK_KINDS`.
- `session_ended` ("Agent finished — your turn"): one emitter, conversation-mode
  `complete_task` (`routes/mcp/task-tools.ts`). Content-free; spec decision 2 says SAM never
  files a "your turn" item. Settings page lists every `NOTIFICATION_TYPES` entry as a toggle.

## Design

- New ask kind `result`, filed with `inbox_write` method `result` (`title`, `why`, `links`,
  `groupKey`, `idempotencyKey`). Non-blocking, never expires, answer spec `acknowledge`.
- Person: "Got it" closes it silently (no wake; `notified_at` set in the closing write).
  A reply closes it and wakes the agent with the reply (after `authorizeAnswerWake`).
- Push/in-app notification: `needs_input` type (inbox role, no Updates duplicate), titled
  "Result ready: <task title>".
- Turn-end rule rewritten: nobody reads the chat; anything the person asked for goes to the
  inbox (answer → result, something to check → review, decision → ask); routine runs and work
  another agent dispatched file nothing (report to that agent); file only what matters, written
  as a short note to a colleague.
- Stop emitting `session_ended`; keep the enum value so stored notifications still render;
  hide its settings toggle.

## Implementation checklist

- [x] shared: add `result` to `ASK_KINDS` and `INBOX_ITEM_KINDS`; retired notification types constant
- [x] operations: `AgentResultInput`, `fileAgentResult`, kind unions, `AGENT_KINDS_SQL`
- [x] operations: `answerAsk` — result without text closes silently; with text authorizes wake and notifies
- [x] api: notice prompt for a result reply; announcement title "Result ready"
- [x] api: MCP tool `inbox_result`, group method `result`, handler, handler table
- [x] api: rewrite `INBOX_TURN_END_INSTRUCTION`; fix the conversation-mode line; update the
      `inbox_write` entry of the agent onboarding text (`onboarding-tools.ts`, validator finding)
- [x] api: remove `notifySessionEnded` and its call; hide the settings toggle
- [x] web: `KIND_META.result`, pinned controls, "Got it"/Reply controls, one-tap, chat card labels
- [x] tests: capability test (real `/mcp` + inbox routes + DO) for filing, Got it (no delivery, sweep stays quiet), reply (one delivery)
- [x] tests: unit tests for prompt, instructions, web controls; update session_ended tests
- [x] docs: `guides/inbox.md`, `guides/agents.md`, `guides/notifications.md`, `concepts.mdx`, recent product changes
- [x] Playwright visual audit of the Result item (375px, 1280px)

## Acceptance criteria

- [x] An agent can file a result through `inbox_write` method `result`; it appears in Needs you with kind Result.
- [x] "Got it" closes it, the agent is not woken, and the notice sweep never wakes it later.
- [x] A reply closes it and the agent receives the reply exactly once.
- [x] `get_instructions` tells task and conversation sessions that only the inbox reaches the person, to file results, to skip routine/agent-dispatched work, and to write plainly.
- [x] No `session_ended` notification is emitted; its settings toggle is gone.
- [ ] Verified on staging end to end.

## Implementation notes

- Evidence: `apps/api/tests/workers/inbox-agent-tools-capability.test.ts` ("result:" and the
  get_instructions case), `apps/api/tests/unit/services/inbox/agent-asks.test.ts` ("inbox_write
  result"), web unit tests (inbox-page, inbox-item-card, inbox-quick-view-and-nav,
  settings-notifications), Playwright `inbox-audit.spec.ts` and
  `project-chat-inbox-item-card-audit.spec.ts` (39 passed, screenshots reviewed).
- Discrimination: removing the `kind === 'result' && !answer` branch turned exactly the
  "Got it" test red; removing `{ silent: true }` turned the same test red at `notified_at`.
- `main` is branch-protected, so the task file lives on the feature branch, not `main`.
- Archiving a result: left unchanged here on purpose. Open PR #2862 (Raphaël's 2026-11-17
  decision) makes archive close every question/review ask without telling the agent; its archive
  path is generic over agent ask kinds, so results archive silently once it lands. Until then an
  archived result tells the agent "the person will not act", which is harmless.
