# Default CI waits to terminal events

## Scope and preflight

SAM task 01M7PSJBB57E9JXGPCDX6RK42E; coordinator 01M7KXHRDQ6C08JCHTRH5R3QQK. Product-wide guidance authorized by inbox 01M7PMFRYQ7Q0T86HZ5E6GYZ51. Classes: docs-sync-change, public-surface-change. No runtime/config/migration change; existing subscriptions expire naturally. Use pre-provisioned isolated output branch; task record travels in PR (main protected).

## Research

Read evidence notes 01M7PM7Y1K4C62FRDDJTPMRWVH and 01M7PM9ZAYEF2AZCT3C5WCEHAQ before editing: 6.254 covered hours, stored CI 527.665/h, check_run 409.660/h (77.64%), admission 15163.8 writes/h, wake 12813.3/h, prompt 9983.3/h. Aggregates include non-CI work.

github-project-event-producer.ts resolves suite/workflow head_sha into commit subjects and preserves failure conclusions/attempts. project-events-normalization.ts matches exact event sets/SHA; no all-CI aggregation. scripts/deploy/utils/github.ts manifest requests both terminal events and checks/actions read. Live main suites show Actions and Sonar completed on same SHA, CodeRabbit queued: completion cannot be guaranteed for every app. Status-only providers, webhook configuration/permissions, missing SHA, forks/merge SHAs and incomplete apps require bounded fallback plus GitHub reconciliation. First summary never grants merge; reconcile all apps/workflows/reruns.

Sources: https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks and https://docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_run . Preserve docs/guides/ci-wait-recovery.md race/expiry/ownership procedure.

## Checklist and acceptance

- [x] Verify real producer/subscription/materialization/runtime-boundary wakes on suite/workflow failures; exclude check_run and wrong SHA; explicit job control.
- [x] Pin terminal default, per-job opt-in and fallback wording; verify test red before guidance edits.
- [x] Update instructions, MCP descriptions, recovery guide, rule09, do/workflow skills/commands, public agent docs/examples. Audit all check_run.completed occurrences; historical evidence/tests remain valid.
- [x] Document app/workflow scope, failures, fallback gaps and natural expiry/no migration.
- [x] Relevant tests/lint/typecheck/build/context budget, specialist review, ready CI and CodeRabbit request/wait.
- [x] Merge/deploy after gates; guidance-only staging exemption authorized by dispatch.
- [ ] Measure covered production row_usage windows using Library rpc-split.mjs via exec_with_secrets. Compare check_run/h and admission/wake/prompt writes/h; disclose coverage, new-session ramp and sibling confounding; durable wait while accumulating hours.

## Candidate validation and review

PR https://github.com/raphaeltm/simple-agent-manager/pull/2883 . New workerd regression: 3/3 pass before guidance edits. Instruction additions: 2/2 fail old defaults; focused unit suite 33/33 passes after. Root lint/typecheck/build pass; full test retry passed (41/41 tasks; API1113 passed/3 skipped files,16968 passed/4 skipped tests; web428 files,5433 tests) after concurrent Astro builds collided (missing prerender chunk), standalone build passed. Context budget check passes with compact rule09; no raised ceiling. All local reviewers PASS: docs sync, Cloudflare/test engineer, task completion (candidate). Task completion reviewer requested accurate tracking; implemented. Task stays active until rollout measurement finishes rather than falsely archiving a completed observation.

Baseline reproduced via Library exec_with_secrets job sx-22f00d8c45c14b053e5a703a17d6ec58ce62cc387d645c563916914c70993759 and a counts-only derivative sx-3c85a7afff0ec2ee10526dc3f05b9760a7d05f2d99e1a73b41dc54b71222680a. The derivative flattens Cloudflare telemetry's nested dotted keys and rejects nonnumeric counters. Exactly25 complete windows,6.2539667 covered hours, no overlaps/missing admission counters/overflow; all3 operation labels present throughout. Reproduced check_run409.660/h,storedCI527.665/h,wake262.393passes/h and all baseline write rates. Counters have no session dimension: aggregate rollout measurement cannot isolate post-deploy-started sessions; coordinator notified, no causal/cohort claim permitted.

## Coordinator followup: multiple workflow wakes

- [x] Confirm subscription survives delivery/ack; retain existing active same-SHA subscription and fallback while required checks remain pending, end the turn again without recreating waits.
- [x] New real workerd case: CI in_progress, request workflow completes and wakes while CI pending; delivered/read/acked first batch leaves subscription active; CI failure completes60s later and produces a distinct second delivered batch with same one subscription and two readable terminal events.
- [x] Pin retention wording in both instruction-content entry points. Focused units33/33 and workerd4/4 pass; affected ESLint and context-budget checks pass. Original full-root test/lint/typecheck/build evidence remains valid for prior candidate; added case checked directly.
- [x] All local reviewers rechecked delta. Docs/completion LOW ambiguity about cancelling fallback on mere progress addressed: cancel when wait ends, not first workflow completion. No runtime changes; staging exception still applies.

## Sonar duplication correction

Current-head Sonar check134669719389 blocked on11.9% duplication. Public duplication API identified only two repeated15-line fixture/subscription setup blocks in the new workerd test (lines21/128). Extracted one small withCiSubscription helper without changing assertions or runtime code. Workerd4/4 and affected ESLint pass after extraction. Test-engineer/Cloudflare and task-completion reviewers rechecked PASS; all4cases and full producer-to-delivery path remain. Fresh CI/Sonar required on corrected head; no exclusion or gate bypass.

## Takeover (task 01M7RHQG0DNQ3BXDB0DWSRP5CE, 2026-11-19)

Previous agent ran out of usage. Head 62ab30db had all checks green (CI 44267154993, Durable Object Workers pass). main had moved 173 commits; merged origin/main (no conflicts) and re-ran full CI before merge. Task stays active until the coordinator's production measurement completes.

## Reconciliation (2026-11-23, weekly queue reconciliation)

- Shipped in [#2883](https://github.com/raphaeltm/simple-agent-manager/pull/2883) (merged 2026-11-19). The production row_usage measurement (line 23) was never done. It was evidence-gathering, not a deliverable. It is now tracked as an open measurement on idea `01M7CX61WVX72T7CFQNRTX0DVM` (note dated 2026-11-23).
- Production deploys from `main` have succeeded continuously since then (latest `7d40cfb2d`, 2026-11-23).
- 1 line(s) stay unticked. They are verification or reporting steps that were not re-checked here; this record does not claim them.
