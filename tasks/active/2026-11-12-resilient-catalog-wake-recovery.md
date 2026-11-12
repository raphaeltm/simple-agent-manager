# Resilient compute catalog refresh and sleeping wake recovery

Idea: 01M77P985TDMCJ28JTTQHEYMC7. SAM task 01M77Q6A32CJRZAE06QE8NH1YJ.
Coordinator task 01M77NV1B621TKTV79272F7YX3. Sol / openai-codex.

## Problem and authorization

An established pool became migration-pending mid-refresh, hiding validated capacity and permanently refusing a healthy sleeping conversation's accepted wake. All four changes are approved: retain committed capacity safely; durably continue refreshes; preserve retryable wake intent; test interruption/restart/recovery. Additional evidence: harmless pool revisions reject still-authorized existing nodes.

DRAFT PR only pending coordinator review of full final SHA. Do not disturb original production conversation 113a693f-8f1c-4b3f-88d8-69fa1ee4ab91, stable task 01M72KTXWD8FJ0Z7TXKN5GF20J or snapshot. Real staging required; no production lifecycle fixtures.

## Preflight / research

Classes: cross-component-change, business-logic-change, security-sensitive-change, docs-sync-change.
Data flow: scheduled/capacity-pool-reconciliation -> default-capacity-pools-read/ensure -> fenced D1 source/candidate publication -> summary -> placement resolver/authority -> session-recovery -> snapshot claim/TaskRunner -> ProjectData durable prompt delivery -> ready handoff.
Existing cursor persists every batch, fences obsolete source generations; current publication mutates live candidates before completion. Daily gate claims before work and cannot resume unfinished refresh promptly. Current refusal classification already supports transient retries; preserve these mechanisms and delivery TTLs.
No new external API/dependency/framework planned. D1 additive migration, real SQLite tests, existing D1 batching. Existing interruption/fencing tests retained. Source/credential/current membership remains live authority. New allocations retain strict revision fences; existing-node reuse must revalidate against current authority.
Concurrent #2682 extraction keeps D1 worker-side; pure placement files move to scheduler-core after integration #2681. Coordinate and rebase on latest main.
Existing backlog: 2026-11-09-capacity-pool-readiness-gate-during-republication.md. Prior archive: 2026-11-09-capacity-pool-publication-deadline-loop.md.

## Implementation checklist / acceptance

- [ ] Stage complete replacement candidate sets durably; atomically promote with generation/ownership + current membership fences; no mixed live set or premature missing cleanup.
- [ ] Persist trustworthy pool publication proof; bootstrap stays gated, established refresh retains placeability through interruption/failure. Immediate revocation/source disable/removal remains enforced.
- [ ] Durable retry next action + started/last-success/deadline; resume independent of daily gate and after lost notification/restart; shared pass budget bounds all sources/scopes; actionable exhaustion retains committed catalog.
- [ ] Admin-editable settings and documented latency/throughput at 7,200-row catalog and many scopes.
- [ ] Typed temporary catalog/lookup/capacity wake waits; impossible resources/configuration/credentials remain accurate outcomes; accepted message/event identity and TTL/cancel authority preserved.
- [ ] Existing runtime safe revalidation after pool revision, through real selection and final admission; strict stale-allocation and revocation guards remain.
- [ ] Real entry-point regression tests: bootstrap/established, changed/unchanged, multi-batch restart, failed promotion, concurrency/stale publisher, lost continuation, 24h independence, membership/revocation, wake automatic recovery/cancel/TTL/no duplicate authoritative handoff.
- [ ] Docs synced; focused + full quality checks pass.
- [ ] Local Cloudflare, security, test, constitution, documentation and task-completion review completed and addressed.
- [ ] Real coordinated staging VM chain verified, Instant compatibility retained, resources cleaned.
- [ ] Draft PR/CI/best-effort CodeRabbit evidence; coordinator final diff + full-SHA gate.

## Evidence

Pending. No release authorization for a concrete SHA yet.
