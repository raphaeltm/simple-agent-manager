# Resource-history upload correctness

SAM task 01M473KNZ9WXZ0X4G3Z743X2C1; Idea 01M467A56CDK9B28TCWZZYBF23.

## Problem and research

Concurrent final flushes pass the chunk read, both increment the summary, and the losing insert deletes the shared R2 object. Collector removal before Stop and unsynchronized spool retry permit duplicate uploads. Main 0366b17d9 still contains this defect; matching open PR/active duplicate absent. Other active resource-history tasks are older shipped timeline/attribution work (git log confirms). Coordinate staging with capacity and sleeping-visibility siblings.

## Checklist / acceptance

- [x] Real callback-route SQLite regression: controlled duplicate overlap; success twice, one row/delta, retained object.
- [x] Concurrent checksum conflict returns 409 and preserves winner bytes; rollback/failure retry controls.
- [x] Atomic D1 chunk insertion plus conditional summary update; immutable upload object ownership and safe failure cleanup.
- [x] Serialize collector spool upload; prevent restart during Stop; Go race tests including final flush.
- [x] Read-only production summary and R2 existence audit; concrete guarded repair plan, seek approval before irreversible changes.
- [x] Required lint13/13, typecheck19/19, root tests21/21 (API11383; web4023), build9/9; full Go and targeted race tests.
- [x] Independent Cloudflare/Go/test/constitution/completion implementation review; findings addressed. Final workflow review remains required before archive.
- [ ] One coordinated bounded staging deploy and real VM heartbeat/access/final flush; cleanup.
- [ ] Draft PR until gates pass; CI, best-effort CodeRabbit request/wait, merge, production deploy monitoring.
- [x] SAM Idea follow-up for full seven-day postdeploy zero-error/count mismatch check: `01M475RGQFE39D940WDJVEGA2N` (window starts at successful production deployment).

## References

.do-state.md; /do workflow; rules 13, 14, 25, 35; apps/api and packages/vm-agent AGENTS.md. User requests Sol; no GitHub issues. Keep repair approval separate from code merge.

## Evidence / current state

Controlled callback-route races failed original main with 500 for both identical/conflicting payloads; fixed tests passed. SQL fixtures now enforce immediate summary FK and R2-key uniqueness. Chunk failure rolls back summary; commit followed by response loss retains its R2 object, and retry returns idempotent. Batch errors retain uncertain attempt objects; explicit workspace/project prefix cleanup can remove these, and periodic indexed-chunk retention is unchanged.

Production read-only audit at 2026-10-05T22:51Z: 45 mismatched summaries; 4,248 excess samples, 213 excess tool spans; all first/latest chunk rows retained; earliest raw expiry is still in future. 444 associated indexed chunks: 403 objects present, 41 missing (full-bucket paginated list confirmed narrower per-workspace scan). Count audit snapshot and missing chunk IDs are companion JSON artifacts. No production mutations.

`2026-10-05-resource-history-repair.sql` is a PROPOSAL ONLY: 45 parameter-free exact-ID updates guarded by snapshot timestamp/counts, first/latest chunk presence, exact retained chunk count and sums. No D1 chunk/R2 deletion, no fabricated raw data. Require explicit approval; take fresh backup/snapshot and rerun audit first, execute through a D1 binding `db.batch` of45 prepared statements (sequential CLI/API calls are not a substitute), verify all45 updates and zero eligible mismatches afterward. A D1 batch is atomic for SQL errors but a zero-row guarded UPDATE does not abort it: inspect every statement’s change count. If any target became ineligible, record the exact applied subset, stop, and re-audit; rollback only that subset with separate approval and unchanged inverse guards. Never relax guards. Companion `repair-dry-run.sql` selects exact guard-eligible targets; `repair-backup.sql` exports complete target summary/chunk rows to a timestamped restricted artifact (hash and retain it); `repair-rollback.sql` restores original counts only while timestamp, post-repair counts and chunk totals remain unchanged, and requires separate approval. Local in-memory SQLite verified 45 dry-run matches, 45 summary/444 chunk backup rows, 45 forward and inverse changes, exact original restoration and refusal after timestamp drift. Counts-only repair does not repair weighted means or additive IO/gap/OOM metrics; those need separately reviewed reconstruction from chunk summary JSON before an expanded repair. For the41 missing objects, retain their indexed chunk rows and the exact missing-ID list; do not delete evidence or fabricate payloads. Before proposing any object restoration, check surviving VM spools/backups and require candidate bytes to match the indexed SHA-256, format and counts. Without matching bytes, record the historical raw-history loss; missing raw objects cannot be reconstructed from summaries alone. Any restoration or completeness-metadata change requires a separate approved proposal.

