# Let agents message a subtask that is still starting

## Problem

`send_message_to_subtask` (MCP) refuses a child task until its node is `running` and it has a `running` agent session, even though delivery now goes over the agent message channel (#2574). `resolveAgentTarget` (`apps/api/src/routes/mcp/orchestration-target.ts`, `same-project-active-agent`) returns `Target task workspace node is not running (status: creating)` and then `No running agent session found for target task` before the handler reaches the channel send in `apps/api/src/routes/mcp/orchestration-comms.ts`. The channel could hold the message for the child, whose chat session exists from dispatch.

## Context

Found on staging on 2026-11-07 while verifying SAM notice rows (branch `sam/worked-getting-cards-rendered-9qzq5t`). A parent agent dispatched a cf-container child and immediately called `send_message_to_subtask`: both attempts failed while the child was starting, and the child never received the message. The same check exists on `main`; it is not caused by the notice work.

## Acceptance Criteria

- [ ] With durable delivery enabled, `send_message_to_subtask` to a same-project child that is queued or starting (has a chat session, no running node or agent session yet) is accepted and delivered when the child's agent starts.
- [ ] With durable delivery disabled, the existing errors remain.
- [ ] Ownership and same-project checks still run before any delivery.
- [ ] A test drives the real MCP tool against a child whose node is `creating` and asserts the message is persisted to the child's chat and delivered once the session runs.
