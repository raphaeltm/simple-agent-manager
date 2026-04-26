# Phase 1: Durable Interrupts and Messaging

## Problem Statement

SAM's current agent-to-agent messaging (`send_message_to_subtask`) is best-effort: if the agent is busy, the message is rejected (409). There's no persistence, no ack tracking, no expiry, and no escalating urgency. This is too weak for real orchestration — when a parent says "change approach," it must eventually reach the child, even if the child is mid-turn.

Phase 1 of the SAM orchestrator vision builds the durable messaging layer: a mailbox system with 5 message classes, a delivery state machine, ack tracking, and graceful shutdown-with-final-prompt.

## Research Findings

### Existing Infrastructure
- **Migration 015 (`session_inbox`)** already created a basic inbox table in ProjectData DO SQLite. It has `id`, `target_session_id`, `source_task_id`, `message_type`, `content`, `priority`, `created_at`, `delivered_at`. No DO methods or routes use it — it's an unused skeleton.
- **Migration numbering**: latest is 016 (knowledge-graph). Next migration is 017.
- **`send_message_to_subtask`** (orchestration-comms.ts): Resolves child task → workspace → node → agent session, then calls `sendPromptToAgentOnNode()`. Returns `{ delivered: true }` or `{ delivered: false, reason: 'agent_busy' }` on 409.
- **MCP tool registration**: Tools defined in `tool-definitions-*.ts`, aggregated in `tool-definitions.ts`, routed in `index.ts` switch statement.
- **ProjectData DO pattern**: Constructor runs migrations via `blockConcurrencyWhile()`. Methods delegate to module files (sessions.ts, messages.ts, knowledge.ts, etc.). Service layer in `services/project-data.ts` wraps DO RPC calls.
- **Config pattern**: Defaults in `_helpers.ts` with `parsePositiveInt(env.VAR, DEFAULT)`, exposed via `getMcpLimits()`.
- **Row parsing**: Valibot schemas in `row-schemas.ts` for every table.

### Design Decisions
1. **Extend session_inbox** rather than creating a new table — ALTER TABLE to add missing columns. This avoids orphan tables.
2. **Rename to `agent_mailbox`** for clarity (the table targets agents/sessions, not just sessions).
3. **Message class hierarchy**: notify < deliver < interrupt < preempt_and_replan < shutdown_with_final_prompt. Only `notify` is best-effort; all others are durable.
4. **Delivery via DO alarm**: A ProjectData DO alarm checks for undelivered messages and attempts delivery. This survives Worker restarts.
5. **`send_message_to_subtask` becomes a thin wrapper**: Creates a `notify`-class message and attempts immediate delivery (backwards compatible).

## Implementation Checklist

### Phase A: Schema & Types
- [ ] A1. Add shared types for `AgentMailboxMessage`, `MessageClass`, `DeliveryState` to `packages/shared/src/types/`
- [ ] A2. Add env var defaults for mailbox config to `_helpers.ts` (MAILBOX_ACK_TIMEOUT_MS, MAILBOX_REDELIVERY_MAX_ATTEMPTS, MAILBOX_TTL_MS, MAILBOX_DELIVERY_POLL_INTERVAL_MS, MAILBOX_MAX_MESSAGES_PER_PROJECT)
- [ ] A3. Write DO migration 017 to ALTER TABLE `session_inbox` → add columns: `message_class`, `delivery_state`, `sender_type`, `sender_id`, `ack_required`, `acked_at`, `expires_at`, `delivery_attempts`, `last_delivery_at`, `ack_timeout_ms`, `metadata`
- [ ] A4. Add Valibot row schema for the extended mailbox table in `row-schemas.ts`

### Phase B: DO Mailbox Module
- [ ] B1. Create `apps/api/src/durable-objects/project-data/mailbox.ts` with core functions:
  - `enqueueMessage()` — insert into agent_mailbox with delivery_state='queued'
  - `getPendingMessages()` — query by target, class, state
  - `markDelivered()` — set delivery_state='delivered', delivered_at
  - `acknowledgeMessage()` — set delivery_state='acked', acked_at
  - `expireStaleMessages()` — set expired for messages past TTL or max delivery attempts
  - `getMailboxStats()` — count by state/class for admin
