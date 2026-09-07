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

### Subsequent E1 deletion evidence

A subsequent read-only production query found E1 workspace marked deleted with `runtime_deletion_confirmed_at=2026-09-07T08:28:41.543Z` and `runtime_deletion_proof=vm_agent_confirmed`. The snapshot still has pending status, no WIP/home artifact, and last update08:15:00.691Z. Neither recovery coordinator initiated a lifecycle action. The peer confirms it has no established authorized remote filesystem/snapshot export path; its own recoveries used pushed commits and transcript context only.

The checked source maps successful workspace DELETE or workspace-specific404 to vm_agent_confirmed. The VM deletion handler attempts container and named-volume removal, but logs volume-removal errors and still returns success. Consequently, the persisted proof establishes reported runtime deletion, not an independently verified inventory of surviving host volumes. No verified source backup or accessible restoration path exists; do not claim either successful preservation or proven physical erasure of every residual file. Keep the shared node untouched. Any fresh channel implementation must start from the pushed parent and full acceptance contract, with transcript fragments treated only as context.

### Cross-workflow migration reservation

Node-pool A5 task `01M1XFJSHZV180T9WTWDQZJGQC` owns D1 migration0153 for additive `capacity_pools.selection_digest`. Eventing A4 retains D10152 if needed; no known eventing0153 claim exists. A4/C2/D1 received durable notices to disclose unpublished collisions immediately. Coordinate every future D10154+ allocation between node-pool coordinator `01M1XCX05TQTRK3E4Y9JN1HAPW` and eventing coordinator `01M1XCYS20J34FTHZ0AB5G5M8W`. ProjectData DO migration numbers remain separate. No staging or host action is authorized by this reservation.

### Fresh member API checkpoint

The recovery parent now implements E1 from the pushed integration branch. `GET /api/projects/:projectId/event-subscriptions` accepts `state`, `limit`, and `sessionId`; the session predicate runs in canonical SQL before the row limit. `GET /:subscriptionId` inspects the project-bound subscription. `POST /:subscriptionId/cancel` accepts only optional `reason`, derives human attribution from authenticated identity, and rechecks active `task:write` membership after the DO lookup. Viewers have `task:read`; policy/system/standing-watch subscriptions retain their separate authority. Canonical cancellation remains idempotent and revokes pending delivery/read access. DO048 currently adds only member-list indexes; full channel schema and atomic catch-up remain outstanding.

Initial six real migrated-D1/ProjectData tests passed after correcting fixture installation identities. Shared build and API typecheck passed. Independent scoped security review found no blocker. Combined production-router authentication and human-owned cancellation tests were added for the final rerun. This is a reviewable partial checkpoint, not full E1 acceptance.

D1 submission task changed to completed at08:55:45 with a test-engineer CHANGES REQUIRED summary and unchangeda9173a095. Parent findings remain unresolved. A durable follow-up was rejected because the task is terminal, while read-only production D1 still reports its workspace and agent session running. No duplicate continuation or lifecycle mutation was started; terminal task metadata alone does not prove all execution stopped.

Final member checkpoint validation:8/8 real Worker tests pass, including requests through the combined production router that require browser authentication. Targeted ESLint, shared build, API typecheck, additive DO migration safety and diff-check pass. Independent source security review PASS applies to the member routes only. The independent channel design critique requires strict shared fanout admission, immutable cursor/checkpoint expiry, conservative deletion-frontier checks, protected channel generation while followers exist, and explicit accounting of catalog retention writes; full channel implementation is not yet accepted.

### Channel implementation checkpoint (validation pending)

Fresh E1 now wires the five MCP tools and member catalog/history REST routes to canonical ProjectData events and subscriptions. Schema048 is still unreleased and now adds indexed channel generation/sequence fields and nullable subscription catch-up checkpoint fields. Catalog counts are explicitly lifetime-only. No deletion trigger, secondary event queue, or cascading checkpoint table is added. Catch-up validates consecutive sequence numbers and the snapshot tail before committing a page; history discloses retention gaps. Live filters use stable channel names; history cursors use generation IDs. Empty catalog reclamation excludes retained events and active unfinished catch-up, so it never breaks live name-based subscriptions.

A single fixed-window per-project publish counter bounds rate state independently of retention. Stable chat/channel idempotency uses SHA-256 identities; retained replay bypasses capacity and rate charging, while changed content conflicts. Strict canonical matching rejects candidate/fanout overflow transactionally, including generic subscriptions. Shared default/env/docs and API/MCP contracts added.

