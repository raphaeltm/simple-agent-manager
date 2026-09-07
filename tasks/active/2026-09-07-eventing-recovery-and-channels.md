# Eventing recovery and channel backend

## Context
Resume original task 01M1WH32RPJP2AMK0WARRRSZN5 under replacement task 01M1XCYS20J34FTHZ0AB5G5M8W. Original session fd0d6dbe-e577-48f8-9bd9-bf6a4e92fcaf was read directly before bounded message search. Original user instruction: "Address all of these in one PR and get it green please." The full acceptance contract remains `2026-09-06-eventing-delivery-scheduling-channels.md`, including all D/E work. No merge authorized.

Recovered integration 99b36c364 plus current main bef83db2d and final A3 8f1f537b4 is pushed on `sam/use-sam-mcp-tools-5g5m8w` at c07772fd5. A3 is integrated for review, not yet independently accepted. C2 credential repair, B4 outbox repair and D1 reserved submission remain active. F1 wizard repair and its browser/screenshot evidence are already integrated; do not redo it.

## E1 bounded backend slice
Implement channel publishing/catalog/history/catch-up and ordinary-member subscription inspection/revocation APIs. UI remains a separate dependent slice; this is not acceptance of full E.

- [ ] Build on canonical `project_events`, subscription/match/batch tables and admission/matching. No parallel event/message queue. Actor/project/chat/task/user identity is server-derived from the verified MCP caller, never arbitrary tool fields. Publishing is same-project and uses a reserved agent namespace with validation against impersonating GitHub/lifecycle/credential/platform sources.
- [ ] Provide bounded agent publishing through MCP with stable idempotency semantics, fixed provenance, payload/byte/rate/fanout/channel-cardinality bounds and shared default/env config. Reject changed-payload reuse; distinguish created/replay/conflict/capacity/invalid outcomes truthfully. External user-controlled data stays fenced as untrusted evidence, never operational wake wording.
- [ ] Maintain channel catalog summaries incrementally on committed admission, without hot aggregate history scans. Bound empty/old catalog cleanup, history page sizes, cursor size/format and queries. Clarify whether summaries count retained or lifetime events and preserve that definition under retention. Respect C2 audience visibility; channel endpoints must not become a backdoor for personal credential events.
- [ ] Implement an atomic history-to-subscription handoff within ProjectData with a stable watermark/cursor so publish interleavings cannot lose or double-deliver events. Reuse canonical match claiming. Define bounded catch-up for pages, snapshot/watermark, fresh subscription boundary, cursor expiry/retention gaps and replay semantics. Do not load unbounded history inside one transaction.
- [ ] Add ordinary-member REST catalog/history and subscription list/get/cancel controls using existing project permissions (task:read/write) and contextual session filters. Separate read/manage abilities; don't grant policy-owned subscription authority to agents or ordinary callers by pretending they are a privileged platform caller. Cancellation remains strong revocation under A3's canonical machinery. No route may accept forged project/owner/user provenance.
- [ ] Publish concrete shared DTOs and REST/MCP names early for future UI integration. Keep route/service/DO adapters focused and reuse existing auth, error, schema, cursor and transaction conventions.
- [ ] Add discriminating real workerd tests for publish/catch-up interleavings, replay conflicts, page boundaries, retention gap, bounded history with large prefixes, actor forgery, project isolation, personal-credential privacy, malformed cursors and cancellation. Route-level auth tests must exercise real permission handling. Stub only external boundaries.
- [ ] Sync canonical public docs, API reference and config docs. Run shared build, API lint/typecheck, focused unit/Workers tests, migration safety/order and file-size gates. Independent local Cloudflare/security/test review, fixing confirmed defects before handoff.

## Ownership and release constraints
E1 owns new channel files/types/tests plus narrow canonical admission hooks and member subscription route adapters. Additive DO migration **048** reserved for E1; do not duplicate or replace A3 DO046 or C2 DO047. Do not modify generic outbox, credential ingestion, recovery/task-runner interfaces, schedules/watches or frontend files. Coordinate narrow overlapping index/barrel/admission changes explicitly. D schedules will use DO049+ after E1 schema is available; migration numbering gaps must not crash migration-order checks in isolated child validation, and final integration must be contiguous.