Review findings addressed: join cancelled collector loop before final flush; concurrent Stop waits for completion; retain server tombstone through deletion; reject missing authoritative runtime; atomic spool publication; directory-level serialization covering publish/upload/remove/budget.

Independent specialist evidence: Cloudflare/API + test engineer PASS,17/17 independent focused tests. Go specialist PASS, independent targeted race tests for collector and server passed. Completion/constitution/docs review: implementation no blockers; workflow staging/full-check/PR gates pending; count audit snapshot wording corrected.

## Bug post-mortem

Introduced by c97d00ec0 (per-workspace resource history, #2110): the original service wrote one deterministic R2 key, independently incremented the summary, then inserted the chunk. A losing insert deleted that shared key. Concurrent collector final flush/retry made this state interaction race observable. Sequential mock tests hid both D1 transaction/FK behavior and ownership races. This change adds controlled real callback-route SQLite ordering, checksum-conflict controls, immediate FK constraints, rollback/lost-response cases, and Go race lifecycle tests. The regression tests are the concrete prevention measure; no broader standing guidance is needed.

Quality evidence: root lint13/13 and typecheck19/19 passed; complete VM-agent Go suite passed, plus targeted race checks. All resource-history API tests29/29 passed. Root build9/9 and full root JavaScript tests21/21 passed (API816 files/11383 tests; web4023 tests); an initial paused run hit worker startup timeouts and was restarted cleanly. Shared staging candidate is isolated from this PR branch and will combine independently reviewed siblings; live validation and workflow gates must be recorded before completion.

Independent repair-artifact review PASS: all 45 dry-run predicates equal forward predicates; both backup queries use exact target IDs; inverse SQL changes only before/after counts. Independent SQLite dry-run/backup/forward/rollback and timestamp-drift controls passed. No production mutations.

## Shared staging evidence (in progress)

Pinned integration `2613b82d02afe0c10a229b236055adcb979085c7` deployed successfully, including smoke, in [run37389450160](https://github.com/raphaeltm/simple-agent-manager/actions/runs/37389450160). It contains reviewed resource-history runtime `4f83d6a7287c4c34fff480dc78cf9cac269840aa`, capacity `65dfc2ca7f148cc08dd8de5bc0804828f22ee3a4`, and sleeping visibility `7041c6a4dafb13c734df7d40577478f197a6fec2` plus test-only fixture correction. Each feature PR retains its own scope. Combined focused63/63 and API typecheck passed. Immediately before deployment, both active workflows and live usage were checked; only the owned old-agent fixture was active.

Playwright dashboard/projects/settings loaded fully with no page errors; sleeping chat header and node page also loaded. The chat capture does not establish transcript rendering. Genuine old-agent callback uploads use new attempt UUID R2 keys after deployment; the final-flush chunk contains138 samples. All four chunks pass raw checksum/decode detail reads, and the summary680 samples/5 tool spans exactly equals chunk sums.

The old-agent capacity admission, deadline preservation and busy missing-intent controls passed. First normal sleep capture timed out after a150-second home-upload progress gap; its previous committed snapshot remained authoritative. The normal second attempt succeeded at2026-10-06T00:21:44.095Z with a full non-degraded snapshot and expected Git HEAD. Runtime deletion was confirmed at00:26:49.018Z under the existing five-minute TTL. Upload timing evidence was added to existing SAM Idea `01M0VZ205TN8A1JYHNJN77DS4F`; no unrelated runtime change.

Node warm retention remains30 minutes from00:21:52.108Z, earliest retirement00:51:52. Cost is bounded to one occupied host and sequential replacement, conservative<=EUR0.05 withinEUR0.10 (including per-server hourly rounding: four charged cx23 hours=EUR0.0352; [primary billing FAQ](https://docs.hetzner.com/cloud/billing/faq/)); coordinated cleanup deadline01:20UTC. Fresh-agent heartbeat/access, collector final-flush/restart, sibling wake/stop controls and final cleanup remain pending. No policy, idle deadline or production data overrides. Physical provider inventory is unavailable in this environment; qualify direct inventory claims and retain lifecycle/provider termination receipts.