Initial four-case real-MCP/D1/DO suite:3passed/1failed because the existing agent identity resolver does not recheck project membership. Channel service now explicitly requires current project task:read/write capability. Two asynchronous expected DO errors also surfaced as workerd unhandled test errors; negative cases now catch inside the real DO invocation, retaining actual operation/storage behavior. Revised suite is still running; this checkpoint is NOT accepted or green. Earlier API typecheck covered the initial storage modules only; complete current source typecheck/lint, fanout/rate/cardinality/expiry/retention scan tests and independent code review remain required.

# Recovery continuation and E1 review fixes (2026-09-07, 10:15 UTC)

## Parent execution and channel validation (10:48 UTC)

Raphaël explicitly stopped further SAM dispatching and directed the parent to finish implementation. Local subagents may write files; all existing eventing subtasks must commit and preserve their work before being stopped. Commit/push/idle instructions were sent to A5/C3/D2. No child has been stopped before checkpoint verification. This supersedes the prior durable dependency-wait plan. The policy tool rejected the new policy because the project already has 100 active policies; the explicit direction is saved in knowledge and local workflow state.

E1 validation now passes: final API typecheck; targeted API/shared ESLint; non-destructive DO migration safety; 16 channel Worker cases, plus the 8 unchanged member Worker cases from the preceding run. The preceding 24-case run had 23 passes and one missing test import after fixture extraction; restoring `storeMcpToken` and rerunning all 16 channel cases passed. Browser/member authorization, all-five MCP revocation with unchanged durable state, whitespace-key follow retry, current recovery-task attribution, strict fanout rollback, catch-up, retention gaps, catalog recreation/cleanup and deep indexed history are covered with actual D1/DO storage. Expected invalid-cursor exception diagnostics appear in the Worker log; no test or unhandled-error failure remains in the final run.

Follow and catch-up now return the ordinary subscription checkpoint/end-turn instructions when persisted delivery resolves to prompt delivery, and null for record-only. The instruction helper is shared with ordinary creation, documented, independently security-reviewed, and covered through real MCP. CF/security/test source reviews all scoped PASS. These checks accept this backend slice locally; credential/core/submission integration, schedules/watches, UI, full final validation, staging and the single green unmerged PR remain required.

Latest published channel checkpoint is `7b8802559`; current review fixes remain pending final focused validation. API typecheck after the authority/expiry/cleanup changes passed. The expanded 21-case real D1/DO member/channel worker run is in progress; no full E1 acceptance is claimed yet.

Both independent reviewers found the same whitespace-key edge after the first corrections: follow prelookup used the raw key while canonical creation trimmed it, allowing a changed default expiry on replay. The lookup and creation now share canonical `normalizeText` with the same configured limit; the delayed real MCP retry case uses a whitespace-bearing key. Cloudflare review independently proved the repaired catalog cleanup advances past retained entries with a one-row budget, deletes later empty entries, and uses the covering tuple index. Final scoped re-review is pending.

The current changes also recheck real D1 task/workspace/user/member/agent authority after asynchronous publication hashing, then validate the active canonical chat identity synchronously with mutation. Publisher provenance uses the current recovery task. Omitted follow expiry preserves the initial canonical expiry on retries; omitted delivery defaults to record-only. Cleanup progress commits separately from publication admission, so capacity failures cannot starve later candidates. Tests cover retained-history gaps, catalog regeneration, historical fanout rollback, checkpoint expiry, UTF-8 limits, strict canonical live fanout, and deep indexed history scans.

C2 is now authoritatively failed at 09:56 with `workspace_missing`, not a proven provider usage limit. Its newer pushed checkpoint `c80f8ff3a2aca2ec27ac768b880e4f6c4b1e85c6` was fetched. D1 remained completed with reviewer-only CHANGES REQUIRED at `a9173a095`; production task workspace associations are now null, and direct lookup of the former D1 workspace returns no row. These observations do not establish physical deletion or filesystem preservation. No lifecycle/export/host action was performed here.

After inspecting both sessions and the active task list (no duplicate implementations), fresh continuations were dispatched from their pushed branches with the verified explicit Backend Implementation profile and cf-container runtime to avoid the preserved shared VM node:

