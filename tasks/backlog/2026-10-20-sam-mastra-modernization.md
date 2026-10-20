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
- [x] Unit/integration/security/Worker regression tests for enable/refresh/disable, stale tabs/in-flight, isolation, duplicate dispatch, interrupted/repeated flows, cancellation and reconnect.
- [x] Documentation/capability matrix and rollback; visual audit mobile/desktop.
- [ ] Draft PR, independent Astra High specialist/security/completion review; final-head lint/typecheck/test/build/CI.
- [ ] Coordinate staging ownership, dedicated test identities, full live staging E2E and cleanup.
- [ ] Rebase latest main and retest; CodeRabbit request/wait; merge, exact-commit production deployment and minimal smoke.

## Acceptance

All checklist items verified with concrete evidence. Disabled users cannot activate or read SAM via direct links/API/event/runtime. Disable fences further effects without silently cancelling project tasks or deleting history. No cross-user/project disclosure; no private global memory copied into project records. Repeated accepted intent does not duplicate work; uncertain external effects stay visible until reconciled. Events do not interrupt human conversation. No skipped checks represented as passing.

## Current evidence and remaining gates

PR: https://github.com/raphaeltm/simple-agent-manager/pull/2386 (draft). Latest main integration base: `14aee2827` (PR2387), including PR2383. Rebase preserved both session-writer authorization and canonical source metadata; only their imports conflicted. Recheck main before release.

The full canonical source is recovered (63,451 characters/552 lines). Launch implementation covers private history/retrieval, one Mastra operator, direct visible project tasks for every code/file question, shared operations/receipts, reports/follow-up/controlled stop, scoped quiet updates, voice/mobile UI and default-OFF settings/API/runtime gating. Full settings/connections/compute/automation/deployment parity, internal Mastra subagents and standing autonomy are later canonical roadmap work. The broader idea is not complete merely because launch ships.

Local baseline passed:21 test workspace tasks, API907 files/12,869 tests (one file/two tests skipped and excluded); typecheck19 tasks; build9 tasks; `pnpm check:fast`. Corrective coverage includes34 work/settings/security cases,62 deploy-config cases,22 real bundled Mastra/workerd cases,28 mocked browser cases and12 reviewed final56px-control screenshots. Current-tree and PR-range secret scans pass without new exceptions. Final-head checks remain required after every source change.

