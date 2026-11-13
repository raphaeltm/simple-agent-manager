# Owner force-resume of saved provider-limited sessions

## Problem

Raphaël reports externally resetting his selected Claude account and cannot find the previous force control to deliver his latest message in the existing sleeping session. SAM still records the earlier rejection. The callback-origin waiting hold has neither admission-only Start anyway nor blocked-only Resume task. Canonical idea: 01M73WJGGD2TZP6XDFHJJWHD33, note 01M77SJS07XVH3MD6NVWCQNNNB.

## Research

- `provider-limit-recovery.ts`: existing admission override is credential scoped; keep admission/blocked semantics and add saved waiting eligibility separately.
- `session-recovery.ts`: existing waking claims must remain intact; nudge their stable TaskRunner. Unclaimed snapshots use normal recovery, preserving bounded attempts and snapshot degradation.
- `provider-limit-admission.ts`: released override bypasses live rejected window; must bind profile/current credential and deadline, preserve changed-account review.
- `project-event-schedules-delivery.ts`: scheduled callback continuation validates scheduleKey before submit; changing the key invalidates obsolete pending notices. Reconcile must still inspect already-issued receipts.
- Existing restored-session prompt machinery retains original accepted inbox messages. Do not repost/fork/replay.
- Sol owns shared catalog/placement and committed-active/readiness fixes. Coordinate imports and staging, do not duplicate. The recovery scan now needs additive ordered partial index0238; applied main0237_archive_reclaim_pending stays unchanged; Sol reserved unapplied0239 for catalog.

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


## Third incremental review

Binding review5879307801 on43e raised six valid follow-ups. Corrections preserve newly installed consent across same-attempt state writes, reject superseded credential responses without revoking valid consent, repair positively absent runners through normal start using the same claim, anchor source authority to the original source agent and its own workspace across new checkpoint publication, propagate the approved non-null skill, and cover every nudge rejection independently. The owner action retains accepted intent for positively absent or stale runners and ambiguous presence reads.

Native regressions reproduced concurrent generation revocation, stale-state approval loss, missing runner repair, checkpoint source self-revocation and stale-input authority bypass before correction. The consolidated20-file matrix passed560 cases, plus API typecheck and changed-file lint. Real Workers reproduced both non-null skill rejection and checkpoint self-revocation through actual credential and snapshot HTTP endpoints. The two review test improvements assert the returned account/profile and advance both application and SQLite clocks in successful expired refresh.

Read-only peer review additionally caught missing in-memory hydration after authority validation; two cases failed first, then all17 runner-consent cases passed after correction. The first final Workers run was stopped during setup (exit143; no passing-case claim) to apply that correction. A stale DO attempt versus current D1 claim acknowledgement race is being fenced with authoritative claim checks and repair. Final consolidated validation and a new full source SHA remain pending. No integration refresh, deployment, resource provisioning or production mutation was performed.


Final corrective validation is settled: all39 real Workers cases across four files passed on the frozen source (exit0,353.40s; full-restore13 plus scheduled/authority/binding controls). This includes real non-null skill creation, checkpoint preparation/completion between restore and final authority, missing and stale runner repair using the same current claim, marker progress/ACK/timeout, first-release expiry/membership denial, and original delivery once. Native560/20 passed before the final small refinements; all134 affected owner/intent/runner/state cases then passed on the final refinements. Final API typecheck, changed-file lint and diff check passed. Read-only peer audit found no unresolved blocker. A post-nudge claim-advance regression failed before the atomic expected-attempt ACK fence and passes after it. Fresh source CI/review, independent coordinator approval and final combined staging remain pending.

## Current-main package port (2026-11-13)

Coordinator authorized one code-only refresh onto main527f16b9580ad7cd762c60ea7e711175dd843ada on this existing task. Earlier6367435 source reviews/CI and db0ef integration proof are historical. Pure provider wait schema and consent fields move with the existing scheduler-core public entry; D1 scan index declaration moves to worker-core schema; ProjectData schedule delivery keeps receipt-only no-wake reconciliation behind the existing package ports. Worker recovery/credential SQL and claim, lease, task, runner, acknowledgement and source checkpoint fences remain worker-owned. Migration ownership confirmed with sole catalog owner: preserve applied archive0237 byte-identical, retain unapplied force index0238, reserve unapplied catalog0239.