- D2 `01M1XNM58MT27P2YGG8CF9E1Z2`, branch `sam/finish-reserved-task-submission-f9e1z2`, session `76674685-1cca-49ed-bbaf-1193b6aaace0`: ordinary submission final authority, rejected cleanup revocation, uncertain winner classification, and physical initial prompt proof.
- C3 `01M1XNPM1Q2G941W82VV9Y4NV6`, branch `sam/finish-interrupted-credential-event-9y4nv6`, session `155bc358-d31d-4e7f-ac1c-cb886d6ad80d`: remaining credential/audience/outbox/Go/proxy contract from newest checkpoint.
- A5 `01M1XM41T3FHK3YGNJ4DC6ZNE5` remains the sole core recovery/wake/retention owner and received the new ownership boundaries.

D2/C3 both reached in-progress with actual assistant output. Read-only production joins verify both running agent sessions use explicit Backend Implementation `01KSWW2DQTZ8N3F2PYXKMJ7QZZ` and openai-codex, on separate cf-container nodes outside the preserved node. No new migration allocations: C retains D10146/DO047, E1 DO048, D2 D10149, schedules DO049, A5 D10152/DO050, node-pool D10153. Future D10154+ requires coordination. The final scheduled-actions backend, member UI, consolidated staging, one green PR and no-merge constraint remain outstanding.

Final scoped CF/security re-reviews PASS after whitespace-key normalization. Test-engineer review requested missing browser and five-tool authorization evidence; both have now been added using real D1/DO routes and canonical credential identifiers, with a distinct viewer and before/after canonical state assertions. Shared fixtures were extracted; the channel suite remains below the 800-line gate. Targeted ESLint with all new helper files and DO migration safety pass. The earlier mixed-version worker run loaded the old follow bundle before the normalization edit; its whitespace retry failed and 12 other channel cases passed. The outdated run was deliberately interrupted before accepting any aggregate result. A fresh frozen-tree run of 15 channel cases plus the existing 8 member cases, and updated API typecheck, remain pending at this recoverable checkpoint. This is not a full-green or final-integration claim.

## Parent implementation after subtask shutdown (2026-09-07)

User direction: no further SAM dispatches; parent implements directly, local agents write bounded files only. D2 final a83f7b648 was pushed and clean before stop. Stop returned cleanup warning; read-only records confirmed task cancelled and workspace/agent stopped. A5/C3 failed automatically with Instant checkpoint-restore errors before publishing new changes; failed workspaces untouched. Transcript snippets are context, not verified preservation of unpublished files.

Integrated pushed D2/A4/C2 checkpoints and repaired final recovery guards, credential receipt-first replay, per-window indexed supersession, and wake due-state maintenance. Recoverable commits: 409a5aa2b and b665fa6e1. Combined core/reserved Worker tests76 pass; credential/outbox focused56 pass; API typecheck passes at integrated base.

Parent implemented DO049 schedules/watches, versioned member APIs, five schedule MCP tools, canonical watch matching, shared alarm/mailbox, reserved task identities/deadlines, and real project/session Events UI. Focused schedules/recovery38 pass; real REST/MCP/DO Worker4 pass. Migration safety passes. Final type/lint/build/regression checks, desktop/mobile screenshots, coordinated staging, and green unmerged PR remain outstanding. No staging or host intervention.

## Local continuation after second parent runtime loss (2026-09-07)

Current task `01M1XX9PRA5XMACX3QNXTZQW0K`, output branch `sam/use-sam-mcp-tools-tzqw0k`. Read the exact prior session first with project-scoped MCP `get_session_messages`, then user-only full messages and original session `fd0d6dbe-e577-48f8-9bd9-bf6a4e92fcaf`. Restored pushed `c3e6b3d11`. Original scope remains one green OPEN PR; no merge, no SAM dispatches. Existing failed workspaces/hosts remain untouched. Local helpers work in this workspace only.

Local validation recovered two final handoff defects and found adjacent safety gaps:

- Preserve scheduled creator membership through VM recovery config and every TaskRunner guard; reuse the shared source guard instead of a duplicate weaker recovery query.
- Ambiguous/missing mailbox receipts retain standing-watch concurrency slots and stop automatic replay. D1 receipt lookup checkpoints retry before I/O and isolates failure so later schedules progress.
- Reserved scheduled/watch task starts revalidate current active creator and task-write capability before D1 creation and physical startup, while existing or uncertain receipts retain conservative reconciliation.
- Schedule inputs now obey effective reserved task prompt/label limits; retained schedule/watch record caps preserve replay identity and all conversation text. Public configuration/docs explain no automatic history pruning.
- Event subscriber source-user membership is being propagated through materialization/delivery/recovery; final focused verification pending.
- Mailbox capacity uses one bounded active-only indexed query in ordinary admission and event wake preflight. Additive DO migration053 installs the matching partial index; real workerd retained-history/rows-read proof pending.
- Go replacement connections clear stale credential attribution; originating connections retain immutable snapshots.
- UI browser audit reproduced and repairs long subscription-heading clipping, offscreen newly opened channel history, and misleading contextual watch scope/defaults. Final desktop/mobile sweep pending.

