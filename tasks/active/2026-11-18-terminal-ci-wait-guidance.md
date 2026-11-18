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
- [ ] Relevant tests/lint/typecheck/build/context budget, specialist review, ready CI and CodeRabbit request/wait.
- [ ] Merge/deploy after gates; guidance-only staging exemption authorized by dispatch.
- [ ] Measure covered production row_usage windows using Library rpc-split.mjs via exec_with_secrets. Compare check_run/h and admission/wake/prompt writes/h; disclose coverage, new-session ramp and sibling confounding; durable wait while accumulating hours.

## Candidate validation and review
PR https://github.com/raphaeltm/simple-agent-manager/pull/2883 . New workerd regression: 3/3 pass before guidance edits. Instruction additions: 2/2 fail old defaults; focused unit suite 33/33 passes after. Root lint/typecheck/build pass; full test retry in progress after concurrent Astro builds collided (missing prerender chunk), standalone build passed. Context budget check passes with compact rule09; no raised ceiling. All local reviewers PASS: docs sync, Cloudflare/test engineer, task completion (candidate). Task completion reviewer requested accurate tracking; implemented. Task stays active until rollout measurement finishes rather than falsely archiving a completed observation.