- [ ] B2. Wire mailbox methods into ProjectData DO class (index.ts) as public RPC methods
- [ ] B3. Add service layer wrappers in `services/project-data.ts`

### Phase C: Delivery Engine
- [ ] C1. Implement delivery attempt logic: resolve target agent session, call `sendPromptToAgentOnNode()`, handle 409 (re-queue for turn boundary)
- [ ] C2. Implement DO alarm-based delivery sweep: check for queued/undelivered messages, attempt delivery, handle retries
- [ ] C3. Implement ack timeout → re-delivery or escalation logic
- [ ] C4. Implement `shutdown_with_final_prompt`: deliver final message, mark ACP session for termination after agent responds

### Phase D: MCP Tools
- [ ] D1. Add `send_durable_message` MCP tool definition and handler — creates message of specified class, attempts immediate delivery for notify/deliver
- [ ] D2. Add `get_pending_messages` MCP tool definition and handler — returns unacked messages for the calling agent
- [ ] D3. Add `ack_message` MCP tool definition and handler — agent acknowledges a received message
- [ ] D4. Add new tool definitions to `tool-definitions-orchestration-tools.ts` and `tool-definitions.ts`
- [ ] D5. Wire tool handlers into `index.ts` switch statement

### Phase E: Upgrade send_message_to_subtask
- [ ] E1. Refactor `send_message_to_subtask` to create a `notify`-class message via the new mailbox, then attempt immediate delivery (backwards compatible response shape)
- [ ] E2. On 409 (agent busy), queue for turn-boundary delivery instead of returning `{ delivered: false }`

### Phase F: REST API
- [ ] F1. Add `GET /api/projects/:projectId/mailbox` — list messages with filters (state, class, target)
- [ ] F2. Add `GET /api/projects/:projectId/mailbox/:messageId` — get single message
- [ ] F3. Add `DELETE /api/projects/:projectId/mailbox/:messageId` — cancel/expire a queued message

### Phase G: Tests
- [ ] G1. Unit tests for mailbox DO module (enqueue, deliver, ack, expire)
- [ ] G2. Integration test: message delivery state machine (queued → delivered → acked)
- [ ] G3. Integration test: unacked message re-delivery after timeout
- [ ] G4. Integration test: shutdown_with_final_prompt delivers and marks for termination
- [ ] G5. Integration test: send_message_to_subtask backwards compatibility (notify class, same response shape)
- [ ] G6. Capability test: cross-boundary delivery (Worker → DO → VM agent mock)
- [ ] G7. Migration safety test (017 doesn't DROP TABLE, uses ALTER TABLE)

### Phase H: Documentation
- [ ] H1. Update CLAUDE.md with mailbox env vars and new MCP tools
- [ ] H2. Add env vars to `apps/api/.env.example`

## Acceptance Criteria
- [ ] Messages of all 5 classes can be created, stored, and delivered
- [ ] Delivery state machine works: queued → delivered → acked → expired
- [ ] Unacked messages re-deliver after configurable timeout
- [ ] `shutdown_with_final_prompt` delivers a final prompt and marks session for termination after the agent's response
- [ ] Existing `send_message_to_subtask` upgraded to use the new system (backwards compatible)
- [ ] MCP tools: `send_durable_message`, `get_pending_messages`, `ack_message`
- [ ] REST API for message inspection
- [ ] All timeouts/TTLs configurable via env vars
- [ ] Capability tests proving cross-boundary delivery works
- [ ] Migration safety verified (no DROP TABLE)

## References
- Vision: `.library/sam-the-orchestrator.md` — "Interrupts and Durable Messaging" section
- Existing: `apps/api/src/routes/mcp/orchestration-comms.ts` — send_message_to_subtask
- Existing: `apps/api/src/durable-objects/migrations.ts` — migration 015 (session_inbox)
- Pattern: `apps/api/src/durable-objects/project-data/knowledge.ts` — DO module pattern
- Pattern: `apps/api/src/routes/mcp/_helpers.ts` — config pattern