Evidence at this checkpoint: first corrected recovery/schedule run96/96 pass; seven new cases fail against saved pre-fix implementation (restored afterward). Reserved creator tests29 pass, and removing guard fails five denial scenarios while three valid-role controls pass. New schedule admission-bound tests5/5 pass. D1/DO migration safety pass before additive053. After consolidating source guards, one fixture required explicitly active users; final verification pending. File-size gate required extraction of materialization batch storage and reserved D1 submission storage, plus removing duplicate recovery guard.

Resource limitation: workspace4GB RAM/2GBswap. Per-agent serial jobs still overloaded it when run concurrently; one API typecheck exited137. All remaining heavyweight validation must be serialized across the WHOLE workspace. No OOM or stale pre-build test run counts as a passing result. Go1.26.6 installed in gitignored `.tmp/eventing/toolchain`; compile stopped to let browser/Worker validation finish. Full final lint/typecheck/unit/Workers/Go/build, independent acceptance review, staging decision/verification, screenshot publication, PR/CI/CodeRabbit remain required.

## Continuation checkpoint: API regressions and outcome controls

- Added member-authorized, payload-free delivery outcome inspection and lazy UI history with truthful transport/ack distinctions. Added canonical schedule execution receipts, versioned reconciliation, and explicit deadline/authority/queued-checkpoint-gated submission retry through REST, MCP and UI. Missing/ambiguous receipts retain watch concurrency.
- Replaced missing-batch anti-join scanning with an indexed, bounded candidate window and persisted tuple cursor (DO migration 054). Healthy suffixes advance at ordinary maintenance cadence, and `hasMore` only reports observed eligible work. Real workerd 1k/20k healthy-prefix/deep-seek read-cost tests pass; mutation/progress assertions are under repair before final validation.
- Restored explicit lifecycle source capture for TaskRunner failure and MCP completion. MCP captures before fallible downstream cleanup. Per-transition identifiers distinguish repeated failure of a requeued task; the centralized terminal transition still captures atomically in its D1 batch, while these two hook callers retain documented non-atomic capture.
- Full API baseline completed: 656/676 files, 9091/9152 tests passed. Repaired stale D1/auth/logger/terminal-proof fixtures and real lifecycle publication regression. Fresh focused rerun of all20 failing suites plus new recovery/terminal tests passed24 files/536 tests (`.tmp/eventing/api-tests-fixed.log`). No claim that full final suite is green yet.
- UI validation: original14 browser scenarios passed, six new delivery/recovery checks passed, final two delivery regressions repeated successfully. Both375x667 and1280x800;94 screenshots retained and18 new screenshots reviewed. Shared build, Vite build, focused lint and web+service-worker typecheck passed. These browser APIs were mocked. Additional public-site GitHub setup surface evidence is pending.
- Independent source review found and fixed credential-report coalescing across generations; blocked-reporter regression added, Go execution pending. Source review otherwise confirms current recovery/inspection/retention implementation closes prior gaps.
- Remaining: final Workers/Go checks, serialized workspace quality/build/type/lint/tests, final specialist evidence, one consolidated staging window and real canaries, one open green PR with durable screenshots and CodeRabbit review. No merge, SAM subtasks, staging deployment or resource mutation has occurred.

Follow-up validation: final focused Workers run passed91/94 tests across7 files. Delivery inspection, schedule receipt/recovery, reserved submission and10k mailbox capacity passed. Three retention assertions exposed physical SQLite index writes leaking into logical result counters; repaired/deleted counts now use RETURNING rows while the shared conservative write budget is retained. Existing orphan drain and a new dependency-safe attempt/match/batch/event budget-one scenario await repeat. Full Go ACP package with `-race` passed (`.tmp/eventing/go-acp-final.log`); full VM coverage run is underway. Public-site wizard/sidebar evidence tests are source-complete; source frozen for final format/build/typecheck/lint.


