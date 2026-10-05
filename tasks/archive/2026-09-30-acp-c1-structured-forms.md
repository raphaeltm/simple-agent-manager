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
- [x] Run focused/full checks, specialist reviews, desktop/mobile screenshots, CI; create stacked draft PR and send parent evidence.

## Acceptance

- Accepted form content matches the actual schema and reaches only the live callback once; rejection/cancel/expiry never becomes an empty accepted object.
- Creator-only detail and answer, body/key idempotency, no-wake transport, generation fencing and receipt uncertainty remain intact.
- Task mode and unsupported schemas cancel explicitly; URL is not advertised.
- Worker and Go agree on a shared corpus of valid/invalid schemas and answers, including bounds and custom-answer shapes.
- UI works after reconnect and at mobile/desktop widths with screenshot evidence; docs state actual support.
- No staging until B activation releases it and parent confirms the exact reviewed candidate. No ready transition, merge, or production mutation by this task.

## Validation and UI decisions

- The shared corpus contains exact outputs from pinned `claude-agent-acp@0.81.2` and `codex-acp@1.13.1` form builders. With `CLAUDE_ACP_PACKAGE_DIR` and `CODEX_ACP_PACKAGE_DIR` pointing to installed packages, `pnpm --filter @simple-agent-manager/shared test:pinned-acp-forms` executes the version-checked Claude builder and checks the exact Codex bundle builder/helper source fingerprints and constants against the reviewed fixture; Codex publishes no importable builder export. Go and TypeScript run the same 14 corpus cases. The Go test also exercises the pinned `acp-go-sdk@v0.13.5` JSON-RPC wire path and exact scope-field loss. This is deterministic fixture/source evidence, not an external Claude or Codex account success.
- Worker tests exercise conversation-only callback creation, creator answer, encrypted form storage, late-answer expiry, idempotency and VM delivery mock. Go tests cover deadline, cancellation, generation, prompt handoff and duplicate receipt. Playwright covers creator/noncreator, accepted/declined, unknown receipt retry, reload, expiry display and 375px/1280px screenshots; a 320px overflow check also runs.
- UI variants considered: chat-inline card, blocking modal, and separate side panel. The chat-inline card keeps context and works at mobile widths without a second navigation state. It shows a generic card to noncreators and only fetches form detail for the creator. Reviewed screenshots are in `docs/notes/acp-c1-screenshots/` (`acp-form-owner-*`, `acp-form-actions-*`, `acp-form-empty-*`, `acp-form-receipt-*`, `acp-form-noncreator-*`). Final rubric: hierarchy 4/5, interaction clarity 4/5, mobile usability 4/5, accessibility 4/5, system consistency 4/5. Sticky-header clearance, option descriptions, array labels, invalid-field focus, explicit valid empty answers and post-answer receipt visibility were fixed after review.
- Security, Go/Cloudflare and UI specialist re-reviews found no release blockers after fixes. Live external-account form success remains for gated staging verification; fixture tests do not claim it.
- Gated staging activation path: only after parent exact-head approval, list the staging and production GitHub Environment overrides and read back the effective staging Worker bindings for both flags; record their prior states. Temporarily set `ACP_INTERACTION_FORMS_ENABLED=true` in staging, and set `ACP_INTERACTIONS_ENABLED=true` there only if its prior effective value is false. Dispatch `Deploy Staging` on the reviewed branch and read back effective `sam-api-staging` plain-text bindings through Cloudflare `GET /accounts/{accountId}/workers/scripts/sam-api-staging/settings`. Both must read `true` before a fresh conversation-only Claude form fixture. The reusable deploy workflow forwards both variables into both Wrangler config sync passes; checked-in `wrangler.toml` has both `false`. Roll back by restoring each staging GitHub Environment override to its exact prior state (including absence), rerunning `Deploy Staging` on the same reviewed head, and reading back the prior effective values; do not accidentally disable an already-enabled B permission bridge. Production Environment variables are not changed by this task.

## C2 / D handoff

- C2 URL elicitation needs a separate capability flag, request/complete callback and receipt lifecycle. C1 advertises only `elicitation.form`, returns cancel for URL requests, and stores no URL or callback token in a form detail. Preserve the same session creator authorization, runtime generation, deadline, no-wake and encrypted-store authority.
- C1's validated form content is `decision.kind='accepted'` plus `content` and its canonical SHA-256 `answerHash`; decline is `decision.kind='declined'`. The Worker commits one answer key/body receipt, then the VM callback consumes it for the matching generation. C2 should reuse the interaction identity and settlement states but define its own URL-specific decision schema; never coerce URL completion into `{}` form acceptance.
- D diagnostics can report only safe `interactionId`, kind, state, generation/receipt status, and reason codes. Raw form schema, question, answers, wrapper metadata, credentials and URL tokens must stay out of events/logs/transcripts/cache.


## Parent integration evidence — 2026-10-03

The original child-task draft/no-deploy constraints above describe that handoff.
The parent owns the subsequently authorized readiness, merge and production
release. Integrated PR #2217 includes these changes; the current evidence and
remaining release steps are in `scripts/diagnostics/acp-runtime-distribution.md`.
Full integrated CI `37121769606` and staged head `e27c4d092` passed. Live VM
permissions, form and both URL completion orders passed; Instant Claude
permissions, Codex form/URL same-turn continuation, actual candidate executable
selection and fresh-stock GPT-5.5 rollback now have distinct live evidence.
Timeout/interruption and unsupported-model attempts remain explicitly excluded
from successful continuation claims. No new provider login or token custody was
added. Final rollback and release disposition remain parent-owned.

---

_Reconciled 2026-10-05 (weekly queue reconciliation): shipped via PR #2206 (`989bf7bb6`, merged 2026-09-30T21:43Z), first successful production deploy run 36783707657 (2026-09-30T22:07Z). PR #2217 (`b79136805`) later added the schema-name field labels and the release. Production enablement came with deploy run 37137757826 (2026-10-03T16:41Z), and the `sam-api-prod` readback on 2026-10-05 shows `ACP_INTERACTION_FORMS_ENABLED=true`. Live form continuation is recorded for Codex only, on VM and Instant (`scripts/diagnostics/acp-runtime-distribution.md`). #2217 lists Claude forms as deterministic builder coverage only, yet forms are offered to any agent in conversation mode (`apps/api/src/services/acp-interaction-runtime-config.ts:15`). No boxes left unticked._
