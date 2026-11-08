# Ship SAM notice rows: structured notices for platform-injected chat messages

Idea: 01M6R6N2KGQSDZ8DQE3P1XRVC0. Task: 01M6R61531100WM6X5JB8YMC5D. Raphaël approved the prototype on 2026-11-06 ("Love it. Ship it.").

## Problem

The orchestrator, event system, schedules, ops approvals and agent-to-agent messaging inject messages into chats. Every durable delivery is saved as a `role:'user'` row and the web app renders it as the session owner's own bubble, full of IDs. Humans can't tell what the message is or what it refers to.

## Decision

- The server writes a versioned notice (`samNotice`) into `chat_messages.tool_metadata`. The UI never parses message text to build cards.
- The UI renders such rows as a compact one-line "From SAM" row that expands on tap: a detail line, quoted text from outside SAM, entity cards (task opens a quick-look modal with live task data; chat, idea and node open in-app pages; PRs, commits and event URLs open externally), and "Show what the agent saw".
- Agent-facing text is unchanged.

## Research findings

- Choke point: `acceptPromptDeliveryInTransaction` (`apps/api/src/durable-objects/project-data/prompt-delivery.ts:62`) persists the row with `{...input.metadata, source, kind:'durable_prompt_delivery', deliveryId}`. The live broadcast rebuilds the same object separately (`durability-foundation.ts:runAcceptedPromptDeliveryHooks`).
- Forgery risk: `send_durable_message` passes caller-supplied `metadata` straight into that spread, so an agent could set `samNotice`. The vm-agent message batch (`messages.ts:persistMessageBatch`) also stores caller tool metadata.
- Web: `chatMessagesToConversationItems` (`apps/web/src/components/project-message-view/types.ts`) maps rows to acp-client items, and `AcpConversationItemView` renders them. Live `message.new` keeps `toolMetadata` (`useChatWebSocket.ts`).
- acp-client does not depend on shared. A web-local intersection (`UserMessage & { notice }`) avoids a package-graph change.
- Injection points and the data they have:
  - Parent wake: `task-wait-supervisor.ts`. Child task IDs and statuses; titles need `title` added to the D1 select.
  - Event wake, including agent DM channels: `project-events-materialization.ts` → `project-events-wake-prompt.ts`. Full `ProjectEventRecord`s are in scope (display title/summary/url, subject, metadata.message and actor for channels).
  - Ops decision: `operations-actions/decision-delivery.ts`.
  - Schedule wake: `project-event-schedules-admission.ts`. `creatorChatSessionId` tells an agent-made schedule from a human one.
  - GitHub trigger into an existing session: `github-trigger-queue.ts`.
  - Restored-session continue: `restored-session-prompt.ts`.
  - send_durable_message durable path: `routes/mcp/mailbox-tools.ts`.
  - send_message_to_subtask durable path: `routes/mcp/orchestration-comms.ts`.
  - Stall check-in: `project-data/reconciliation.ts` (persistMessage plus its own metadata).
- Display-only `role:'system'` rows render as a monospace "System" bubble (`SystemMessageBubble`).

## Checklist

- [x] Shared: `packages/shared/src/types/sam-notices.ts` (types, version, metadata key, `buildSamNotice` clamp, `parseSamNotice` validator) and barrel exports.
- [x] API: `AcceptPromptDeliveryInput.notice`; one helper builds the tool metadata for both the persisted row and the broadcast; strip caller `samNotice`.
- [x] API: strip `samNotice` from vm-agent batch tool metadata.
- [x] API: notice builders (pure module), with unit tests.
- [x] Attach notices: parent wake, event wake (generic, lifecycle, GitHub, agent channel), ops decision, schedule (agent-created only), GitHub trigger, restored session, send_durable_message, send_message_to_subtask, stall check-in.
- [x] Web: map notices in `chatMessagesToConversationItems` (user rows with durable/orchestrator kind; system rows).
- [x] Web: `NoticeRow`, `NoticeRefCard`, task quick-look dialog (TanStack Query, existing task API).
- [x] Web: system rows render as compact notice rows (first line headline, full text expandable).
- [x] Tests: trust (forged notice ignored and stripped), builders, real-trigger integration for parent wake and event wake, web rendering behaviour.
- [x] Playwright visual audit (mobile and desktop, long text, many refs, no refs).
- [x] Docs: public docs mention of how SAM messages appear in chat.
- [x] Remove the prototype route and directory.

### Resume, 2026-11-07 (task 01M6VJ8SFK39S28HXFCR9QZQ5T)