## Paused at user request — 2026-09-07

PR: https://github.com/raphaeltm/simple-agent-manager/pull/2031. Leave OPEN; DO NOT MERGE. Revisit during the week of 2026-09-14. User paused continued work because of usage cost. Stop local agents, tests, deployments and review loops; no automatic continuation or scheduled task was requested. No SAM subtasks were dispatched during this continuation.

Implementation is substantially complete, but the PR is not green. Last fully evaluated remote head: 288ae32dad9ca424b7923d1e1842b85baa4d5652, CI run34131964961. Latest source repairs are saved as an explicitly unvalidated checkpoint with CI skipped to avoid continuing work after the pause.

Verified before pause:

- Remote build/typecheck/lint and VM unit/integration/E2E/smoke checks passed. Local full VM coverage and ACP race passed before the latest test-only deduplication.
- Fresh focused API regressions:24 files/536 tests passed after repairing all20 suites that failed the initial full run. Latest focused native Workers results:95 tests across7 suites passed before the newest SQL/test dedup edits.
- Events browser runs:14 baseline,6 outcome/recovery and2 delivery repeat checks passed;94 PNGs retained. APIs were mocked, not live staging.
- Public-site mobile overflow was reproduced and fixed using shrinkable grid tracks and Astro global dt/dd selectors. The interrupted local128-case run logged125 passing cases, no failures, but no final aggregate completion. Log: /tmp/eventing-www-focused-browser.log. Do not claim128 passed.
- Latest local SQL AST and migration checks passed; full workspace quality earlier failed only the materialization file-size gate, now source-extracted but not rerun.

Saved CI remediation, not yet fully revalidated:

- Static SQL construction and literal migration probes; dead duplicate modules removed; shared Worker fairness fixtures and actual production TaskRunner DTO capture replace copied test machinery; Go usage reporter test helper deduplication. These need scoped tests and measured Sonar reanalysis.
- Two existing chat unit test wrappers now include MemoryRouter, addressing69 CI failures across2 files.
- Worker CI job budget15→30 minutes because the serial suite passed55/74 files before timeout. Matching workflow contract test updated; no test removal or sharding.
- Public-site CSS mobile fix. Sonar previously failed only duplication5.2% against3%; current refactors have not been reanalyzed.

Next work, in order:

1. Resume from this branch; inspect current git/CI and task records. Serialize ALL heavy validation across the4GB workspace. Do not restart the whole original investigation.
2. Format/scoped lint latest source; test2 web fixture files, Worker reserved submission/project-data-events/orphan retention/schedules, affected SQL/schedule/pull units, ACP race. Rerun failed file-size and workflow wiring gates, then final CI. Existing full build/type/lint evidence predates this checkpoint.
3. Secret Scan has an existing non-secret code identifier moved to a new line. Private review confirmed identical candidate bytes already on main. Review exact current AND PR-range locations, then extend the expiring exact-finding baseline per scripts/quality/README.md. Do not expose private reports, candidate material or hashes in PR/logs. Private scanner helper .tmp/eventing/private-scan.py is ignored, path-concatenation bug repaired; no new baseline entry yet.
4. Complete interrupted www browser run and remaining screenshot captures/review. Publish reviewed desktop/mobile images for every changed UI surface. Draft inventory .tmp/eventing/ui-evidence-body.md is stale for www; root artifacts .codex/tmp/playwright-screenshots/. Fix PR exact preflight checkbox, official-documentation wording, per-surface evidence and pending specialist rows truthfully.
5. One final staging deployment and REAL event/schedule/source/VM canaries remain entirely pending. No staging mutation or resource creation was done. Effective enabled platform Hetzner/Claude credentials were verified read-only; missing personal cloud credentials are not a blocker. Preserve all pre-existing resources. User's local-only constraint prohibits SAM delegation; no staging waiver was given.
6. Only after all non-CodeRabbit gates pass, apply coderabbit-review and resolve its findings. Keep one green PR OPEN and DO NOT MERGE. Final task-completion review is required before archive; task files remain active and unarchived.

Artifacts: .tmp/eventing/quality-results.json and quality-*.log, api-tests-fixed.log, workers-retention-fixed.log, go-acp-final.log, go-vm-final.log, CI failure logs and Sonar duplication metadata. These are workspace-local ignored files; durable source and this handoff are committed. No reliable completion-time estimate: full CI, live integration and external review can uncover more defects.
