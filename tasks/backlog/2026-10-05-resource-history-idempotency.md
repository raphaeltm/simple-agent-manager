# Resource-history upload correctness

SAM task 01M473KNZ9WXZ0X4G3Z743X2C1; Idea 01M467A56CDK9B28TCWZZYBF23.

## Problem and research
Concurrent final flushes pass the chunk read, both increment the summary, and the losing insert deletes the shared R2 object. Collector removal before Stop and unsynchronized spool retry permit duplicate uploads. Main 0366b17d9 still contains this defect; matching open PR/active duplicate absent. Other active resource-history tasks are older shipped timeline/attribution work (git log confirms). Coordinate staging with capacity and sleeping-visibility siblings.

## Checklist / acceptance
- [ ] Real callback-route SQLite regression: controlled duplicate overlap; success twice, one row/delta, retained object.
- [ ] Concurrent checksum conflict returns 409 and preserves winner bytes; rollback/failure retry controls.
- [ ] Atomic D1 chunk insertion plus conditional summary update; immutable upload object ownership and safe failure cleanup.
- [ ] Serialize collector spool upload; prevent restart during Stop; Go race tests including final flush.
- [ ] Read-only production summary and R2 existence audit; concrete guarded repair plan, seek approval before irreversible changes.
- [ ] Required lint, typecheck, tests, build.
- [ ] Independent Cloudflare/Go/test/constitution/completion review; address findings.
- [ ] One coordinated bounded staging deploy and real VM heartbeat/access/final flush; cleanup.
- [ ] Draft PR until gates pass; CI, best-effort CodeRabbit request/wait, merge, production deploy monitoring.
- [ ] SAM Idea follow-up for full seven-day postdeploy zero-error/count mismatch check.

## References
.do-state.md; /do workflow; rules 13, 14, 25, 35; apps/api and packages/vm-agent AGENTS.md. User requests Sol; no GitHub issues. Keep repair approval separate from code merge.
