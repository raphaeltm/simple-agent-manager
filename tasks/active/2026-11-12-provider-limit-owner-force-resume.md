# Owner force-resume of saved provider-limited sessions

## Problem

Raphaël reports externally resetting his selected Claude account and cannot find the previous force control to deliver his latest message in the existing sleeping session. SAM still records the earlier rejection. The callback-origin waiting hold has neither admission-only Start anyway nor blocked-only Resume task. Canonical idea: 01M73WJGGD2TZP6XDFHJJWHD33, note 01M77SJS07XVH3MD6NVWCQNNNB.

## Research

- `provider-limit-recovery.ts`: existing admission override is credential scoped; keep admission/blocked semantics and add saved waiting eligibility separately.
- `session-recovery.ts`: existing waking claims must remain intact; nudge their stable TaskRunner. Unclaimed snapshots use normal recovery, preserving bounded attempts and snapshot degradation.
- `provider-limit-admission.ts`: released override bypasses live rejected window; must bind profile/current credential and deadline, preserve changed-account review.
- `project-event-schedules-delivery.ts`: scheduled callback continuation validates scheduleKey before submit; changing the key invalidates obsolete pending notices. Reconcile must still inspect already-issued receipts.
- Existing restored-session prompt machinery retains original accepted inbox messages. Do not repost/fork/replay.
- Sol owns shared catalog/placement and committed-active/readiness fixes. Coordinate imports and staging, do not duplicate. The recovery scan now needs additive ordered partial index0238; 0237 is reserved by Sol.

## Implementation checklist

- [x] Add one owner operation for waiting callback parked sessions using existing override/recovery mechanisms.
- [x] Fence task/wait, snapshot/claim, credential/profile and deadline; retain claim across ambiguous runner response.
- [x] Keep original inbox/delivery identities and reconcile already-issued receipts; invalidate obsolete scheduled continuation.
- [x] Add thin HTTP adapter and owner-only session notice action with pending/error state.
- [x] Exercise public action in Workers through live rejected windows, claimed/unclaimed recovery and original delivery once.
- [x] Cover double click, non-owner/access revocation, expired/degraded snapshot, cancellation, mutation/races and fresh rejection.
- [x] Run API/UI lint/typecheck and desktop/mobile screenshot audit (full repository tests/build still pending).
- [x] Update API/user docs; specialist reviews and implementation completion review (release gates remain pending).
- [ ] Coordinate bounded real staging validation and cleanup.
- [ ] Draft PR, CI, CodeRabbit, full-head evidence to coordinator.

## Acceptance criteria

Owner can request Resume anyway on an eligible callback waiting saved session before reset. Existing task/snapshot/profile/account and original accepted delivery remain authoritative. Claimed recovery advances without claim replacement. Unclaimed recovery uses normal restoration. A changed account/profile cannot inherit consent; terminal/expired/cancelled work cannot advance. An actual rejection re-parks and clears override; repeated clicks do not duplicate work. UI is usable on mobile/desktop. Tests, review and real staging evidence precede release.

## Release gate

Keep PR draft until coordinator 01M77NV1B621TKTV79272F7YX3 independently approves full 40-character head. Every new commit invalidates approval. No production DB bypass, reset or replay. Automatic overage parsing remains separate in canonical idea.

## Local validation and review

Repository lint/typecheck34/34 passed. Focused API191 passed; latest owner51 passed. Real Workers restore5 passed with claimed/unclaimed owner recovery, original delivery once and fresh rejection. UI12 passed; browser375/1280 normal/admission/blocked actions14 passed; refined6 and320/light6 passed; final12 screenshot recapture passed. Eight mobile/desktop normal/pending/error/reader images are in the SAM Library under `/design/provider-limit-force-resume/` and were independently reviewed. Security/Cloudflare, test engineer, UI/docs and implementation completion/constitution reviewers completed; all implementation findings addressed. Full repository build/native tests and merged integration checks remain running.

