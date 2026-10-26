# Reliability C: SQLite MCP counters and boot logs

## Problem

MCP per-agent fixed-window counters and workspace boot callback appends rewrite hot KV keys. Recorded PUT 429 incidents become HTTP 500; exact incident concurrency is unverified. KV counter updates also race.

## Research

- `apps/api/src/routes/mcp/_helpers.ts`: counter; callers `mcp/index.ts` and `webhook-claims.ts`, preserve task/agentSession/workspace fallback.
- `services/boot-log.ts`: append, replace/clear, read. All writers: runtime callback append; lifecycle resume/restart clears. Reader: workspace CRUD response.
- DO SQL transactionSync provides atomic local updates; external legacy reads require a mutex.
- Existing-deployment migration requires bridge routing before future cutover, with rate-window ownership stable across mixed bridge versions. Unsupported rollback to prebridge would bypass quotas.
- Config generated from top-level wrangler bindings; append-only migration after v21. No ProjectData reuse.

## Checklist

- [x] Dedicated SQLite rate counter, persistent atomic admission and bounded cleanup.
- [x] Deterministic fixed-window ownership, fail closed on invalid activation or DO errors, preserve headers/auth/identity.
- [x] Dedicated bounded boot log with legacy read merging, retry dedupe, TTL and clear semantics. Legacy KV drains on its original TTL; new appends refresh SQLite-native retention.
- [x] Enumerate and wire every reader/writer; bindings, export, migration, deployment configuration and docs.
- [x] Automated tests: concurrency, restart, retention, retry dedupe, failures, compatible mixed versions/rollback, activated HTTP fallback/auth/headers and clean/existing migration configuration. Actual deployed migration proof remains coordinator-owned below.
- [x] Full local validation and independent Cloudflare/security/adversarial reviews.
- [x] Draft PR #2357 with evidence and consolidated pinned staging plan; coordinator performs staging/final release gates.

## Acceptance

No post-cutover per-request KV counter writes or full-log KV writes. Counter restart preserves quota, state bounded, no dual authoritative/fail-open fallback. Boot logs preserve API/auth/retention and old records drain without resurrection after clear. Draft PR only; DO NOT MERGE or independently deploy staging.

## References

Idea 01M4QNWEZG8KQQDF2R9VTK8TWM; task 01M500B6ZWHZ2PBR36AMFP6F50; coordinator 01M50044HCHRVR12B4337721G5; `.claude/rules/44`, API rule45; Cloudflare SQLite storage documentation.

## Independent review evidence

- Cloudflare/constitution/test specialist: ADDRESSED. One MEDIUM ordering defect in legacy/native deduplication fixed in e6ca5acd5 with exact cap-2 regression. Architecture, SQL transaction/lock/cleanup and generated bindings reviewed.
- Fresh adversarial security: PASS at e6ca5acd5, no findings. Existing token/callback ownership checks, fallback identities, fail-closed routing and preserved rollback authority reviewed.
- Completion/docs/env/test specialist: implementation wiring PASS; initial HTTP coverage WARN addressed by real activated MCP route-to-SQLite tests for all fallback identities. Final rerun and deployed migration/staging gates remain pending.

## Coordinator-owned release verification

Do not archive before the task-completion validator reconciles final evidence. Coordinator owns consolidated pinned staging, actual clean-install/existing-deployment migration, compatible rollout/rollback, CodeRabbit, exact-head CI/Sonar/security and production verification. No gate is waived. This implementation owner delivers a draft PR and assists those checks; no independent deployment or merge.

## Workflow exception evidence

Task-only main push rejected by repository GH013 required Durable Object Workers check. No bypass attempted; task included in feature PR. SAM-provided isolated output checkout reused; recovery preserved source but removed dependencies and temporary logs, so broad check outcomes were discarded and rerun.

## Final local validation

- `pnpm lint`: PASS, 13 tasks; existing UI warnings only.
- `pnpm typecheck`: PASS, 19 tasks; existing Astro baseline unchanged.
- `pnpm test`: PASS, 21 tasks. API 12,389 passed / 2 skipped; web 4,057 passed; remaining shared/package suites passed.
- `pnpm build`: PASS, 9 tasks.
- Real Worker storage suite: 12 PASS, including authenticated activated HTTP routes for all fallback identities.
- Generated config suite: 60 PASS, staging and production activation/binding/migration assertions.
- DO migration safety and Wrangler binding checks PASS; formatting and diff checks PASS.

Draft PR: https://github.com/raphaeltm/simple-agent-manager/pull/2357. Implementation head 3a90b30c92b082637cb8c152f56960dee0eece8f; final evidence commit contains only this task update. No independent staging deployment or merge. Actual runtime migration/rollout and release gates remain pending under coordinator ownership; task remains active rather than archived.

## Coordinator-assigned correction (Sol B integration owner)

Original per-version cutovers permit a delayed env-unset bridge invocation to use KV after a configured version switches to DO. Correction uses an uncached primary D1 insert-once shared activation record, pins rate windows before the lookup, and routes every bridge boot-log operation through its workspace DO lock including awaited legacy KV operations. Real Worker regressions cover held request body and delayed legacy append versus activated clear. Initial prebridge retirement is explicitly unresolved and blocks activation, staging readiness, and release; no fixed wait or traffic percentage is a proof. No scanner/baseline waiver.

## Reconciliation 2026-10-26

- Shipped by #2371 (`8394efa14`, merged 2026-10-17); first successful production deploy:
  run 39044559133 (attempt 2, head `8394efa14`, 2026-10-17). The immutable activation record was
  published by run 39047889679; cutover 2026-10-17 16:15 UTC.
- Unticked: 0 — none.
- Verdict: ARCHIVE. The coordinator-owned release gates were completed under
  `2026-10-16-reliability-c-production-release.md` and the #2371 body; owner task
  01M54TW40EA2VTA54SJ34SRJX1 completed with a passing completion audit.
- Open PRs: drafts #2357 and #2361 hold this file's original commits (`e6ca5acd5`, `3a90b30c9`,
  `a890a46b3`); #2371 re-landed that code from preserved source `74d5b9486`, and #2361's
  activation migration became 0197. Nothing here depends on them.
