# GitHub trigger compatibility and issue admission

## Problem
Issue #2320 was rejected because Review GitHub Issue required created rather than opened. Owner authorized live filter repair, full existing surface audit and deployment. Unify draft 01M4SRSG31V5SJNC8KCHP0KMH4; preserve unrelated configuration and blocked original coordinator.

## Research
- TriggerForm retains created on changing event and does not send githubConfig on edit; empty filters gain defaults.
- Hidden filters survive event switches; ignoreDrafts false is dropped.
- Admission counts skipped rows and resume has no reset boundary.
- Audit matrix: docs/audits/2026-10-13-github-trigger-compatibility.md.

## Checklist
- [x] Official-contract action catalog and API/MCP action validation.
- [x] Actual form defaults/reset/edit/preservation regressions.
- [x] Preserve false draft option; clarify PR source branches; case-sensitive branch matching and SHA context.
- [x] Resume reset boundary and failure window tests, REST/MCP parity.
- [x] Real signed webhook ingress/admission regression tests and scope audit fixes.
- [x] Lint/typecheck/test/build, mobile/desktop screenshots.
- [ ] Independent specialist/adversarial review and CI.
- [ ] T3-coordinated staging end-to-end, merge/deploy and production health/trigger verification.

## Acceptance
New issues use opened; event switches never submit hidden incompatible filters; edit preserves intentional empty filters. REST/MCP reject incompatible action names. No permissions/credential/security exception expansion. Explicit matrix distinguishes supported/tested gaps; normal release gates and verified production result required.

## Implementation and validation evidence

The form keeps its existing text action input. A dropdown/multiselect would add a new interaction; validation alone would leave the bad default in place. Event defaults plus server/client validation preserve multiple actions with the smallest UI change. Compatible labels/text/source branches survive event changes; unrelated actors/name/prompt/profile/concurrency are untouched.

- Scoped routing requires active GitHub project, valid numeric installation/repository IDs, canonical external installation association, and immutable repository ID with documented legacy-null fallback.
- Signed requests missing event/delivery headers return400 before admission/lifecycle mutation.
- Resume uses nullable auto_pause_reset_sequence set atomically from next_execution_sequence in REST/MCP. Skips do not mask failures; cancellation breaks a streak. All history remains.
- Real signed ingress tests cover all four supported events, Unicode/null-body/head_commit variants, draft inclusion, exact-body tampering, wrong installation/repo, renamed immutable repository, legacy association, case-sensitive branches, tag deletion and same-ID dedup. External task creation alone is mocked; signature/filter/scope/SQL admission/persistence run.
- Runtime migration0194 is applied to four existing raw-schema test fixtures. Historical147/151 migration fixtures remain unchanged.
- Signer18tests exercise fixed endpoints, real HMAC, AppJWT metadata and webhook-config allowlisting, canary secret/error redaction, step-local workflow secret isolation and strict cleanup ownership.
- Playwright4tests with eight screenshots cover create issues/PR/push and saved edit on mobile375x667/desktop1280x800,320px overflow and keyboard traversal. Screenshots reviewed: readable controls/help/footer, no overlap. Rubric hierarchy4/interaction4/mobile4/accessibility4/consistency4.
- Signed staging helper phases: local existing secondary principal prepare→trusted opt-in existing workflow send→local normal admission/cleanup verify. No persistent secondary secret exists or is introduced. Production sender is trusted main+normal exact-CI gate, existing production secret only at step scope, fixed configured API origin and bot actor preserving original trigger's ignore filter. Parent owns temporary production trigger/live verification.

### Quality gate records

Final stable full suite passed21/21 turbo tasks (/tmp/github-preservation-full-test.log): API12254passed plus2skipped; web4049passed. Final root lint13/13 and build9/9 passed (/tmp/github-preservation-root-lint.log, /tmp/github-preservation-build.log); web typecheck and focused preservation tests passed. Playwright4/4 passed with refreshed screenshots (/tmp/github-preservation-playwright.log). Format, migration safety, runtime-state and agent-context-budget checks passed.

Prior failing runs remain preserved: /tmp/github-test.log (form expectation), /tmp/github-test-final.log (raw migration fixture drift and stale header assertions), /tmp/github-frozen-test.log (five installation lifecycle fixtures missing delivery headers). Actual fixtures were repaired without weakening auth/lifecycle assertions; subsequent stable full runs passed.

