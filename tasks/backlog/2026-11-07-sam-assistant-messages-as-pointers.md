# /sam assistant messages to task agents must arrive as pointers (constitution XV)

## Problem

Constitution principle XV (Human Voice Is Reserved, added 2026-11-07) says only human-written text may
reach an agent as a plain chat message. The /sam assistant's own `send_message_to_subtask` tool
(`apps/api/src/durable-objects/sam-session/tools/send-message-to-subtask.ts`) still breaks it. It
persists model-written text through `persistOrchestrationPrompt` and sends it with
`sendPromptToAgentOnNode` as a user prompt. When the target is busy, the 409 fallback enqueues it with
`senderType: 'human'`.

The MCP messaging tools moved to pair channels in the Human Voice PR. The /sam assistant cannot use
them directly: a /sam conversation has no task-backed chat session to own a pair subscription.

A related edge, recorded but not decided: GitHub-trigger templates are human-authored, but
`renderedPrompt` can interpolate GitHub-supplied text such as PR titles and bodies
(`services/github-trigger-queue.ts`). Raphaël put trigger templates out of scope for the first PR.

## Context

Found while implementing idea `01M6VEW6VYZ39YNHSW28836QWP` (peer steer rendered as a user bubble in
chat `fbcca13b-b4ab-4e62-8e3b-ccdaa3f2a57d`). The assistant is opt-in and off by default.

## Acceptance Criteria

- [ ] A /sam message to a task agent reaches the agent's chat only as a SAM-authored notice with an
      ID. The agent reads the text through a tool that marks it as written by the SAM assistant and
      untrusted.
- [ ] The 409 queue fallback no longer records model text with `senderType: 'human'`.
- [ ] Decide with Raphaël whether interpolated GitHub text in trigger templates must become a
      pointer, and record the decision.
- [ ] Tests drive the real /sam tool and assert the target transcript never contains the model text.
