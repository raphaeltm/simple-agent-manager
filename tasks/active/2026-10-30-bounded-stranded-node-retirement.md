# Bound stranded node cleanup refusals

Task 01M66M4XPQVGXYH5NTM8VMDWDB; idea 01M66M4A33YHH9X90ZFQD2PAZ1, read in full.

## Research
#2463 guarded cleanup claims but not handoff selection. Deleted/evicted legacy sources lack physical deletion proof indefinitely. Failure backoff defaults to one hour, so stranded deadlines must cap it. Strict deletion preserves provider ownership checks independently of artifact authority. SAM supplied isolated output branch/workspace; use it directly.

## Acceptance / implementation
- [ ] R1 automatic distinctly named authority after configurable 30-minute refusal; bounded preservation first, exact provider/incarnation/ownership and active-workspace gates retained; existing termination-proof writer.
- [ ] R2 warn platform error with ids of unpreserved sources; preserve backups/transcripts; invalidate unusable snapshot wake targets.
- [ ] R3 one diagnostic SELECT on claim loss, named guards, warn after five minutes.
- [ ] R4 additive blocked clock, clear successful claim/release/status exit; enumerate writers.
- [ ] R5 bounded ordered page and short backoff; explicit selector/artifact guard asymmetry relies on deadline.
- [ ] R6 shared configurable DEFAULT 30min, runtime setting or env with documentation.
- [ ] R7 no dead-letter requeue; 404 remains no physical proof.
- [ ] R8 ownership failure admin-visible deduplicated alert, including deployment nodes.
- [ ] R9 minimal blocked-state API/UI visibility or explicit scope explanation.
- [ ] Real cron SQLite divergence/29min/active/preserved/clock/ownership/default/wake tests.
- [ ] Discrimination: remove forced branch; divergence red and within-deadline green; restore.
- [ ] lint/typecheck/tests/build; specialist security/Cloudflare/test/completion/config/doc reviews.
- [x] Staging deployment explicitly waived by Raphaël; do not deploy staging.
- [ ] PR evidence/CI/CodeRabbit request and wait/merge.
- [ ] Deploy Production success then read-only migration/cron/overdue workspace nodes/deployment node verification.

## Status writer inventory
Pending narrow scan: node provisioning, heartbeat lifecycle, NodeLifecycle handoff, node resource lifecycle/deletion, cron claims/release/terminal, warm placement and upgrade/restart paths. Heartbeats that only write updated_at must retain clock.
