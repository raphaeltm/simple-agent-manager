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

- [ ] Shared: `packages/shared/src/types/sam-notices.ts` (types, version, metadata key, `buildSamNotice` clamp, `parseSamNotice` validator) and barrel exports.
- [ ] API: `AcceptPromptDeliveryInput.notice`; one helper builds the tool metadata for both the persisted row and the broadcast; strip caller `samNotice`.
- [ ] API: strip `samNotice` from vm-agent batch tool metadata.
- [ ] API: notice builders (pure module), with unit tests.
- [ ] Attach notices: parent wake, event wake (generic, lifecycle, GitHub, agent channel), ops decision, schedule (agent-created only), GitHub trigger, restored session, send_durable_message, send_message_to_subtask, stall check-in.
- [ ] Web: map notices in `chatMessagesToConversationItems` (user rows with durable/orchestrator kind; system rows).
- [ ] Web: `NoticeRow`, `NoticeRefCard`, task quick-look dialog (TanStack Query, existing task API).
- [ ] Web: system rows render as compact notice rows (first line headline, full text expandable).
- [ ] Tests: trust (forged notice ignored and stripped), builders, real-trigger integration for parent wake and event wake, web rendering behaviour.
- [ ] Playwright visual audit (mobile and desktop, long text, many refs, no refs).
- [ ] Docs: public docs mention of how SAM messages appear in chat.
- [ ] Remove the prototype route and directory.

## Acceptance criteria

- [ ] A parent wake, event wake, ops decision, agent message, stall check-in and restored-session prompt render as a compact SAM row, not the owner's bubble, both on reload and live.
- [ ] Tapping expands it to show detail, quote, cards and the agent text. A task card opens a modal with live task data. Other cards link.
- [ ] A `samNotice` supplied by an agent through `send_durable_message` metadata, or through the vm-agent batch, is not stored and not rendered.
- [ ] Unknown notice versions fall back to the old rendering.
- [ ] Agent-facing prompt text is unchanged.
- [ ] Verified on staging with a real subtask wake and a real agent message.
