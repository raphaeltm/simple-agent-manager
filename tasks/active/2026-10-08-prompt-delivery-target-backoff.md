# Stop ProjectData prompt-delivery busy retry storms

Task: 01M4DV35FAXHVH6R9SY62DR1B3. Idea: 01M27M86R544BQX86VZANZGSQ2.

## Problem and evidence
Busy recipients retry queued messages and repeatedly scan the mailbox. Production GraphQL captured 2026-10-08 13:30:52 UTC: root object dd1dc7854bfe6d171cb7db70805b7dc3262566c4b685217736bd43af61d59960 had 23,800 alarms October 7. Account periodic rowsRead: Oct1 525,220,529; Oct2 384,001,083; Oct3 297,714,085; Oct4 293,462,530; Oct5 474,992,575; Oct6 850,219,754; Oct7 1,164,269,965. October 8 completed hourly root counts were 168–372; distinguish improvements already shipped from this change. `pnpm quality:cloudflare-cost` ran successfully; projected account usage-derived estimate $8.08, DO rowsRead 17.67B/month at seven-day rate (not invoice cost).

## Research
- prompt-delivery.ts: claims, expiry, alarm query and attempt-fenced results. Current #2262 head-of-line guard already stops simultaneous same-target claims; preserve priority, FIFO ties and stale receipt reconciliation.
- durability-foundation.ts drives real alarm delivery with independently running claims.
- prompt-delivery-runner.ts applies busy results after async preparation; idle/turn-end nudge can arrive at this midpoint.
- session-activity-reconciliation.ts and durability hooks already nudge target delivery when turn ends; wake readiness has attempt fencing.
- #2266 project-event materialization recipient isolation must remain untouched.
- DO migration 062 claimed on reliability-wave-1008 before implementation; 059 retired, 061 latest.

## Implementation and acceptance
- [x] Durable per-target exponential busy backoff, independent of capped per-message attempt ordinal, released by idle/turn-end signals.
- [x] Cheap index-backed queue head/due/expiry lookups; bounded candidate claims and no retained-history scan.
- [x] Preserve priority/FIFO, no drop/duplicate, single-flight and independent recipient progress; urgent controls remain usable.
- [x] Real delivery alarm tests with many queued messages, controlled busy/idle midpoint, bounded attempts/alarms, eventual ordered exactly-once acceptance.
- [x] Test migration upgrades and clean installs; guard discrimination and real Workers SQLite query cost.
- [ ] Lint/typecheck/tests/build; local specialist reviews and task completion audit.
- [ ] Claim shared staging lease, deploy and verify, clean up and release.
- [ ] PR/CI/CodeRabbit request-and-wait, merge, production deploy.
- [ ] Compare production GraphQL root alarms and periodic rowsRead before/after; append PR/evidence to idea and complete only after deployment and verified improvement.
- [ ] Publish MERGED and DONE, cancel subscription cd6274cb-ca5c-40ac-9c6e-1b6bcdb8eced.

## Rules
62 real-trigger and controlled-order testing; 76 billed metrics; 31 additive migration safety; 25 review/merge gate. Shared staging lease and migration claims follow channel kickoff.
