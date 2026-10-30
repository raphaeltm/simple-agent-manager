# Bound stranded node cleanup refusals

Task 01M66M4XPQVGXYH5NTM8VMDWDB; idea 01M66M4A33YHH9X90ZFQD2PAZ1, read in full.

## Research
#2463 guarded cleanup claims but not handoff selection. Deleted/evicted legacy sources lack physical deletion proof indefinitely. Failure backoff defaults to one hour, so stranded deadlines must cap it. Strict deletion preserves provider ownership checks independently of artifact authority. SAM supplied isolated output branch/workspace; use it directly.

## Acceptance / implementation
- [x] R1 automatic distinctly named authority after configurable 30-minute refusal; bounded preservation first, exact provider/incarnation/ownership and active-workspace gates retained; existing termination-proof writer.
- [x] R2 warn platform error with ids of unpreserved sources; preserve backups/transcripts; invalidate unusable snapshot wake targets.
- [x] R3 one diagnostic SELECT on claim loss, named guards, warn after five minutes.
- [x] R4 additive blocked clock, clear successful claim/release/status exit; enumerate writers.
- [x] R5 bounded ordered page and short backoff; explicit selector/artifact guard asymmetry relies on deadline.
- [x] R6 shared configurable DEFAULT 30min, runtime setting or env with documentation.
- [x] R7 no dead-letter requeue; 404 remains no physical proof.
- [x] R8 ownership failure admin-visible deduplicated alert, including deployment nodes.
- [x] R9 minimal blocked-state API/UI visibility or explicit scope explanation.
- [x] Real cron SQLite divergence/29min/active/preserved/clock/ownership/default/wake tests.
- [x] Discrimination: remove forced branch; divergence red and within-deadline green; restore.
- [ ] lint/typecheck/tests/build; specialist security/Cloudflare/test/completion/config/doc reviews.
- [x] Staging deployment explicitly waived by Raphaël; do not deploy staging.
- [ ] PR evidence/CI/CodeRabbit request and wait/merge.
- [ ] Deploy Production success then read-only migration/cron/overdue workspace nodes/deployment node verification.

## Status writer inventory
Scanned every `UPDATE nodes` and `.update(schema.nodes)` under apps/ and packages/ (including Durable Objects).

- Status exits clear clock/reason/alert: node-provisioning.ts (creating/running/error plus conditional publication); routes/node-lifecycle.ts (ready and heartbeat status backfill); vm-agent-container-runtime.ts (sleeping/error), vm-agent-container-recovery.ts (recovery/running), vm-agent-container-recovery-failure.ts; routes/deployment-environments.ts deleting/error; services/node-resource-lifecycle.ts terminal writes; services/session-sleep-teardown.ts sleeping; services/instant-session.ts error; task-runner/boot-recovery.ts terminal; scheduled/trial-expire.ts terminal/error; cron shared.ts terminal. Conditional provisioning retains existing stopped/destroying episode.
- Stopped/destroying handoffs retain episode: NodeLifecycle.handoffIdleNode, strict-node-deletion claim, provisioning-authority claim, task-execution-authority claim, deployment-node-cleanup destroy handoff, node-resource-deletion destroy quarantine, boot recovery destroy claim and trial-expire claim. A newly created node naturally starts NULL.
- Cleanup successful claim and release explicitly clear clock/reason. Failed strict guards record a new refusal after release, restoring the selected original blocked-since timestamp when available.
- Heartbeat-only, health, boot failure diagnostics, usage, credential binding, placement/reservation, snapshot relay and warm-claim writes do not change status and retain clock. Warm placement has running-only predicates; no stopped/destroying-to-running writer bypass.
- Node hard-deletes remove all node metadata; saved workspace/source artifacts/transcripts are not deleted by this feature.

## Evidence
Initial real-cron suite 7 red/2 green: 31-minute source produced no provider delete. Discrimination removes stranded_nodes phase: 31-minute red, 29-minute green; restored. Existing handoff regression 67 passed; new initial cron/migration/admin override suite 11 passed; real route ready/heartbeat/visibility suite4 passed; workerd deadletter requeue refusal passed.

Read-only production baseline 2026-10-30 14:58 UTC through exec_with_secrets: no stopped/destroying managed workspace nodes; deployment node01KXAR1T3XCQKKPBEJEERQ2PSZ still destroying, provider150100869, credential source/referenceNULL. Latest production deployment successful (run41056852924).

Final focused suite:17 cron/SQLite tests passed, including preservation of the original blocked clock after an exact provider delete returns403; four HTTP writer/visibility tests,67 existing handoff tests and workerd dead-letter control remain green. Local security, Cloudflare, test, constitution, doc-sync and task-completion reviews PASS/ADDRESSED. Full repository tests continue with bounded concurrency; lint/typecheck/build and migration/runtime/file-size checks pass.

Exact branch discrimination at15:32 UTC in isolated detached checkout: disabled only forced destroyNodeForCleanup call;31-minute case failed exact provider-delete assertion,29-minute control passed (15 skipped). Restored call:2passed/15skipped. Temporary checkout removed; main working tree was not mutated.
