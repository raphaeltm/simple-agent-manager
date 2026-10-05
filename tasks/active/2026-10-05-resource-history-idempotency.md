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
- [ ] Independent Cloudflare/Go/test/constitution/completion review; address findings.
- [ ] One coordinated bounded staging deploy and real VM heartbeat/access/final flush; cleanup.
- [ ] Draft PR until gates pass; CI, best-effort CodeRabbit request/wait, merge, production deploy monitoring.
- [x] SAM Idea follow-up for full seven-day postdeploy zero-error/count mismatch check: `01M475RGQFE39D940WDJVEGA2N` (window starts at successful production deployment).

## References
.do-state.md; /do workflow; rules 13, 14, 25, 35; apps/api and packages/vm-agent AGENTS.md. User requests Sol; no GitHub issues. Keep repair approval separate from code merge.

## Evidence / current state
Controlled callback-route races failed original main with 500 for both identical/conflicting payloads; fixed tests passed. SQL fixtures now enforce immediate summary FK and R2-key uniqueness. Chunk failure rolls back summary; commit followed by response loss retains its R2 object, and retry returns idempotent. Batch errors retain uncertain attempt objects; explicit workspace/project prefix cleanup can remove these, and periodic indexed-chunk retention is unchanged.

Production read-only audit at 2026-10-05T22:51Z: 45 mismatched summaries; 4,248 excess samples, 213 excess tool spans; all first/latest chunk rows retained; earliest raw expiry is still in future. 444 associated indexed chunks: 403 objects present, 41 missing (full-bucket paginated list confirmed narrower per-workspace scan). Count audit snapshot and missing chunk IDs are companion JSON artifacts. No production mutations.

`2026-10-05-resource-history-repair.sql` is a PROPOSAL ONLY: 45 parameter-free exact-ID updates guarded by snapshot timestamp/counts, first/latest chunk presence, exact retained chunk count and sums. No D1 chunk/R2 deletion, no fabricated raw data. Require explicit approval; take fresh backup/snapshot and rerun audit first, execute as one D1 batch, verify all 45 updates and zero eligible mismatches afterward. Zero-row updates require re-audit rather than removing guards. Counts-only repair does not repair weighted means or additive IO/gap/OOM metrics; those need separately reviewed reconstruction from chunk summary JSON before an expanded repair. Missing raw objects cannot be reconstructed from summaries alone.

Review findings addressed: join cancelled collector loop before final flush; concurrent Stop waits for completion; retain server tombstone through deletion; reject missing authoritative runtime; atomic spool publication; directory-level serialization covering publish/upload/remove/budget.

Independent specialist evidence: Cloudflare/API + test engineer PASS,17/17 independent focused tests. Go specialist PASS, independent targeted race tests for collector and server passed. Completion/constitution/docs review: implementation no blockers; workflow staging/full-check/PR gates pending; count audit snapshot wording corrected.

## Bug post-mortem
Introduced by c97d00ec0 (per-workspace resource history, #2110): the original service wrote one deterministic R2 key, independently incremented the summary, then inserted the chunk. A losing insert deleted that shared key. Concurrent collector final flush/retry made this state interaction race observable. Sequential mock tests hid both D1 transaction/FK behavior and ownership races. This change adds controlled real callback-route SQLite ordering, checksum-conflict controls, immediate FK constraints, rollback/lost-response cases, and Go race lifecycle tests. The regression tests are the concrete prevention measure; no broader standing guidance is needed.

Quality evidence: root lint13/13 and typecheck19/19 passed; complete VM-agent Go suite passed, plus targeted race checks. All resource-history API tests29/29 passed. Root build9/9 and full root JavaScript tests21/21 passed (API816 files/11383 tests; web4023 tests); an initial paused run hit worker startup timeouts and was restarted cleanly. Shared staging candidate is isolated from this PR branch and will combine independently reviewed siblings; live validation and workflow gates must be recorded before completion.
