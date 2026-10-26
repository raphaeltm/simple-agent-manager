# Durable follow-up prompt delivery for existing chat sessions

> **Reconciliation 2026-10-26:** Still open. #2381 (`110730c2a`) moved `sendFollowUpPrompt` to
> `apps/web/src/lib/api/sessions.ts:411-424` (still no key, and its type still omits
> `deliveryId`), and the `mailbox.delivery_updated` broadcast is now
> `prompt-delivery-runner.ts:276`. #2381's new "Not delivered" label (`message-attribution.ts:35`)
> covers only prompts cancelled because the sender's shared access ended; queued, delivering and
> failed states and retry are still missing.

> **Reconciliation 2026-10-12:** The server half of the idempotency item shipped. #2291
> (`d4fa4f372`) runs `POST .../sessions/:sessionId/prompt` through `cliOperationReceipt`
> (`apps/api/src/routes/chat-prompt-route.ts:17-30`), so a retry that repeats the same
> `Idempotency-Key` header replays the stored response instead of creating a second delivery
> (`apps/api/src/services/cli-operation-receipts.ts:26-91`; test
> `apps/api/tests/unit/routes/cli-worker-contract.test.ts:183-200`). Only the CLI sends that header
> (`packages/cli/internal/cli/client.go:407`). Still open: the web client sends no key and still
> ignores `deliveryId`/`status` (`apps/web/src/lib/api/sessions.ts:392-404`), nothing in the web
> app consumes `mailbox.delivery_updated` (now `prompt-delivery-runner.ts:249`), and there is no
> retry UI.

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** the server side, in PR #1785 (00169b016):
>   - Durable accept: the follow-up is stored in ProjectData as a delivery row plus transcript
>     message (`apps/api/src/durable-objects/project-data/prompt-delivery.ts:51`).
>   - Fast 202 with `deliveryId` and `messageId` (`apps/api/src/routes/chat-prompt-route.ts:45-66`).
>     On by default (`DEFAULT_DURABLE_PROMPT_DELIVERY_ENABLED = true`,
>     `packages/shared/src/constants/durable-execution.ts:2`); production has no GitHub
>     Environment override and staging sets it to `true`.
>   - Request-independent delivery from the ProjectData alarm runner (`prompt-delivery-runner.ts`)
>     with idempotent `deliveryId` receipts
>     (`apps/api/src/services/vm-prompt-delivery-adapter.ts:171-281`).
>   - Stale sweep: TTL and max-attempt expiry (`prompt-delivery.ts:137-166`).
> - **Still open:**
>   - The web client ignores `deliveryId` and `status` (`apps/web/src/lib/api/sessions.ts:433-445`)
>     and treats the 202 as delivered
>     (`apps/web/src/components/project-message-view/useSessionLifecycle.ts:404-407`).
>   - Nothing in the web app consumes the `mailbox.delivery_updated` broadcast
>     (`prompt-delivery-runner.ts:469`), so queued, delivering and failed states are not shown,
>     on refresh or otherwise.
>   - No user-facing retry for a failed delivery.
>   - No client idempotency key: `SendChatMessageSchema` (`apps/api/src/schemas/misc.ts:51-53`)
>     takes only `content`, so a browser retry after an ambiguous failure creates a second delivery.

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

