# ACP C1 structured form elicitation

## Problem

The shipped B permission bridge handles only `session/request_permission`. Pinned Claude and Codex adapters can issue `elicitation/create` forms, but SAM does not advertise or handle them. An agent asking a question therefore cannot receive a durable, creator-authored answer through the chat.

## Research

- Base is #2202 (`aecaf205f`); its InteractionStore is Cloudflare authority with encrypted details/decisions, creator-only detail and answer routes, bounded deadlines and no-wake delivery.
- Pinned `claude-agent-acp@0.81.2` forwards MCP forms and AskUserQuestion as `elicitation/create`; pinned `codex-acp@1.13.1` emits forms for MCP and request_user_input. Codex normalizes legacy enumNames to oneOf, and its custom answer has a companion note field.
- `acp-go-sdk@v0.13.5` offers optional `UnstableCreateElicitation` handler and `ClientCapabilities.Elicitation.Form`; URL capability must remain nil. The generated form request omits optional scope fields; the active prompt supplies authoritative session scope.
- The SDK decode drops `sessionId`, `toolCallId`, and `requestId` from the form request, and unknown root `requestedSchema` members. The production stdout line guard replaces a form with an explicitly unsupported schema before SDK decode if root constraints or top-level keys are unknown; the callback then cancels it. The live prompt attempt and generation are authoritative because decoded scope fields are unavailable.
- Claude `AskUserQuestion` choice previews use a bounded `_claude/askUserQuestionOption` metadata shape; Codex request metadata uses bounded `codex.autoResolutionMs`. Unknown metadata cancels.
- B UI renders permission cards in the real message view and has reconnect snapshot polling. Form cards should use the same placement, owner-only detail, and safe state summary.
- Approved v2 in idea `01M3P2E0JJNQRXX020P65ZRKEJ` is the scope source. Task forms explicitly cancel. B activation agent owns permission rollout/defaults; parent owns release and shared staging gate.

## Checklist

- [x] Define exact bounded flat schema subset and shared/Go validation fixtures for supported pinned shapes; reject all unknown constraints and recursive metadata.
- [x] Add conversation-only form capability and bounded runtime contract; leave URL disabled.
- [x] Route form create, cancellation, answer, and receipt through the existing generation-fenced Cloudflare bridge; reject task forms and stale/no-waiter answers.
- [x] Validate form schema and answer on Worker and Go boundaries; encrypt request and answer in InteractionStore and keep sensitive values out of events, logs, transcript and cache.
- [x] Render accessible responsive form card in real chat with required fields, select/custom answer, accept/decline, expiry and reconnect states.
- [x] Add deterministic pinned adapter fixtures and runtime/Worker/UI path tests, public docs, and C2/D handoff.
- [ ] Run focused/full checks, specialist reviews, desktop/mobile screenshots, CI; create stacked draft PR and send parent evidence.

## Acceptance

- Accepted form content matches the actual schema and reaches only the live callback once; rejection/cancel/expiry never becomes an empty accepted object.
- Creator-only detail and answer, body/key idempotency, no-wake transport, generation fencing and receipt uncertainty remain intact.
- Task mode and unsupported schemas cancel explicitly; URL is not advertised.
- Worker and Go agree on a shared corpus of valid/invalid schemas and answers, including bounds and custom-answer shapes.
- UI works after reconnect and at mobile/desktop widths with screenshot evidence; docs state actual support.
- No staging until B activation releases it and parent confirms the exact reviewed candidate. No ready transition, merge, or production mutation by this task.

## Validation and UI decisions

- The shared corpus contains exact outputs from pinned `claude-agent-acp@0.81.2` and `codex-acp@1.13.1` form builders. `pnpm --filter @simple-agent-manager/shared test:pinned-acp-forms` executes those builders from the installed, version-checked adapter packages and compares their output to the corpus; it requires both packages installed, as in the production VM image. Go and TypeScript run the same 14 corpus cases. The Go test also exercises the pinned `acp-go-sdk@v0.13.5` JSON-RPC wire path and exact scope-field loss. This is deterministic fixture evidence, not an external Claude or Codex account success.
- Worker tests exercise conversation-only callback creation, creator answer, encrypted form storage, late-answer expiry, idempotency and VM delivery mock. Go tests cover deadline, cancellation, generation, prompt handoff and duplicate receipt. Playwright covers creator/noncreator, accepted/declined, unknown receipt retry, reload, expiry display and 375px/1280px screenshots; a 320px overflow check also runs.
- UI variants considered: chat-inline card, blocking modal, and separate side panel. The chat-inline card keeps context and works at mobile widths without a second navigation state. It shows a generic card to noncreators and only fetches form detail for the creator. Reviewed screenshots are in `.codex/tmp/playwright-screenshots/` (`acp-form-owner-*`, `acp-form-actions-*`, `acp-form-receipt-*`, `acp-form-noncreator-*`). Final rubric: hierarchy 4/5, interaction clarity 4/5, mobile usability 4/5, accessibility 4/5, system consistency 4/5. Sticky-header clearance, option descriptions, array labels, invalid-field focus and post-answer receipt visibility were fixed after review.
- Security, Go/Cloudflare and UI specialist re-reviews found no release blockers after fixes. Live external-account form success remains for gated staging verification; fixture tests do not claim it.

## C2 / D handoff

- C2 URL elicitation needs a separate capability flag, request/complete callback and receipt lifecycle. C1 advertises only `elicitation.form`, returns cancel for URL requests, and stores no URL or callback token in a form detail. Preserve the same session creator authorization, runtime generation, deadline, no-wake and encrypted-store authority.
- C1's validated form content is `decision.kind='accepted'` plus `content` and its canonical SHA-256 `answerHash`; decline is `decision.kind='declined'`. The Worker commits one answer key/body receipt, then the VM callback consumes it for the matching generation. C2 should reuse the interaction identity and settlement states but define its own URL-specific decision schema; never coerce URL completion into `{}` form acceptance.
- D diagnostics can report only safe `interactionId`, kind, state, generation/receipt status, and reason codes. Raw form schema, question, answers, wrapper metadata, credentials and URL tokens must stay out of events/logs/transcripts/cache.