The integration-only branch merges this output with Sol6511b14d. Its owner fixture now supplies an explicit API-origin catalog offering through the existing resolver, while exercising real pool publication, owner selection and placement. The previous dummy cloud credential depended on a static-catalog fallback that Sol's stronger completeness checks correctly reject. No production behavior was changed for this fixture adaptation.

## Staging coordination

The coordinator assigned bounded cleanup of two old empty staging GCP test nodes after confirming their provider identities. Both ordinary authenticated DELETE requests returned409 because runtime termination could not be confirmed. Read-only D1 reports provenance quarantine and no termination proof; logs redact the underlying error, so a precise credential mismatch is unproven. Coordinator is arranging human cleanup. No new VM, staging deployment, production mutation or replay has been performed by this task. One disposable2vCPU/4GB VM is planned for sequential combined catalog/recovery and owner-force validation after the shared resource ceiling clears.

## Import-boundary regression caught by broad validation

The broad native API run found that importing the resolver through `routes/credentials` registered unrelated credential routes while chat was loading, breaking the existing narrow schema mock in `chat-prompt-cancel`. The owner service now imports the identical resolver from its backing `agent-key-resolution` service. The existing failing chat suite and owner-action suite pass100 tests together; security review confirms a plain re-export replacement with no behavioral change. Current-head CI remains the authoritative complete-suite gate; earlier mixed-head and stopped local runs are not full passing evidence.

## Complete native CI and callback identity fixture

Exact-head CI at `0e2353ac166a772a6bd55778e99faaf53e39c0ce` completed the web suite (405 files, 5146 tests passed) and native API suite (1091 files/16238 tests passed; only eight failures in `runtime-always-proxy`). The proxy mock omitted required `callbackGeneration`, while both real workspace readers return a string or null and its SQLite fixture returns null. Added that explicit null without weakening strict production identity equality. Real injection controls now cover matching null and unchanged nonnull generations, plus generation replacement and owner mutation at the final pin read, all withholding the secret when authority changes. Proxy, credential fallback and injection suites pass46 tests together on the corrected source; changed-file lint passes. The redundant local broad run was stopped only after complete immutable CI supplied the full failure list. Fresh candidate CI and staging remain required.

## CodeRabbit review corrections

Trusted workflow43246506629 requested review once at15:19UTC. Binding review5877255335 on83d088f2f requested five changes; all are implemented in the next candidate and await final validation/CI:

- Validate snapshot authority rows with Valibot before credential selection or recovery.
- Resolve explicit profile names through the same scoped `resolveAgentProfile` used by dispatch, store its canonical ID while CAS-matching the original raw hint, and use the same canonical identity in secret injection. The display helper suggested by the review maps IDs to names and is unsuitable.
- Commit a recovery-pending intent with the exact approval. The existing bounded stuck-task cursor includes only specifically pending sleeping tasks; repair reuses the same approval/task/snapshot/claim and normal recovery, rechecks current D1 authority after external awaits, and leaves transient/ambiguous failures retryable. Cancellation, expiry, ownership/member/profile/source mutations cannot dispatch stale work.
- Bound approval expiry before run start, while allowing credential refresh for the same committed `in_progress` run with `started_at >= grantedAt`; all credential/profile/skill/type/workspace fences remain.
- Keep capability and receipt reads from waking containers or triggering timeout recovery, including steering and ambiguous-submit receipt paths. Normal prompt submission retains its wake behavior.

Final security review also tightened exact agent-session skill matching before attribution and immediately before secret release. Runtime persistence rows are mapped and checked so the internal agent-session ID reaches all five final checks without changing response JSON. The new post-attribution regression first failed and exposed the previous ID-shape mismatch, then passed after correction. Targeted latest injection/recovery/proxy/fallback79 passed; earlier consolidated348 native and no-wake100 passed. Final complete native/Workers/type/lint checks and fresh CI are pending for the consolidated candidate. No staging resources or production mutations were performed; the existing physical-cleanup/draft/exact-head gates remain.

## Sonar quality remediation