- [x] Rebase onto main (ff0c9e0f5); re-run lint, typecheck and tests. #2558's MCP tool renames touch no human-facing notice text.
- [x] /sam (and project agent) `send_message_to_subtask` (`durable-objects/sam-session/tools/send-message-to-subtask.ts`) is a second implementation the first pass missed. It now uses durable delivery with a `samAssistantMessageNotice` when durable delivery is enabled, like the MCP tool. Its local `ACTIVE_STATUSES` (`running`, `provisioning`, ...) did not include `in_progress`, so it refused every running task; it now uses the shared `LIVE_TASK_STATUSES`.
- [x] Event batches over the eight-card cap rank failures first and say how many are shown (rule 65).
- [x] Strip caller notices in `createReservedTaskSessionWithInitialMessage` too (defence in depth; the only caller passes null today).
- [x] Notice row: icon, time and chevron stay on the headline's first line when an expanded headline wraps (measured-coordinate Playwright check, proven red on the old layout); severity-specific `role="img"` label; `aria-controls` only while expanded.
- [x] Vertical-slice tests through the real entry points for MCP `send_message_to_subtask`, the /sam tool, ops decisions, restored sessions, and agent vs human schedules; builder tests for the remaining builders.
- Not changed: `project-event-provider-limit-delivery.ts` rebuilds the wake input on retry but only refreshes `eventIds`/`eventCount` on the transcript row; the notice was written when the wake was first accepted, from the events. GitHub trigger routing is covered at the builder level; its acceptance goes through the same `acceptPromptDelivery` notice path the slices above prove.

## Acceptance criteria

- [x] A parent wake, event wake, ops decision, agent message, stall check-in and restored-session prompt render as a compact SAM row, not the owner's bubble, both on reload and live. (Reload and live socket paths covered by web tests; parent wake, agent message and system rows seen on staging.)
- [x] Tapping expands it to show detail, quote, cards and the agent text. A task card opens a modal with live task data. Other cards link.
- [x] A `samNotice` supplied by an agent through `send_durable_message` metadata, or through the vm-agent batch, is not stored and not rendered.
- [x] Unknown notice versions fall back to the old rendering.
- [x] Agent-facing prompt text is unchanged.
- [x] Verified on staging with a real subtask wake and a real agent message.

## Implementation notes

- Prototype commit 726624039 removed in 6ef966564 (no `/prototype/notice-rows` route remains).
- Live path: `message.new` carries the same metadata via `promptDeliveryToolMetadata` (`sam-notice-metadata.ts`), used by both the persisted row and the broadcast.
- Check-in notice is added only to the persisted row; the VM delivery claim metadata is unchanged.
- Schedules: only agent-created schedules (`creatorChatSessionId` set) get a notice; a person's scheduled message stays their bubble.
- Comment directives keep their existing attribution rendering (a person's words), no notice.
- Discrimination checks: removing the API strip turned 2 of 3 workers tests red (control stayed green); removing the web trust check turned the forged-row test red.
- File size: prompt-delivery.ts (+3), messages.ts (+4), reconciliation.ts (+6) were already over 500 lines; new logic lives in new modules.

## Staging verification, 2026-11-07 (task 01M6VW5M9F1GBXB0K4BYQD9A7T)

Deploy Staging run 42413219282 (green, smoke tests pass) at 26c532578. Project "Potato" on staging, started from the project chat composer.

- Real subtask wake: parent task 01M6VXH6KVS6Y4AQ1QP5BQYQ7S dispatched cf-container child 01M6VXXDW24DC90PZ1K7PGG867 and called `wait_for_subtasks`. When the child completed, the parent chat showed "Subtask finished: Acknowledge test child notification" as a compact row; expanded, it had a task card with live status "Completed" and "Show what the agent saw". Stored row: `source: parent_wakeup`, `kind: durable_prompt_delivery`, `samNotice.type: subtask.finished`.
- Real agent message: parent task 01M6VYG8P1100DD8ZK13SDQ43Y sent "Hello from your parent - SAM notice test 2." to child 01M6VYJRAG8CV8NCJ0R01P36W2 with `send_message_to_subtask`. The child chat showed "Message from another agent", quoting the text as "Another agent · not written by SAM", with a task card. Delivered over the agent DM channel (`source: project_event_wake`, `samNotice.type: agent.message`). No horizontal overflow at 375px or 1280px.
- System rows ("Task execution started") render as compact rows.
- Found on the way, not caused by this branch: `send_message_to_subtask` refuses a child that is still starting even with durable delivery enabled (`resolveAgentTarget`). Filed `tasks/backlog/2026-11-07-message-starting-subtask-with-durable-delivery.md`.

## Rebase onto #2574 (Human Voice Is Reserved), 2026-11-08

- #2574 (constitution XV) removed the raw durable paths from `send_durable_message` and MCP `send_message_to_subtask`: agent text now reaches agents only through the agent message channel. Notices for those messages come from the channel's event wake (`projectEventWakeNotice`, `agent.message`), so the mailbox/parent notice builders and `sam-notice-lookups.ts` were deleted as dead code. The forged-metadata check moved to the channel workers test, and a channel slice for MCP `send_message_to_subtask` was added.
- Reverted the /sam `send_message_to_subtask` change to `main`. Fixing its status list would switch on a path that hands the assistant's model text to an agent as a plain prompt, which XV forbids. Filed `tasks/backlog/2026-11-08-sam-assistant-subtask-message-pointer.md`.
- Agent-authored schedules keep `main`'s `agentScheduleNotice` delivery text; the display-only `scheduledMessageNotice` rides on the row.
