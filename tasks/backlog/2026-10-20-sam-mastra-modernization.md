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
- Coordinate PR2383 and operational-controls task01M5C4GJYJ1AA0AXK1J0DH60CC. Coordination message accepted, not yet read-confirmed. No staging claim.

## Implementation checklist
- [ ] Recover remaining research and current-source contracts; settle private conversation backing and action authority.
- [ ] Persist per-user default-OFF preference, generation fencing and operational kill switch; gate API/runtime/navigation/direct route.
- [ ] Durable turn acceptance, concurrency, retry/recovery/cancel and recent history with pagination; preserve old history.
- [ ] Mastra Agent adapter through existing gateway/accounting; bounded context; no repository tools or subagents.
- [ ] Shared operations adapter with durable receipts, explicit destructive-action confirmation, stable dispatch identity and uncertain-effect reconciliation.
- [ ] Authorized event subscription/inbox integration for own dispatched work, dedup/replay and noninterrupting presentation.
- [ ] Live mobile/desktop chat, task/result/attention cards, source links and settings opt-in; retain voice input.
- [ ] Unit/integration/security/Worker regression tests for enable/refresh/disable, stale tabs/in-flight, isolation, duplicate dispatch, interrupted/repeated flows, cancellation and reconnect.
- [ ] Documentation/capability matrix and rollback; visual audit mobile/desktop.
- [ ] Draft PR, independent Astra High specialist/security/completion review; final-head lint/typecheck/test/build/CI.
- [ ] Coordinate staging ownership, dedicated test identities, full live staging E2E and cleanup.
- [ ] Rebase latest main and retest; CodeRabbit request/wait; merge, exact-commit production deployment and minimal smoke.

## Acceptance
All checklist items verified with concrete evidence. Disabled users cannot activate or read SAM via direct links/API/event/runtime. Disable fences further effects without silently cancelling project tasks or deleting history. No cross-user/project disclosure; no private global memory copied into project records. Repeated accepted intent does not duplicate work; uncertain external effects stay visible until reconciled. Events do not interrupt human conversation. No skipped checks represented as passing.
