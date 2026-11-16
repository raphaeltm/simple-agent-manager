# Provider-limit queued watchdog reliability

## Problem and verified findings
Provider-limit waits longer than the queued timeout were failed at release, sometimes after placement. Production idea01M7JC0VW2GHT3JEM1P0WE064P records six victims at14:20Z on2026-11-16. Code verification confirmed admission release cleared the hold without resetting updated_at; the watchdog then judged the old queued age. The terminal helper reloaded and guarded a fresh status, and a null expected workspace disabled its old workspace guard.

Condition: continuously runnable queued task without an admission hold or recorded placement progress beyond the timeout. Signal: orchestration updated_at, explicitly restarted on hold release. Divergence: the old timestamp included deliberate provider wait; release or placement during watchdog awaits invalidated the candidate. Automatic release and owner no-snapshot resume now reset that clock in their existing writes. Every watchdog terminal write fences the scanned status, exact nullable workspace and updated_at before reload and in the atomic UPDATE. The diagnostic reports lack of recorded orchestration progress. Zero added D1/DO/fetch round trips per tick, unchanged bounds/cursor and scheduled-step isolation; no schema, migrations, new Worker variables or tunables.

## Acceptance and validation
- [x] Required pre-fix red through real scheduled handler/D1: `does not fail an old provider-limit hold released before the watchdog tick` (got failed, expected queued).
- [x] Release-before-tick and release-after-scan preservation; active hold, genuine stuck convergence control and factual diagnostic.
- [x] Placement races before helper reload and between reload/write; independent status-only/workspace-only changes retain the old timestamp.
- [x] Actual owner no-snapshot resume clock mutation red/green proof; eventual real stall after release expires.
- [x] Existing production parseMs threshold resolver/shared1200000ms fallback; no test timeout override or new tunable.
- [x] Sleeping path investigated and separate finding recorded on the idea.
- [x] Root lint22 tasks, typecheck36, test39 and build18 passed. API15940 tests passed/4 skipped; web5302 tests passed. Final10 new worker cases and21 existing watchdog worker cases passed; focused unit59/59 passed.
- [x] Local cloudflare-specialist, test-engineer, constitution, doc-sync and implementation-completion reviews passed.
- [x] Staging full deployment, authenticated live checks and lease cleanup completed.
- [x] Full ready CI/CodeRabbit gate and normal merge completed.
- [x] Actual production deployment, basic smoke and idea evidence completed.
- [ ] Durable Inbox coordinator notification accepted (currently refused: recipient has no workspace).

## Release evidence
Implementation PR [#2815](https://github.com/raphaeltm/simple-agent-manager/pull/2815) merged19:34:23Z on2026-11-16 as470bfe6656690e96d9afb56900283f7c467b4520. ReadyCI43925235169 passed all jobs/required aggregate. CodeRabbit trusted request43925323252 received an explicit rate-limit reply; no review or unresolved thread arrived.

Staging43925271030 fully passed, including workflow smoke. Authenticated Playwright verification occurred18:51Z on2026-11-16, dashboard/projects/settings HTTP200 and expected headings/screenshots, no page errors, health200 and bounded watchdog diagnostics200. No test resources created. Both installation queues checked and deployment used our own lease. Release43935371206 succeeded after hosted-runner delay; status19:10:26Z confirmed holder=null and next task was durably notified. No real account limit was consumed/recreated live; controlled reset/time/race claims rest on scheduled-handler/D1 workers.

Actual production [run43977868243](https://github.com/raphaeltm/simple-agent-manager/actions/runs/43977868243), attempt2, succeeded on2c5ee4d4b5403fe26593b0e51992889c97f02dc8 (verified ahead of the merged fix); its mainCI43969139676 fully passed. Attempt1 failed Cloudflare Worker startup CPU validation; an externally initiated retry succeeded. Worker deployment23:40:43Z, rollout23:46:39Z, workflow health23:47:24Z all passed. Independent Node-fetch basic smoke23:55:27Z: production API /health200/healthy, app200/expected shell. No production provisioning, behavior tests or restarts. Earlier successful no-op deploy workflows were not counted as shipping.

Idea shipping note01M7KCKSZNFDAW1TY8GX355SW8 records PR/deploy evidence. Coordinator notification to01M7FZH8XEZ8PT9H3JMWRNVHJ5 was refused: `Target task has no workspace assigned yet`; tasks_read showed queued. Blocker note01M7KCP68S86RE0MVXM1GFNJ61 records this honestly. Retry the same durable-message idempotency key when recipient gains a workspace; no accepted delivery is claimed yet.

## Separate findings and scope
Sleeping task01M7GZVGD2BF6J7YP4GZH0GVS0 had no provider-limit continuation schedule; VM classifier omits observed5-hour wording and only classifies terminal errors. Actual typed ACP terminal outcome remains unverified. Separate pre-continuation/classification follow-up documented in idea note01M7JQB48DDNJM3MVRY2CHA7EE; idea remains open. UNIQUE workspaces.chat_session_id wake conflict remains out of scope, idea01M55GNWQNFYWSV360H2F811BC.

Unrelated scheduled production wall-time/rate alert43941422421 predates this deployment; evidence and uncertainty filed as idea01M7JY7175FP1ZCR2AC2FCBYX8. No runtime scope expansion.

## Process
Regression coverage enforces existing rules47/53/58/62/74; no new standing guidance needed. Direct initial task-only push to main was rejected by required checks, so plan/release records use PRs. SAM-provided isolated implementation workspace retained; pre-existing .codex/config.toml modification preserved. Archive only after final completion review and accepted coordinator notification.
