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
- [ ] Guard classification using bounded authoritative pending-human-input reads; unavailable reads withhold classifier verdict.
- [ ] Recheck input before accepting a stalled verdict to cover requests arriving during inference.
- [ ] Route classifier-induced failure through existing failed-task preservation, without changing immediate kill switches.
- [ ] Regression tests through the cron entry point cover pending permissions/forms/URL, attention waits, expiry/resolution, lookup failures, races, and actual-stall preservation.
- [ ] Update relevant public docs and preservation path documentation.
- [ ] Run lint, typecheck, tests, build; local specialist/completion reviews.
- [ ] Skip staging per explicit user instruction; CI, CodeRabbit request/wait, merge, monitor production deploy.

## Acceptance
Waiting for human input is never interpreted as a machine stall before its deadline. Unknown input state cannot authorize classifier cleanup. Real stalls use bounded snapshot-backed preservation on VM and Instant. Expired/resolved waits do not pin runtime forever. Existing kill-switch behavior remains intact.
