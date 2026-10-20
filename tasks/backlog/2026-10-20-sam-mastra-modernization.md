# Top-level SAM modernization

## Request and scope

Implement canonical idea 01KQ720TE8Y8ZGVTZPBM8Y4NH0 with Mastra, default-OFF user settings opt-in, durable private conversation and actions, shared operations, project dispatch and noninterrupting updates. Draft PR initially; staging, review, CI, merge and production smoke authorized. Astra High only. No real-user enablement, new secrets or grants.

## Sources and findings

- Full canonical idea recovered with native get_idea, 63,451 characters, updated 2026-10-03. Original session 66b483cd-1671-4a7e-8b74-f88606671cb3 user decisions recovered in full.
- October15 task 01M4Z7130FK2G066YFM4M7VJZH remains research-only; its objective/action ledger recommendation is supporting research, not new scope. Native history read currently returns only latest 200 stored token rows; user messages and final recommendation recovered, earlier report still to recover.
- Main pins @mastra/core 1.77.0; existing Mastra usage is TTS. Verify runtime/provider/accounting compatibility.
- Shared operations exist under apps/api/src/operations. sam_chat_start calls submitTask; executeConnectorWrite currently bypasses actor.via=sam. Close this receipt gap before dispatch.
- Current SamSession runs browser-coupled custom inference; history loads oldest rows; no durable turn ledger or feature gate.
- Canonical roadmap separates launch from later full settings/automation/deployment parity. Initial supported workflows: accessible-project status, inbox, ideas, profiles, dispatch, reports, follow-up and controlled stop. Secure human steps remain explicit controls.
- Coordinate PR2383 and operational-controls task01M5C4GJYJ1AA0AXK1J0DH60CC. Operational-controls peer confirmed independent scope and no staging claim; reusable operation contracts coordinated. PR2383 owner task is completed; latest staging run39376917583 succeeded at05:49UTC, no queued/running staging runs observed at09:08UTC. Recheck before deployment.

## Implementation checklist

- [x] Recover canonical design and current-source contracts; settle private conversation backing and action authority. Research is supporting evidence; earlier research report remains unrecovered and is not substituted for the full canonical source.
- [x] Persist per-user default-OFF preference, generation fencing and operational kill switch; gate API/runtime/navigation/direct route.
- [x] Durable turn acceptance, concurrency, retry/recovery/cancel and recent history with pagination; preserve old history.
- [x] Mastra Agent adapter through existing gateway/accounting; bounded context; no repository tools or subagents.
- [x] Shared operations adapter with durable receipts, explicit destructive-action confirmation, stable dispatch identity and uncertain-effect reconciliation.
- [x] Authorized event subscription/inbox integration for own dispatched work, dedup/replay and noninterrupting presentation.
- [x] Live mobile/desktop chat, task/result/attention cards, source links and settings opt-in; retain voice input.
- [ ] Unit/integration/security/Worker regression tests for enable/refresh/disable, stale tabs/in-flight, isolation, duplicate dispatch, interrupted/repeated flows, cancellation and reconnect.
- [x] Documentation/capability matrix and rollback; visual audit mobile/desktop.
- [ ] Draft PR, independent Astra High specialist/security/completion review; final-head lint/typecheck/test/build/CI.
- [ ] Coordinate staging ownership, dedicated test identities, full live staging E2E and cleanup.
- [ ] Rebase latest main and retest; CodeRabbit request/wait; merge, exact-commit production deployment and minimal smoke.

## Acceptance

All checklist items verified with concrete evidence. Disabled users cannot activate or read SAM via direct links/API/event/runtime. Disable fences further effects without silently cancelling project tasks or deleting history. No cross-user/project disclosure; no private global memory copied into project records. Repeated accepted intent does not duplicate work; uncertain external effects stay visible until reconciled. Events do not interrupt human conversation. No skipped checks represented as passing.

## Current evidence and remaining gates

- Implementation is present; release remains incomplete. All new accounts and existing accounts default OFF. No real users enabled, secrets created, grants added, deployment or merge performed.
- Broad local baseline: `pnpm test`21 successful workspace tasks; API907 files/12869 tests passed,1file/2tests skipped (excluded from pass counts). `pnpm typecheck`19/19, `pnpm build`9/9 and `pnpm check:fast` passed.
- Actual bundled Mastra/native workerd19/19 passed, including both provider adapters, accounting and real tool roundtrips with outbound HTTP model fixtures. The Workers-incompatible AJV code generation was replaced with a StandardSchema/Valibot bridge, without unsafe eval.
- Local mocked mobile/desktop browser audit26 cases passed, plus6 final security/UI regressions. These are not live model or staging evidence.
- Final control-loop correction: bounded25-watch scan/view, persisted pre-await progress/deadline, retry limit and exhaustion state. Its final tests/review are pending; earlier broad passes do not prove this newest correction.
- [ ] Bounded initial-model behavioral evaluation: ambiguous project scope, code-question dispatch, selected profile and exact constraints, malicious report/history handling, private-context canaries, retrieval of older constraints, evidence-backed completion claims. Record actual operation inputs/results and sample sizes; no unearned quality percentage.
- Final-head quality checks, draft PR/CI/review, dedicated-identity staging including bounded VM lifecycle, and production exact-commit verification remain pending.

## Live verification blocker

Existing `SAM_PLAYWRIGHT_PRIMARY_USER` is present but staging `POST https://api.sammy.party/api/auth/token-login` rejects it with HTTP401 `Invalid token format`. User asked to refresh existing smoke credentials through the environment. No new secrets/grants created; no accounts enabled; no deployments. Live model behavior, dispatch/VM lifecycle, staging checks and production release remain unverified.
