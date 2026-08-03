# Durable follow-up prompt delivery for existing chat sessions

## Problem

First-message/session-start durability is now handled separately, but follow-up prompts still use a single request-bound delivery path:

- `apps/api/src/routes/chat.ts` `POST /api/projects/:projectId/sessions/:sessionId/prompt`
- The route validates the user, resolves the live workspace/agent session, enriches the prompt, then awaits `sendPromptToAgentOnNode(...)`.
- If the browser/phone closes during that request, the user's intent is not server-acknowledged as a durable prompt before VM delivery completes.

This is adjacent to the same user-visible failure class as Instant first-message starts: the user can see `failed to fetch` after submitting a prompt and cannot distinguish “not accepted” from “accepted but still delivering.”

## Proposed scope

Convert follow-up prompt submission into durable accept + server-owned delivery:

1. Persist a user message or prompt-delivery row with a client/server `messageId`, session id, task/workspace/agent-session linkage, creator, timestamps, and status (`queued`, `delivering`, `delivered`, `failed`).
2. Return quickly with the durable `messageId` and status.
3. Deliver to the VM agent from a request-independent owner, reusing existing VM `messageId` support so duplicate/ambiguous sends are idempotent.
4. Expose queued/delivering/failed follow-up state on refresh and allow retry of failed deliveries.
5. Add a stale delivery sweep so accepted follow-up prompts do not remain queued/delivering indefinitely after request or runtime interruption.

## Acceptance criteria

- Closing the browser after follow-up prompt acceptance does not lose the user's prompt.
- Refreshing the chat shows the prompt's queued/delivering/failed state.
- Duplicate retries or ambiguous acknowledgements do not create duplicate VM messages.
- Failed follow-up deliveries are visible and retryable.