Independent security/Cloudflare/env/implementation and UI/docs/constitution/REST audit reviews PASS on frozen35path SHA2560383bba8dbc79a32084397b42060999845ecdd5f50c179d140fb25cb179e7b4b. Bounded fixed GET /app/hook/config audit adds allowlisted JSON/TLS/exact-destination evidence;18 signer tests passed including query-canary mismatch rejection. Current-tree secret scan passed using checksum-verified CI-pinned Gitleaks8.30.1 (50 reviewed,0new), no baseline change. Commit equivalence and CI remain required; parent retains release coordination. Staging/production acceptance remains pending and this task must stay active.

### Release handoff

Reviewed runtime candidate committed/pushed as bf785e28c714a9d18912c05812e8e8bdcf7585a0; committed35path bytes equal the independent0383bba8dbc79a32084397b42060999845ecdd5f50c179d140fb25cb179e7b4b fingerprint. Parent confirmed staging run38381329627 checks out that SHA and its checkout completed. This documentation-only supplement does not change that runtime candidate. Normal CI, staging acceptance, review/merge/deploy and production verification remain pending under parent ownership.

Staging prepare found a harness response-contract error before any resource creation: project detail intentionally omits githubRepoId, while the helper assumed it. Helper now resolves one immutable positive repository ID from the supported OAuth repository response under the project's internal installation, with exact external installation association and active GitHub project checks retained.24 signer/fixture tests passed, including actual project detail shape and cross-installation/ambiguous/missing/invalid repository rejection; lint and current-tree secret scan passed. No runtime or authorization change. Staging acceptance remains pending.

A second staging prepare passed repository access but could not reach the form because its API-host login cookie was not shared with the app host. Harness now follows the existing smoke auth helper: extract the same server-signed BetterAuth session cookie, decode it and inject only into fixed .sammy.party browser memory with secure/HttpOnly/SameSite=None; errors never include headers/values.27 unit tests and a real browser cookie-host regression passed (API/app share; foreign host excluded). Browser mock cookie is generated ephemerally; final normal secret scan passed50reviewed/0new without baseline or matcher change. Earlier failed preflight logs preserved; no resource creation occurred during these failures.

Safe granular staging browser diagnostics showed form-open blocked while on the project route. Actual subsequent prepare positively observed the normal Account setup dialog; its supported Exit setup control dismissed it without creating credentials or changing project/profile/pool settings. Prepare then passed actual desktop/mobile form creation with opened and preservation assertions (/tmp/github-staging-prepare-normal-onboarding.log). Helper retains allowlisted diagnostic step/count outputs and suppresses diagnostic exceptions.27 tests, targeted lint and current-tree scan50reviewed/0new passed. Signed dispatch/admission, cleanup and production verification still remain pending; successful prepare intentionally retains only the temporary trigger for the next phase.

Signed staging run38385384520 proved live App JSON/TLS/destination/subscriptions/installation metadata and one execution for two identical delivery IDs. Initial120-second verification canceled before cold provisioning finished; readiness/version match arrived10:50UTC after about5.5minutes. Warm run38387008233 admitted/started once, but its implicit OpenCode session later failed with agent_prompt_failed before cleanup stop. Earlier helper momentary-running PASS is insufficient to claim successful agent completion. Existing supported secondary profile/credential metadata proves two Codex profiles plus active user OpenAI OAuth; no profile/credential changes authorized or made. Harness follow-up now selects an existing full-default Codex profile and conversation through actual form, then requires awaiting_followup plus a real assistant marker reply before cleanup;28 tests/lint/current-tree secret scan passed. End-to-end completion/cleanup and production verification remain pending.

Latest main711fdc35 roster release merged normally as1a044620; no conflicts, audit-document edits preserved exactly. Within original35-file trigger review scope, integration changed only four upstream roster rows in the shared API reference;34trigger runtime/helper/test files stayed byte-identical before the subsequent test-harness fix. Relevant API typecheck4tasks, ingress/parity26tests and context budget passed.

Final Sol task01M4TH84NHJK96F6YDTRGH1DZ3 reached awaiting_followup and produced the actual marker in27ordered persisted assistant chunks. A normal read-only500-row ascending query proved combined-marker=true, individual-marker=false and hasMore=false. Harness now reconstructs ONLYassistant chunks, drains ordered pages with exact [createdAt,sequence,id] cursors, and rejects truncation/stalls/user-only text;30 tests, lint and normal secret scan50reviewed/0new passed. No runtime change or additional dispatch. Existing observer stopped before timeout cleanup; normal verification login subsequently returned429 with numeric Retry-After354, so root respects the wait and retains the same test for re-verification/cleanup. Final zero-at-rest, temporary-profile cleanup, normal PR/CI/review/merge/deploy and production acceptance remain pending.