Port verification: all11 dependency builds, API typecheck, API/package lint and type-boundary/migration-safety/migration-ordering/node-pool-boundary checks pass. Focused native323/10files (including real clean/upgrade0237→0238 SQLite migration tests), pure wait policy9, UI12 and real Workers26/4files pass. Local security/Cloudflare/package port reviews pass; final immutable CI and a new CodeRabbit wait remain required. PR remains draft and needs-human-review solely for the physical staging cleanup hold. No deployment, provision, cleanup retry or combined integration refresh is authorized before coordinator reviews the new full head.

## Incremental review5896397868 corrections

The new ae35 review returned seven binding findings. Runtime credential-pin rows/generations now validate before authority use and return sanitized conflicts; a blocking CAS matches captured status/start/admission plus the original nonterminal allowlist. A raced waking result requires positive runner confirmation and an exact observed attempt before ACK. Sleeping tasks interrupted after claim publication repair through normal reactivation on the same claim; that repair atomically matches the captured sleeping status/workspace, preserving a competing materialized winner.

Pending recovery checks the shared absolute compute ceiling before repair. An exact materialized/restored attempt retains bounded consent during the commit gap even after the session wakes, without ACK or new work. Its status lookup uses the existing RPC budget; timeout/transport ambiguity defers safely. Tests use controlled application and SQLite clocks for late expiry. New discriminator tests reproduced the prior failures, including a reactivation race found by local cross-review.

Consolidated native442/14files pass, including75 credential-pin,61 owner-intent and5 claim-interruption tests. Real Workers26/4files and the two previously failing archive cases pass; archive changes only make clock/budget charges occur at actual R2 writes, retaining lease/yield/transcript assertions. Fresh API types/lint and immutable CI/review evidence remain tracked in PR. The current-main push's existing automatic installer workflow crossed the code-only staging hold; effects and temporary Worker deletion are disclosed in PR. Coordinator permits future pushes only after complete old-remote→new-head paths match no deploy-capable push filters; no workflow changes or staging actions are part of these corrections.

## Release-gate update: physical capacity cleared (2026-11-13 19:15UTC)

Coordinator independently read primary human message01M7B4VSNPB751FSAT9K20825E reporting manual deletion of three staging nodes and authorizing continuation; Shepherd reported19:10:25 matching D1 node/workspace absence and zero GCP inventory. The prior physical-capacity blocker is historical. Leakage prevention has another owner; no duplicate implementation or human cleanup question.

Dependency task01M758A6F8BHWA5VHBB6N6KDYW/PR2658 owns the first exclusive bounded staging window. Our one2691+2693 combined window follows only after actual cleanup/window release, dependency source/Go-runtime merge and incorporation, corrected-head independent review and CI/review resolution. Keep draft/coordinator marker for those remaining gates. No intermediate integration refresh, concurrent staging deployment or installer smoke as feature proof. This gate update is preserved with the next source correction; the current immutable candidate and its approval state are recorded in the PR.

## Coordinator materialization-race correction

Independent coordinator review blocked8e on same-attempt restoration during the profile lookup after the initial materialization check. The stale revocation UPDATE could clear consent despite valid recovery progress. Revocation now atomically matches task status/workspace and canonical snapshot progress captured before the asynchronous checks. It reuses the same SQLite progress expression for capture and CAS, including attempt, workspace, restore/sleep state and snapshot generation while excluding lease-only timestamps. It adds no runner, claim, ACK or authorization path; stable invalid authority still blocks on the next sweep.

New real-harness regressions gate the actual profile SELECT and blocking UPDATE. They fail on8e from lost owner consent and pass with the atomic fence; a foreign-attempt control verifies one-sweep deferral followed by stable revocation. The coordinator's separate source probe remains supporting evidence, not application or staging proof. Fresh immutable validation and independent review are required again; all staging/dependency sequencing gates remain.

Final correction validation: consolidated native447/15files PASS; owner-intent61 plus new progress5 PASS; API typecheck, scoped lint and diff check PASS. Snapshot-only guard ablation fails while task CAS stays intact, proving the snapshot comparison independently. Final immutable CI and coordinator review remain pending.

## Connector-main compatibility refresh

New main d65360dcd (#2710) relocated the current credential-selection helper. CI synthetic merge of0821 exposed TS2305 in two feature imports. Incorporate that shipped main without conflicts, target agent-credential-selection from force-resume/reconciliation and update the harness mock. Security review confirms identical profile/credential precedence, inactive-pin halt and platform exclusion; the shared legacy picker now avoids unnecessary secret decryption. No authorization or recovery behavior changes. API dependency build and focused145/6tests pass; fresh final-head CI/review still required. Dependency2658 owns the active exclusive staging trial; a ready credential-teardown fix may take next priority, so our combined window requires explicit FREE and readiness rather than an empty reservation.
