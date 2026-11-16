# Provider-limit queued watchdog reliability

## Problem
Provider-limit waits longer than the queued timeout are failed at release, sometimes after placement. Production idea 01M7JC0VW2GHT3JEM1P0WE064P records six victims at14:20Z on2026-11-16. Sleeping task01M7GZVGD2BF6J7YP4GZH0GVS0 also needs investigation.

## Research and preflight
Business-logic change, confined to API TaskRunner admission, watchdog, shared terminal helper, and worker tests. Verified holdTaskForProviderLimit releases wait without updating updated_at; preserveProviderLimitWait re-reads and returns false on released; watchdog uses stale candidate age; terminal helper reloads status and treats expected null workspace as no guard.
Condition: continuously runnable queued task with no admission hold or placement progress. Signal: updated_at since orchestration last progressed, including explicit limit release. Divergence: old updated_at covers deliberate provider wait; a concurrent release or placement invalidates that candidate.
Keep existing configurable timeout and resolve defaults through production read path. No new tunable, schema migration, table rebuild, external API, or credential change. Preserve bounded selection and isolated sweeps. Review rules47,53,58,62,74. Existing stuck-tasks file has a documented size exception; keep surgical edits.

## Implementation checklist / acceptance
- [x] Prove release divergence red through real scheduled handler with real D1 and default timeout resolution.
- [x] Reset runnable queued clock at real admission release, guard stale verdict at atomic terminal write (status, exact nullable workspace, updated_at).
- [x] Verify genuine stuck queued control fails with observed-state error, no unsupported provisioning diagnosis.
- [x] Verify races before terminal reload and between reload/write; no terminal hooks or cleanup after rejected write.
- [x] Investigate sleeping production task and record separate defect on idea if distinct.
- [ ] Run lint, typecheck, tests, build and worker regression/isolation suites.
- [ ] Local cloudflare-specialist, test-engineer, completion, constitution and doc-sync reviews.
- [ ] Draft PR, ready CI/CodeRabbit, staging lease/live checks/release, merge normal gates.
- [ ] Production deploy and basic smoke; idea note and durable Inbox coordinator message.

## Validation / process
Regression tests enforce existing rules58/62/74. No new standing steering rule needed. Document red proof, I/O delta, staging limitations, reviews, deploy evidence in PR. Out-of-scope UNIQUE workspace chat-session constraint remains idea01M55GNWQNFYWSV360H2F811BC unless shown same change.

## Implementation evidence
Initial four-case worker run on pre-fix runtime: 4 failed, including both released-hold cases and placement race; genuine stuck control failed only the diagnostic-text assertion. Exact required red test: `does not fail an old provider-limit hold released before the watchdog tick`.
After fix: new8 cases + existing scheduled-stuck-tasks worker suite29/29 passed; unit stuck-tasks59/59 passed after retaining updated_at in its terminal-load fake. Root lint/typecheck passed; root test/build, owner-resume regression, release gates pending.
Cloudflare reviewer PASS: zero added D1/DO/fetch round trips, unchanged candidate/page bounds and sweep isolation. Constitution and doc sync PASS. Completion reviewer implementation checks PASS except evidence/checklist synchronization; full release still pending.
The existing queued threshold resolves through production parseMs(legacy Worker binding, shared default1200000ms); tests supply no threshold. No admin-setting/new tunable is introduced.
Sleeping investigation: idea note01M7JQB48DDNJM3MVRY2CHA7EE. No provider-limit continuation schedule was present; VM classifier omits observed5-hour wording and only classifies terminal errors. Typed ACP outcome remains unverified. Separate follow-up, no VM change. UNIQUE workspace-chat wake conflict remains separately tracked.