Independent Astra High architecture/Cloudflare/constitution, security, UI/doc-sync and implementation-completeness reviews completed. Response-grounding adversarial and implementation/doc-sync reviews passed; final combined-main integration review remains required. [Posted mobile/desktop screenshots](https://github.com/raphaeltm/simple-agent-manager/pull/2386#issuecomment-6288048540) use mock data; private live screenshots were reviewed but not published.

Exact-head CI39421502911/smoke39421503032 passed on1175dd46289ccf29c9d8e1538d4307524acf178d. CI39425199219/smoke39425199230 passed on2259c9744bc46b41743a1d3de3942cb9f8402e7b. These are historical passes, not substitutes for final-head checks. Cloud-init test correction split12 shell cases into separately timed tests without weakening assertions/default timeouts. A later scan flagged a nonsecret admission UUID in a public artifact; the unnecessary public field was removed and the latest own commit amended so both scan modes pass. Original private evidence remains unchanged.

## Live staging evidence and preserved failures

Staging deployment39415663780 passed on runtime109d21080b567f55879840e3530c9a1b9a57cc84. CF deployment0961cd65-ae22-4bb5-b2dc-2f4de4c1b7ee/version7f3e39a7-66f8-42b8-a4a4-6b8438a49cb5 served100%; a new runtime correction below requires redeployment.

Passed live on109d:

- Default-OFF settings/API/direct route/navigation; enable and persisted refresh; durable chat/reconnect; same-key replay and changed-payload conflict; cancellation; user isolation; stale-tab disable. Existing dashboard/projects/settings usable. Both dedicated accounts returned OFF. Zero page errors and one unattributed console-error count; do not claim zero console errors.
- Browser microphone/MediaRecorder through real transcription to a reviewable unsent draft, no chat/action mutation, zero page/console errors.
- Private memory retrieval of an unpredictable constraint excluded from the recent50 rows (52-row distance); preserved constraints/no unrelated canary disclosure. Observed active turn→disable→cancelled after re-enable with no resumed effects. Original failed blank-answer ledger preserved.
- Six bounded model read/planning scenarios with source/pagination verification. Seven uncached gateway requests,39,729 input/1,653 output tokens, reported USD0.00419359965133667. This is bounded behavioral evidence, not a general accuracy claim.
- First actual Astra High VM run: one dispatch/task/session, exact persisted profile/model/effort and heartbeat, initial repository report, same-key replay/reconciliation retaining identities, consumed/answered project follow-up. Private follow-up turn interrupted after completed read/send receipts; full journey failed and its ledger remains unchanged.
- Separate read-only recovery completed with exactly one sam_chat_read, no send/start, and unchanged original receipts/ledger. Original task/session stopped, workspace/node/profile absent, SAM OFF.

Preserved failed runs:

1. Original793905ee-a90a-40b9-9a76-ca5229eb5ab7: interrupted private follow-up, subsequently reconciled/read-only recovered; not reclassified as completed.
2. Freshc4edab9c-90a1-4939-bdd4-dc523389a27b: initial-report cutoff; all six owned cleanup steps confirmed. Complete33-row transcript read ruled out pagination truncation for this failure.
3. Focused controlled-stop472b6902-64cd-4b03-b964-c6039f33cfee: model completed without actions yet claimed dispatch and fabricated task/session references. D1 independently proved no task for the exact temporary profile; inventories proved no new workspace/node. Temporary profile removed and SAM OFF. No VM/stop occurred. This exposed the current launch-blocking defect.

Safe public evidence lives under `tasks/evidence/2026-10-20-sam-modernization/`: `final-staging-checkpoint.json`, `live-behavior-evidence.json`, `followup-recovery-evidence.json`, and `ungrounded-response-evidence.json`. Raw transcripts, synthetic private canaries and authenticated screenshots remain private. Earlier checkpoint files describe their recorded time, not current completion.

## Initial publication-guard checkpoint (historical)

The response publication guard validates platform references against typed successful CURRENT-turn operation metadata; raw reports, action inputs and historical prose cannot ground them. Conservative unsupported mutation-claim checks distinguish matching completed writes from reads, pending approvals and uncertain actions. Rejection must interrupt before publishing assistant prose, preserve usage/receipts and avoid inference/effect replay on the same key. Native38/38 and focused81/81 tests passed, including ordinary planning, unrelated UUIDs, typed identity substitution and failed/pending receipt handling. All three incident regression cases fail against the old runtime. API typecheck and scoped lint/format passed; independent adversarial security review PASS. This is not a universal semantic truth verifier.

Remaining at that checkpoint: coordinate and deploy corrected staging runtime; recheck affected live behavior and prove controlled stop approval/confirmation on an awake runtime with duplicate-confirm idempotency and teardown. Then current-main integration, exact-head CI, completion/security reviews, CodeRabbit request/wait, merge, successful main CI/production deployment and minimal exact-commit health/version smoke. No production release or completion claimed.

Latest explicit user direction authorizes bounded fresh staging under the existing pool. Earlier agent-invented physical host/$1 ceilings and approval holds were superseded; small workload requests remain appropriate. Each active test is bounded to one VM,12minutes work plus3minutes cleanup, with zero owned VMs at rest. These are time/turn bounds, not a guaranteed combined monetary ceiling. No pool changes, new services/secrets/grants or real-user enablement. Remaining blockers are live verification and final release checks, not missing authorization.

## Integrated-candidate checkpoint

Staging39430478002 passed on11b80ecab29236c1f10209beeaca6c5e5807f343; Cloudflare deployment23530c92-41a2-4fee-ae24-8481d9f36c97/version6312f543-064e-43e9-a483-193cad9871c7 served100%. E2E39430449677 passed. CI39430449679 failed because the new native test was accidentally collected inside the standard Cloudflare pool and crashed workerd; it is not a passing run. Corrected routing excludes both native-only suites from the standard pool while the mandatory wrapper still executes both. Actual discovery found148 standard files and2 native suites; wrapper verification passed13 standard plus38 native tests, without removing assertions or coverage.

The11b live browser run passed opt-in, persistence, durable chat/reconnect/replay, cancellation, user isolation and stale-tab disable, then failed the final settings navigation with the shared session-verification spinner still visible after20seconds. It remains a failed full journey. Dashboard/projects immediately beforehand passed; both test users returnedOFF, no VM was created. Earlier navigation diagnostics do not establish the final auth failure cause. Added equivalent final-route diagnostics without longer budgets or relaxed assertions.

Main PR2387 landed during validation. Rebased onto it, preserving authorization/source metadata and running52 focused tests plusAPI typecheck. Final integrated staging and remaining recovery/awake-stop gates are pending. Sonar Quality Gate passed with63OPEN CODE_SMELL findings (7CRITICAL/S3776 withMAINTAINABILITY/HIGH impact,30MAJOR26MINOR). Independent security triage found no concrete security/correctness blocker; raw grades remain unchanged, no waiver/resolution claimed. Follow-up idea01M5CRNJAHDKYTEHFG2G8DD8T1 tracks the refactoring debt.

## Integrated live checkpoint and bounded correction

Candidate f8c4ae0706a1f0f0980acba169974a9f3278295b passed CI39434284707, E2E39434284731 and staging39434288667. Cloudflare deployment9e063a64-6294-4b8e-ac77-83e771f4b97c/versionc373d434-8668-4837-87dd-881b61dd9296 served the exact commit100%. Integrated authorization/transcript tests passed109/109.

The full browser journey passed on this candidate, including final dashboard/projects/settings. Both dedicated users returnedOFF; zero page errors and one unattributed console-error count remain disclosed. Original-follow-up recovery passed again: original interrupted state and completed receipts unchanged, same-key replay did not execute again, and one new read-only turn completed without sending or starting work.

The fresh awake-stop runfc811848-0046-41ba-8394-3733b7e46bb8 failed before dispatch: the model again fabricated a started task with zero tool calls. This time the publication guard interrupted and withheld the unsupported answer. Independent D1/inventory reconciliation proved no task/workspace/node was created, the owned temporary profile was removed, and SAM returnedOFF. Its original failed ledger remains unchanged. No controlled-stop success is claimed.

Two bounded behavior runs exposed test predicate errors: a page-scoped count was rejected, then a passive prohibition (“must not be merged”) was rejected. Original failed Playwright records remain failed. Narrow predicates now have31 passing unit cases. A separate post-run review verified all six completed scenarios, one read receipt, no writes and opt-out cleanup; this is not a reclassified Playwright pass or general model-accuracy claim.

The next correction permits one additional generation within the same active invocation only after a typed grounding rejection with zero execute-entry attempts, zero observed model tool calls and zero receipts. It preserves canonical history, original authority and the same step/deadline/usage bounds. Its first step requires a tool; rejected draft text is not reused. Blank/provider/auth failures, attempted tools, receipts, exhausted bounds and saved interrupted-turn replay cannot enter this path. Native regression/adversarial validation and independent security review must pass before deploying it. The real awake dispatch/confirmed-stop/repeated-confirm/cleanup gate remains required, followed by final-head checks, review, merge and production smoke.

Correction verification: native56/56, independent security/grounding60/60, API typecheck, scoped ESLint, formatting and diff checks passed. The successful corrective case fails on the prior runtime, then passes with a real read receipt, unchanged canonical history, usage accounting and same-key no-inference replay. Mastra1.77 has an existing separate stream-error retry processor; a passive error observer prevents a recovered provider failure from qualifying for correction. Native recovered503 cases with step budgets1/20 performed1/2 automatic calls and no correction; provider400 and short-deadline503 were fenced. Independent final security and doc-sync reviews passed. Current-tree Gitleaks reported49 reviewed findings and0new; no exception added. Live corrected-model stop validation remains required.
