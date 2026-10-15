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
- [ ] Tests: concurrency, restart, retention, retry dedupe, failures, mixed versions, rollback, clean install/existing migration.
- [ ] Full validation and independent Cloudflare/security/adversarial reviews.
- [ ] Draft PR with evidence and consolidated pinned staging plan; coordinator performs staging/final release gates.

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
