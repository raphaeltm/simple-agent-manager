# Human Voice Is Reserved: agent-written text reaches agents only as pointers

## Problem

On 2026-11-07 a peer agent's message appeared in chat `fbcca13b-b4ab-4e62-8e3b-ccdaa3f2a57d` as a plain
user bubble (transcript message `01M6VE1QFMZD43SCVXJ0NYB1CQ`). Both the human and the receiving agent
could take it for a human message. Idea `01M6VEW6VYZ39YNHSW28836QWP`.

Root cause: `send_durable_message` with `deliveryIntent: "steer"` skips the agent message channel
(`apps/api/src/routes/mcp/mailbox-tools.ts`, added in #2536) and calls `acceptPromptDelivery`. That path
persists the sender's raw text as a `role: 'user'` transcript row (`prompt-delivery.ts`). Urgent classes
(interrupt and above) take the same path, and so does every send when channels are off. Agent-created
schedules (`message_session`) also post agent-written text as a plain message.

Raphaël's rule: only a human may write a plain message to an agent. That covers typed messages, comments,
and human-authored templates. Everything else arrives as a SAM-authored pointer naming IDs, and the agent
reads the content through a tool that marks it untrusted. `dispatch_task` stays plain text, but the
child's first message must say which parent agent sent it. Trigger templates are out of scope.

## Research findings

- `trySendOverAgentMessageChannel` (`routes/mcp/agent-message-channel-send.ts`) handles only notify/deliver
  and returns null when channels are off. Both `send_durable_message` and `send_message_to_subtask` then
  fall back to raw injection.
- The DO channel send (`durable-objects/project-data/agent-message-channels.ts`) rejects classes other
  than notify/deliver (`CHANNEL_MESSAGE_CLASSES`). The shared type is `AgentChannelMessageClass`.
- Pair subscriptions already request `runtime_steer` (#2546), so a channel message already steers into a
  busy recipient. A steer intent therefore needs no special path.
- Wake prompts (`project-events-wake-prompt.ts` `buildWakePromptInput`) pick their class from the
  subscription. Materialization (`project-events-materialization.ts`) has the batch's events, so it can
  derive urgency from the agent-message events' `metadata.messageClass`.
- Channels default off in code (`DEFAULT_AGENT_MESSAGE_CHANNELS_ENABLED = false`) but on in
  `wrangler.toml`, and production uses them (event `b8d3d351-…`).
- Schedules do not persist whether a person, an agent or SAM wrote the prompt. `ScheduleCreator` exists
  only at create time. `provider-limit-parking.ts` creates schedules with a SAM constant prompt;
  operations map `via: 'sam'` (the /sam LLM) to `system`.
- `buildDispatchDescription` (`routes/mcp/dispatch-description.ts`) builds the description that becomes
  the child's first user message. It truncates at `maxLength`, so the attribution must be added after
  truncation.

## Implementation checklist

- [x] Constitution principle XV "Human Voice Is Reserved", plus a version bump
- [x] Shared: widen `AgentChannelMessageClass` to every `MessageClass`
- [x] DO channel send accepts urgent classes
- [x] Wake materialization delivers a batch holding an urgent agent message as stop-and-deliver with that
      class; the notice stays IDs-only
- [x] `send_durable_message`: every class and every delivery intent goes over the channel; fail closed
      with a named reason when channels are unavailable; remove the raw-injection code
- [x] `send_message_to_subtask`: same fail-closed behavior; remove the raw-injection fallback
- [x] Remove dead helpers (`composePeerSteerContent`, `composeUrgentDeliveryContent`,
      `attemptImmediateDelivery` if unused) and their tests
- [x] DO migration `075`: `project_schedules.prompt_author` (nullable; NULL means a legacy row)
- [x] Record prompt_author at every schedule create path (web: human, MCP agent: agent, operations:
      workspace-agent/sam → agent, connector/person → human, provider-limit: sam)
- [x] Agent-authored `message_session` schedules deliver a SAM pointer notice (read with
      `schedules_read` get), not the prompt text
- [x] Dispatch: append parent attribution (task + chat session) after truncation
- [x] Update tool descriptions and agent guidance (`instruction-eventing-guidance.ts`, tool definitions)
- [x] Update public docs that describe steering and agent messaging
- [x] Tests (see acceptance criteria)

## Implementation notes

- `stop_subtask` also injected the parent's raw reason (`[STOP REQUESTED BY PARENT] <reason>`); it now
  sends `stopRequestedNotice` and records the reason on the task only.
- `retry_subtask` builds its own replacement description; it strips the predecessor's attribution and
  appends the retrying parent's.
- Agent-created `start_session` schedules launch a task whose first message the agent wrote; they get
  the same footer as dispatch (`scheduledTaskPrompt`).
- Channel messages are capped at `PROJECT_EVENT_CHANNEL_MESSAGE_MAX_BYTES` (4096 by default), which
  already applied to ordinary agent messages in production. Steers and urgent messages now share it.
- Out of scope, tracked in `tasks/backlog/2026-11-07-sam-assistant-messages-as-pointers.md`: the /sam
  assistant's own `send_message_to_subtask` tool, and GitHub text interpolated into trigger templates.

## Acceptance criteria

- [x] A steer `send_durable_message` produces a channel event; the recipient's transcript holds only the
      SAM notice, never the raw text (worker test through the real DO)
- [x] An `interrupt` message produces a stop-and-deliver wake whose content is the IDs-only notice
- [x] With channels off, `send_durable_message` and `send_message_to_subtask` return an error naming the
      reason, and nothing is written to the transcript
- [x] An agent-created `message_session` schedule delivers a pointer; a human-created one and a
      provider-limit one still deliver their prompt text
- [x] A dispatched child's description ends with the parent task and session attribution, including
      when the caller's description is at the length limit
- [x] The constitution contains principle XV

## References

- Idea `01M6VEW6VYZ39YNHSW28836QWP`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`, `apps/api/.claude/rules/31-migration-safety.md`
