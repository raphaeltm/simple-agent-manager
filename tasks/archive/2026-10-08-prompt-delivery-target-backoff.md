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
- [x] Lint/typecheck/tests/build; local specialist reviews and task completion audit.
- [x] Claim shared staging lease, deploy and verify, clean up and release.
- [ ] PR/CI/CodeRabbit request-and-wait, merge, production deploy.
- [ ] Compare production GraphQL root alarms and periodic rowsRead before/after; append PR/evidence to idea and complete only after deployment and verified improvement.
- [ ] Publish MERGED and DONE, cancel subscription cd6274cb-ca5c-40ac-9c6e-1b6bcdb8eced.

## Rules
62 real-trigger and controlled-order testing; 76 billed metrics; 31 additive migration safety; 25 review/merge gate. Shared staging lease and migration claims follow channel kickoff.

## Validation and recovery evidence

- Local specialist reviews completed: Cloudflare/constitution PASS, docs PASS, task-completion/test engineer ADDRESSED (candidate-limit test added and approved).
- Full lint/typecheck/build passed on the implementation; web336 files/4,023 tests and other completed package suites passed. Sleep interrupted the first API run, so no success was attributed to that incomplete run.
- Integrated main90cbf4ea4 (#2277/#2280) without conflicts. Restored API full suite:830 files/11,652 tests; only failure was the old index-count fixture126 versus actual130. Corrected in91de6b446; migration/busy-target/upgrade rerun26/26PASS, other11,651 tests passed.
- Three Workers regression files passed6 tests before recovery, covering preparation, recipient starvation and measured query cost. Guard-removal checks failed as intended and were restored.
- Additional billed baseline13:00–14:00UTC October8: root705 alarms, root46,497,540 periodic rowsRead; account46,580,706 reads. NOMEM task later disabled production grouped-FTS cleanup as a temporary stopgap; refresh immediate pre/post windows and distinguish that change from this one.
- PR[2272](https://github.com/raphaeltm/simple-agent-manager/pull/2272) was auto-opened by SAM, then closed pending required staging. Review/measurement evidence is preserved in its body; reopen only after staging passes.
- Coordination update: channel notifications did not wake sleeping runtimes. Use direct peer handoff and a <=45-minute fallback scheduled self-message before yielding. Queue is Instant → failed-wake → noise → latency → this task → VM-boot retry; never deploy under another lease. Preserve NOMEM-owned production FTS override.

- Final current-main checks: API lint/typecheck/build and DO migration safety PASS; Workers rerun3 files/6tests PASS in73.80s. No code changes required after main integration; only migration-count fixture corrected. Local implementation validation complete; staging/merge/production acceptance remain open.
- Integrated NOMEM fix #2269/main ef0e38a53 cleanly (merge3b5a3b445). Rechecked26 migration/delivery unit tests and30 tests across four Workers files, including storage-safety alarms: all passed. The NOMEM owner removed its temporary production override for the fixed-main rollout; do not deploy an older commit with cleanup enabled.
- Queue update77 inserts expiry follow-up immediately after this task. On staging release, send a direct message to task01M4DV3VH64H7NWXCZ8YXJDKMN in addition to the channel release event.

## Staging verification

Lease112 deployment[37842526334](https://github.com/raphaeltm/simple-agent-manager/actions/runs/37842526334) passed including smoke, candidate c542e5dc7; Worker c91ecb6a-f29b-47fe-bf32-77aeca58fa03. One2vCPU/4GB cx23 VM heartbeat21:03:14, ready21:05:04. Initial early submission failed admission before workspace creation; a new conversation on the same ready node passed. Three follow-ups queued during the real busy prompt:18 snapshots showed both trailing messages at zero attempts. First acknowledgement observed21:10:24, before prior retry deadline21:11:18; all three acknowledged21:10:40. Assistant transcript contains each numbered marker exactly once in order. Dashboard/projects/settings/chat HTTP200, no page errors or horizontal overflow, screenshots reviewed. Both own chats stopped, workspace/node deleted, D1 rows absent and active count0; borrowed project/profile/pool unchanged. Release115 published, direct handoff to failed-wake owner sent.

Evidence: `tasks/evidence/2026-10-08-prompt-delivery-staging.json`. Refreshed post-NOMEM baseline19:00–20:00UTC:491 root alarms,23,879,655 root rowsRead,24,280,527 account rowsRead; raw five-minute groups in `tasks/evidence/2026-10-08-prompt-delivery-before.json`. Cost tool reran successfully. Production acceptance remains pending.