Sonar rejected candidatebb85 for16.3% new-code duplication (limit3%). Actual duplicate blocks were the two owner test harnesses, repeated credential injection assertions, and three identical direct credential responses. The shared real-SQLite harness preserves real schema/migrations/authority and all377 native cases; runtime responses now use one attribution-and-final-injection helper. Private eligibility/authority/dispatch helpers reduce complexity without sharing or weakening independent SQL fences. No analysis exclusions were added. Read-only security review found no regression in identity, profile, skill, sequential denial or awaited dispatch semantics.

Consolidated native validation passed305 cases in nine suites, then72 owner cases after restoring imports accidentally removed during harness extraction. API typecheck and changed-file lint passed. Real Workers passed26/2files (207.79s; exit0), with the same fake-peer DNS warnings as the prior green run. Final Sonar/CI evidence remains pending. The credential guard subsequently received a pure predicate extraction to keep both private functions under the complexity limit; its injection suite/type/lint recheck is recorded with the final candidate. The previous trusted incremental CodeRabbit request completed with an explicit rate-limit result; after the15-minute wait, no new binding finding or active review was present. A new source head still requires normal current-head review and validation.

## Second incremental review

Review5878280234 on7b3 requested four additional changes: active project membership at the final credential boundary, proof of a pre-expiry first authorization before allowing a committed run to refresh, current profile agent-type matching in repair, and a short configurable background recovery RPC budget. These corrections are consolidated locally and passed final focused Workers validation and are ready for the consolidated source commit. The credential suite reproduced six new failures before correction and now passes59 cases, including membership/profile/generation changes at the final CAS and a database clock crossing the approval deadline during that CAS.

First-release authorization lives in an optional scoped `firstInjection` marker; attribution alone cannot create it. A committed run must retain that marker's workspace, callback generation, agent session and credential lineage. The background path carries immutable owner consent through existing atomic claim/start/runner boundaries, permits only legitimate marker progress, and skips late acknowledgement after a sweep timeout. Stale refusal diagnostics, claim-lease renewal and runner state writes are included in the race review.

The prior combined candidate3bca067553969c1af8a83fe75c049ed3bdc929f4 passed307 native tests,112 Workers tests and API typecheck before these corrections. Source7b3 Sonar passed with0.0% new duplication. New consolidated validation, independent coordinator review and final integration remain required. No staging deployment, resource provisioning or production mutation was performed.


## Corrective validation and query plan

The four-finding correction passed484 native tests across18 files, API typecheck and changed-file lint. Reusing the existing `PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS` (shared default5000ms) then passed28 focused repair cases, typecheck, lint and runtime-tunable checks. No new environment setting, deployment prerequisite or admin control is added. Migration safety/ordering and agent-context budget checks passed.

Actual full CI on7b3 exposed an unordered recovery cursor after sleeping pending tasks were included. Migration0238 adds the exact active-or-sleeping-pending partial `(updated_at,id)` index while preserving the old index. Real SQLite query-plan and stuck-task regression suites pass64 cases, including keyset/wrap ordering and exclusion of unrelated sleeping tasks.

The first corrective Workers run passed31 cases and failed four in the full-restore fixture; the other three files passed. The fixture used a historical clock against SQLite's real deadline and an instance-owned spy inaccessible to Workers RPC. After rebasing only owner fixture time and moving the spy to the prototype, the isolated file passed seven and failed two new gate cases because a cross-DO promise leaked I/O context and the1ms timeout could settle before nudge entry. The final fixture uses test-context polling and captures rejection immediately. The last two cases additionally exposed an incorrect pending-state expectation: real placement legitimately writes `placed` before injection. They now assert that valid consent/marker and placed progress survive ACK/timeout without overwrite. Both affected cases pass (exit0,2 passed/7 skipped,84.86s); the other seven passed unchanged in the preceding run. Together with the other three passing Workers files, all35 relevant cases are covered across focused runs. Production guards were not weakened. These unsuccessful runs are not passing validation evidence.
