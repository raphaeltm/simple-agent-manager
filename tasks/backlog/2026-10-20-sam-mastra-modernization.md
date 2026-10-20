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

- Implementation is present; release remains incomplete. All new accounts and existing accounts default OFF. No real users enabled, secrets created, grants added, production deployment or merge performed.
- Broad local baseline: `pnpm test`21 successful workspace tasks; API907 files/12869 tests passed,1file/2tests skipped (excluded from pass counts). `pnpm typecheck`19/19, `pnpm build`9/9 and `pnpm check:fast` passed.
- Actual bundled Mastra/native workerd19/19 passed, including both provider adapters, accounting and real tool roundtrips with outbound HTTP model fixtures. The Workers-incompatible AJV code generation was replaced with a StandardSchema/Valibot bridge, without unsafe eval.
- Local mocked mobile/desktop browser audit26 cases passed, plus6 final security/UI regressions. These are not live model or staging evidence.
- Final control-loop correction: bounded25-watch scan/view, persisted pre-await progress/deadline, retry limit and exhaustion state. Final correction passed34 work/settings/security tests,19 native runtime tests,62 deployment config tests, API typecheck/scoped lint/context budget. Architecture/constitution/Cloudflare reviewer PASS.
- [ ] Bounded initial-model behavioral evaluation: ambiguous project scope, code-question dispatch, selected profile and exact constraints, malicious report/history handling, private-context canaries, retrieval of older constraints, evidence-backed completion claims. Record actual operation inputs/results and sample sizes; no unearned quality percentage.
- Final-head quality checks, draft PR/CI/review, dedicated-identity staging including bounded VM lifecycle, and production exact-commit verification remain pending.

## Live verification authentication correction

The earlier HTTP401 came from sending a managed-secret placeholder through an ordinary shell. The existing primary credential succeeds with HTTP200 through native `exec_with_secrets`; no user credential refresh or new secret/grant is required. Staging deployment run39403971268 succeeded on b3d99023d2b4b323deaa28eb15d660f09eca1ce3. Live model behavior, dispatch/VM lifecycle and production release remain unverified.

## Delivery checkpoint

Draft PR: https://github.com/raphaeltm/simple-agent-manager/pull/2386. Implementation commit: `4727aeb5e367d70909a146ec87ec62cc3ee01c2a`. Screenshot evidence comment: https://github.com/raphaeltm/simple-agent-manager/pull/2386#issuecomment-6288048540. CI corrections under validation; staging deployment succeeded. Task and release remain incomplete.

CI corrections: admin registry only (no new Env controls or deployment diff), explicit invalid-receipt409, SQL predicates without interpolation, submission wrapper split with narrow writer inventory location updated. Local quality/security/native checks pass; see verification evidence. Existing synthetic fixture positions restored; current-tree secret scan passes with zero new findings. PR remains draft; authentication is verified and live staging checks are pending.

## Live verification checkpoint

Staging run [39403971268](https://github.com/raphaeltm/simple-agent-manager/actions/runs/39403971268) succeeded on `b3d99023d2b4b323deaa28eb15d660f09eca1ce3`. Cloudflare API deployment `3d844005-fd50-4948-beda-dcf0fc172f5b`, Worker version `7ac00d91-ea0f-4e08-885a-d40680da86b0`, serves that commit at100%. Subsequent changes are test/evidence only. Dedicated-account live browser verification has started; no completed live journey is claimed yet.

CI found source-inspection tests still targeting the extracted submission wrapper and signup tests expecting pre-opt-in behavior. Corrected source paths preserve every assertion;389 tests across11 suites passed. Updated real-Worker signup tests cover default-OFF behavior and approval enforcement on all new endpoints;46 tests passed. API typecheck and scoped lint passed. Final-head CI still must pass.

## 2026-10-20 final-candidate corrections

CI [39411694385](https://github.com/raphaeltm/simple-agent-manager/actions/runs/39411694385) passed on `d75f052844f3be139ec2d40f47413b069140755b`. Staging [39408844036](https://github.com/raphaeltm/simple-agent-manager/actions/runs/39408844036) passed on `f11f10700938a1b74005aac93dbd15089250590a`. New corrections below require another final-head CI/deployment.

Six bounded live read/planning scenarios passed with independently checked project links/pagination and gateway correlation: seven uncached successful requests, 39,729 input/1,653 output tokens, reported USD0.00419359965133667. Public evidence contains hashes and receipt metadata, not private response excerpts. This is not dispatch, long-context retrieval, or overall launch verification.

Long-context staging exposed a successful HTTP200 model response with empty content. The runtime now marks empty/whitespace answers interrupted while preserving receipts/accounting; same-key replay does not run inference again. Three new native regression cases fail before the fix and pass afterward; all22 native tests pass. Independent architecture/security review passed. The live long-context case remains incomplete and its failed-run ledger is preserved.

All SAM primary controls now use56px targets. The final local mock audit passed28/28 on desktop/mobile/320px with12 reviewed screenshots under `primary-cta-56px/`. Scoped lint and API/web typechecks passed. Main live browser diagnostics now persist safe timings and bound navigation/screenshots; a complete live journey is still required.

VM dispatch is explicitly held pending coordinator/user approval details. Rule09 caps the workload request at2vCPU/3.5GB usable memory; no OOM or requirement for larger hardware was observed. Existing pool placement can select larger hosts and this SAM dispatch path cannot enforce a host ceiling. The conservative€0.10 VM allowance is not a combined VM/model maximum; a defensible combined cap is unestablished. No VM has been provisioned. Continue independent verification without treating this hold as approval, completion, or a waiver of live coverage.

Bounded main staging browser journey passed on `f11f10700938a1b74005aac93dbd15089250590a`: default-OFF settings/API/direct-route/navigation, enable and persisted refresh, durable chat/reconnect, request replay/conflict, cancellation, isolation, and stale-tab revocation. Both dedicated accounts were disabled in successful cleanup. Final corrected deployment still requires verification.
