# Protect human-input waits from false stall cleanup

## Problem

The stalled-turn classifier introduced in #2232 sees a quiet transcript and active prompt but ignores pending ACP questions/permissions and needs-input markers. Its cron failure path directly cleans compute without the existing failed-task snapshot/sleep preservation.

## Authorization

Raphaël requested the fix, production merge/deploy, and explicitly said to skip staging. Source Idea: 01M47RANRASPRD6JVB4YAPAG6P.

## Research

- `scheduled/stalled-task-classifier.ts` only reads messages and activity ages.
- InteractionStore is authoritative for ACP requests; ProjectData attention markers cover other human-input waits. Both have bounded deadlines and distinct expiry owners.
- `scheduled/stuck-tasks.ts` bypasses `cleanupTerminalTaskResources` on classifier failure. Existing failed-task preservation queues final snapshot/sleep and withholds teardown on unknown state; runaway/compaction kill switches remain intentional immediate stops.
- Follow rules 47 (I/O budgets), 58 (destroyer/resumer agreement), 61 (both runtimes), and 35 (real-entry-point regression tests).

## Checklist

- [x] Guard classification using bounded authoritative pending-human-input reads; unavailable reads withhold classifier verdict.
- [x] Recheck input before accepting a stalled verdict to cover requests arriving during inference.
- [x] Route classifier-induced failure through existing failed-task preservation, without changing immediate kill switches.
- [x] Regression tests through the cron entry point cover pending permissions/forms/URL, attention waits, expiry/resolution, lookup failures, races, and actual-stall preservation.
- [x] Update relevant public docs and preservation path documentation.
- [x] Run lint, typecheck, tests, build; local specialist/completion reviews.
- [x] Staging explicitly waived; release tracking transferred to PR #2245 and its CI/CodeRabbit/production deployment records. CI, review wait, merge and production monitoring remain required before task delivery.

## Acceptance

Waiting for human input is never interpreted as a machine stall before its deadline. Unknown input state cannot authorize classifier cleanup. Real stalls use bounded snapshot-backed preservation on VM and Instant. Expired/resolved waits do not pin runtime forever. Existing kill-switch behavior remains intact.

## Verification

- Six regressions failed before the implementation (false waiting verdicts, during-inference request, and direct teardown).
- Focused cron/attention tests: 59 passed; real two-DO RPC/SQLite test: 1 passed.
- Repository lint/typecheck/build pass. Full tests: 21/21 tasks; API 819 files / 11,468 tests, web 336 files / 4,023 tests. All three local reviewers PASS/ADDRESSED; two test fixture type gaps fixed in 65a1e2ea9.
- Task-note direct main push rejected by required checks; note included in this feature PR instead.
- No discovery widening: at most the existing 100 candidates/sweep. Only active turns old enough for classification get the new guard; two cheap read-only calls run concurrently under existing 5s liveness timeout. A confirmed stalled verdict gets one second pair; no added retries. Unavailable reads decline the classifier verdict, while existing finite request deadlines, expiry owner and absolute runtime ceiling still apply.

## Delivery record

Implementation archived after task-completion-validator A–F PASS and all local reviews complete. Release progress and final result: https://github.com/raphaeltm/simple-agent-manager/pull/2245.

## CodeRabbit follow-up

Capped UI interaction snapshots can omit unexpired requests behind expired backlog. Replaced the classifier snapshot read with an indexed `InteractionStore.hasUnexpiredHumanInput(now)` existence probe, independent of snapshot limits. Canonical deadlines protect ACP requests even when their projection has no expiry; unbounded projection markers alone do not pin compute. Real DO test adds 64 expired records, proves the UI snapshot omits the live request, and verifies pending/answered protection then deadline release. Focused 59 tests, real Worker test, API typecheck/build and updated runtime/completion reviews PASS.

PR completion follow-up: expanded the real Worker regression into absent-projection and null-expiry ACP-projection cases. Both verify unexpired pending and answered requests hidden by the capped UI snapshot; deadline equality releases classification even with an unresolved projection. Two Worker cases and 59 focused cron/attention tests PASS; API typecheck and focused lint PASS. Independent local Cloudflare/constitution and test/completion re-reviews PASS with no findings. Release gates remain tracked on PR #2245.

PR #2245 merged concurrently at 17:24:55 UTC as `04a36a6f7`; its production deployment `37506433497` succeeded. The explicit projection test expansion is delivered separately in PR #2246. Its full GitHub Actions CI passed after correcting PR-body preflight markers, and CodeRabbit approved at 17:59:36 UTC. SonarCloud initially cancelled automatic analysis because the project setting was disabled, then rejected a direct clean-checkout scan after automatic analysis was re-enabled; no project setting was changed by this continuation. Final analysis and follow-up release evidence are tracked on PR #2246.
