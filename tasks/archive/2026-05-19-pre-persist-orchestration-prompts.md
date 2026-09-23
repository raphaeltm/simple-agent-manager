# Pre-persist orchestration prompts

## Problem

Follow-up prompts sent from parent agents to subtasks can reach the VM agent before a corresponding user-role chat message is durably persisted in ProjectData. If the VM reporter fails or the workspace shuts down before flushing, the child chat UI loses the prompt even though the agent acted on it.

## Research

- `apps/api/src/durable-objects/project-data/reconciliation.ts` persists a user message before sending a check-in prompt.
- `projectDataService.persistMessage()` already broadcasts `message.new` through the ProjectData DO side effects.
- The three orchestration callers of `sendPromptToAgentOnNode()` currently send first and rely on VM reporter persistence.
- `packages/vm-agent/internal/acp/session_host_prompt.go` synthesizes user notifications and enqueues them with newly generated IDs from `ExtractMessages()`.
- `ProjectData.persistMessageBatch()` deduplicates by ID and, for user messages, by content, but passing the same ID through the prompt path gives a stricter contract.
- Relevant postmortems: missing initial prompt, message relay, chat message duplication, idle cleanup message activity.

## Checklist

- [x] Add optional message ID support to ProjectData direct message persistence.
- [x] Add API helper to pre-persist orchestration prompts and pass that ID to VM prompt delivery.
- [x] Update all three orchestration prompt callers.
- [x] Thread `messageId` through node-agent prompt HTTP payload and VM agent `HandlePrompt`.
- [x] Use the provided message ID when enqueuing synthetic user messages to the reporter.
- [x] Add tests for pre-persist-before-send, reporter dedupe with same ID, and 409 queue behavior.
- [ ] Run focused TypeScript and Go tests.

## Acceptance Criteria

- Parent-agent follow-up prompts are visible in ProjectData before the VM agent receives them.
- Immediate delivery and busy-agent mailbox queue paths both pre-persist the user message.
- VM reporter reuse of the same message ID is treated as a duplicate by ProjectData.
- Existing chat prompt senders continue to work without a provided message ID.