No PR, main push, staging/deployment mutation, merge, or SAM grandchildren. Use existing explicit Backend Implementation profile, push early checkpoints and serialize heavy tests. Parent owns final all-slice review, one consolidated staging window, screenshots, green CI, CodeRabbit, and one unmerged PR. Return exact authored commits, callable interface contract, test counts, review evidence and limitations.

## Recovery tracking
- A3 01M1WZ3QMS0KXNGVEQRTPGCTKH: completed, merged for independent review.
- C2 01M1WSETCWYS4GAQ0WPBGN45KF: active credential/audience repair; extends A3 bodies, does not replace them with older helpers.
- B4 01M1X9RVXM759TG0NEMQRZTH3P: active canonical source-outbox repair, D10151 if needed.
- D1 01M1X0NWXR6D0PHAHCK6NZFA49: active reserved-submission/lifecycle repair.
- F1 01M1X58YFAN5TW99MR4DRJ96ME: complete and parent-validated, all commits integrated.
- D schedules/watches and E UI: outstanding; no feature completion claimed until original checklist passes.

## Recovery continuation checkpoint

Replacement parent restored original integration99b36c364, merged current mainbef83db2d and finalA3 for review, then integrated B4c1f417690 as92b94e02d and fixed its final budget/TTL edges in43b4f60eb. All changes are pushed on `sam/use-sam-mcp-tools-5g5m8w`.

Active A4 task **01M1XDRZSSYDQ5BAM0VTRSJ68B** on `sam/repair-verified-final-event-rsj68b` owns9independently reproduced final-A3 defects documented in the wake repair task, plus full original R6 canaries. Active E1 task **01M1XDHCVCHBHE6XAP44ENA6WQ** on `sam/implement-event-channels-atomic-ena6wq` owns the complete channel/member-API slice above. Both explicit Backend Implementation profiles were verified via production D1; VM/task/lightweight dispatch briefs preserve all constraints, and both emitted actual assistant output. A4 reserves additive DO050/D10152 if needed; E1DO048 unchanged; future schedulesDO049. C2 and D1 existing tasks continue without redispatch. No host/workspace deletion or retry occurred.

Parent verification: frozen-lockfile install and shared/providers/cloud-init builds passed;39coreWorkers tests passed (does not close the independently reproduced A3 gaps). B4 before final corrections53focused+24Workers passed; after corrections60focused+13Workers passed, API typecheck, targeted ESLint, source-contract gate1288files and diff-check passed. Independent final B4 CF/security/constitution/env review passed the scoped corrected functions against real migrated SQLite. C2-owned generation/audience/producer composition still requires integration/review. Both local A3 reviews are CHANGES REQUIRED and tracked in A4, not silently accepted. F1 browser evidence remains preserved in the source repair task.

Next: consume active C2/D1/A4/E1 handoffs, preserve A4 current helper bodies while composing C2 audience and D1 guards, then implement original D schedules/standing watches and E2 real project/session UI. Do not skip full validation/independent review/consolidated coordinated staging/desktop+mobile screenshots/green CI/iterative CodeRabbit. Deliver one unmerged PR. Parent registers durable wait key `recovery-await-core-credential-submission-channels-v1` for those4active tasks with conditionany and600second deadline so follow-up work resumes without keeping this runtime polling. No PR or staging started at this checkpoint.


## Channel interruption during recovery

E1 task `01M1XDHCVCHBHE6XAP44ENA6WQ` failed with the provider's `usageLimitExceeded` error before a recoverable output-branch checkpoint. At the recovery check, GitHub has no `sam/implement-event-channels-atomic-ena6wq` head. The transcript records initial channel/DTO/migration048/REST/MCP edits and dependency installation, then interruption during API typecheck; no completed test or review evidence exists. Read-only production checks found workspace `01M1XDSQT4QA31E2R8BCM3ZFZY` stopped and its snapshot pending with no WIP or home artifact. Full unpublished source recovery remains unresolved; transcript readbacks are partial and must not be represented as a complete backup.

No workspace/node retry, deletion or host mutation was performed. The concrete preservation issue was sent to the node-pool recovery coordinator. A4/C2/D1 remained active and received checkpoint/check-in messages; do not duplicate their work. Parent is reviewing pushed C2/D1 candidates while preservation is coordinated. The resolved durable wait453a7a36 must be replaced with a new wait key for the next wait. Full E1 scope above remains outstanding.
