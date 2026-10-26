# Production Durable Object read/write cost incident

> **Reconciliation 2026-10-26:** The incident fix shipped: #2368 (`761fe414d`) replaced the
> mailbox COUNT with an indexed existence check (`mailbox.ts:459-472`), scoped the event-wake lease
> lookup (`project-events-wake-delivery.ts:17-57`) and returned early for empty task waits
> (`task-wait-supervisor.ts:177`), with query-cost tests; production reads fell 92.6% (PR body,
> 2026-10-16 19:55 UTC). The two delivery boxes are now ticked. Still open, and tracked only here:
> the deferred `nextSequence` `MAX(sequence)` index (`messages-persist-helpers.ts:33-36`) and the
> proposal-only deterministic DO-usage anomaly alert (see the last section).

## Objective
Understand October15 monitored usage spike, ship the smallest safe causal fix through normal gates, and verify actual production metrics after reporting lag. Preserve data, active sessions, security and monitoring.

## Evidence (2026-10-16 UTC)
- PR2357 and2363 remain open drafts/unmerged. 2357's new counter/log DOs are absent from production; not a shipped fix or cause.
- Latest successful production run https://github.com/raphaeltm/simple-agent-manager/actions/runs/38907594785 at main7e8d6985829842897fcdca912a7a9a7413ecf963. CF live100%55714c04-891a-4ab2-8ba5-2b7e1de3ed31 uploaded13:35:31.
- CF periodic rows ProjectData Oct9 163981785read/1044058written; Oct14 495980679/960360; Oct15 2230149580/2527103; Oct16 partial15:54 3427059592/2368591. Oct14 available now; monitor missing-day status is not absent CF data.
- Oct15 all-namespace rows and31-day projection reproduce reads44.15USD and writes28.39USD using25B/50M monthly allowance and0.001USD/1M reads,1USD/1M writes. Projection, not invoice.
- Oct16 object breakdown main SAM root3.447Breads/1.661Mwrites; second project root2.128Mreads/649205writes. Archive shards each <=103kreads. Spike is overwhelmingly main root reads; archive migration is not dominant.
- Existing production alarm logs show empty task-wait passes24522reads and mailbox sweep9531reads. Schedule computations are outside section metering, so section logs undercount total work.
- Concrete amplification: computeMailboxAlarmTime counts every queued/delivered row each scheduling recalculation although only existence matters. updateNodeHeartbeats and many mutation paths recalculate; empty task-wait pass also recalculates unnecessarily before outer alarm recalculates again. Independent SQLite100kdelivered fixture COUNT300030VMsteps vs EXISTS25. Production contribution is unmeasured: mailbox sweep reads do not establish eligible queued/delivered row count. The earlier order-of-billions estimate is withdrawn; see the attribution correction below.
- Separate nextSequence MAX scans entire session due index(session_id,created_at,sequence).100k fixture500013VMsteps vs18 with new(session_id,sequence) index. Defer broad index until migration capacity justified: root9096073216bytes/10GB at15:55; extra~39MB/million raw messages, construction/write costs. Do not conflate with confirmed dominant cause.
- Local dependency install hit shared-host ENOSPC. Only this task's failed install/cache files were removed; validation completed through normal GitHub CI without reducing test scope.

## Implementation and acceptance checklist
- [x] Replace mailbox scheduling COUNT with indexed existence check, preserving due semantics.
- [x] Remove redundant no-mutation task-wait schedule recalculation, preserving mutation/failure scheduling.
- [x] Native Worker SQLite regression with large retained mailbox and full scheduler; bounded reads independent of history.
- [x] Test empty task waits call counts and due/failure/retry behavior.
- [x] Validate lint/typecheck/relevant suites/build and migration/security checks as applicable.
- [x] Independent specialist/completion reviews; all findings resolved.
- [x] Coordinate active owners2304/2305/reliability; staging on pinned SHA, verify behavior.
- [x] PR CI/Sonar/security and CodeRabbit request/wait; normal merge/deploy. (reconciled 2026-10-26: #2368 merged as `761fe414d`; CodeRabbit APPROVED `33f56e4`; production run 38948978780)
- [x] Verify deployed SHA/version, health, native per-call evidence and lagged comparable production usage; quantify remaining uncertainty. (reconciled 2026-10-26: #2368 "Production verification — 2026-10-16 19:55 UTC": Worker `0aab451b` at 100%, health 200, reads −92.6% in equal 15-min windows; sustained effect stated as uncertain)

## Coordination
Old coordinator01M50044HCHRVR12B4337721G5 failed; message rejected. Active owners01M52KPD9FDR724Z371666KAHE,01M4ZVWEGJ8WMFK69JNE7W7M5Y,2304owner01M52PEXV56VPD7H8541HP8EFJ,2305owner01M52PF30AYFJN0YM8KPQ8ME45 notified of owner incident priority. Accepted delivery is not acknowledgment.


## Refined evidence and scope (16:25 UTC)

User refinement prioritizes factual hourly trajectory and accrued monitored costs; monitor changes are proposal-only. Complete lagged account windows09–12 versus12–15UTC show reads804.7M→624.1M(-22.4%) with requests53,434→53,021(-0.8%). Latest complete hourly rate fluctuates with a decline overall, not acceleration. October reported DO totals12.73Breads/21.74Mwrites remain under25B/50M allowances: row overage0USD so far. Covered monitored accrued estimate~3.1USD includes approximate R2GB-day storage; it is not an invoice or total account cost. Original82.29USD is a single-day monthly projection.

**Attribution correction:** mailbox sweep9531reads does not establish9531eligible queued/delivered rows. Its other queries scan history. The mailbox fixture proves a scaling defect but its production share is unmeasured. Withdraw the earlier1.8B/day mailbox estimate as attribution; it depended on an unverified eligible-row count.

Stronger repeated scan identified: `readProjectEventWakeLeaseUntil` filters subscription and delivery-batch history by target session without the project prefix required by existing indexes. `computeReconciliationAlarmTime` calls it for each active task on every schedule recalculation. Exact SQL against1kexpired subscriptions+1kexpired batches takes3019+3016SQLiteVMsteps; binding project_id uses existing target indexes and takes25+38steps with identical lease result.11active candidates revisit~22krows per recomputation, consistent with observed24522scheduler shape; exact production table counts remain unavailable through current read-only analytics access.

Smallest additional fix: read immutable do_meta.projectId once inside the lease helper and bind it into both queries. Preserve original lookup if metadata is absent. No schema/index/storage migration, no cadence or security change. Cover the full scheduler with11active tasks and2kretained subscription/batch pairs,110lease queries, earliest pending/subscription lease, delivered read grace, strict expiry, cancellation and missing-metadata fallback in native Worker SQLite. Existing event-delivery tests retain end-to-end cancellation/authority coverage.

- [x] Project-scoped event-wake lease lookup reuses existing indexes for all callers.
- [x] Native11-active-task/retained-history row-bound and lease-semantic regressions pass.
- [x] Independent adversarial review confirms identity/fallback, expiry and cancellation behavior.

The platform created premature PR2368 on turn-end autosave; it was converted to draft and closed pending proper staging. Workflow state is now untracked and locally excluded. Source/evidence are preserved. Local host ENOSPC forced remoteCI. First native fixture failed only a1mswall-clock equality; bounds now bracket before/after time without loosening polling semantics. No production change shipped.


## Verified validation and release state (18:01 UTC)

Runtime candidate `3f1a9e364084fd825b253fa54bbbdf19693e5e6f` passed full manual CI38932497368, PR CI38939456250 (attempt2 after correcting a PR review-status cell), and fresh PR CI38942157989. Both native query-cost regressions and all three Workers shards passed. Independent Cloudflare/constitution/security review passed runtime11d445a11; independent test review passed final3f1a9e. Completion of the production incident remains pending.

Exact-runtime staging run https://github.com/raphaeltm/simple-agent-manager/actions/runs/38936399244 passed. All12 authenticated Playwright tests passed; missing-token skip step was skipped. Cloudflare served100% versionfde9ec18-1e57-4098-b59e-a0123a4e3fe8, uploaded17:11:17, matching the workflow. Live health200 at17:22:44. Natural alarm/RPC activity continued with no error-level logs in17:15–17:22; existing reconciliation/storage-telemetry warnings were present before and after, with two section-slow warnings after. No live synthetic load, VM provision, deletion or active-session mutation. Staging window explicitly returned to B17:24; B subsequently restored its own candidate. This is historical exact-runtime validation, not a claim that staging still serves this candidate.

PR2368 was reopened with correct3f1 head, causal description and evidence after staging. Sonar's successful quality gate for exact3f1 was later replaced by a cancelled GitHub app check117111066716 at17:43. Public Sonar PR API still reports that exact commit qualityOK/zero issues, but the cancelled check blocks merge. Normal check rerequest returned403 (app-owned check). One same-head close/reopen produced fresh successful CI but no new Sonar result. This documentation-only evidence correction requests analysis on a new revision; runtime code is unchanged. CodeRabbit trusted request/wait remains outstanding until other gates pass. Nothing has merged or deployed to production.

Latest production hourly refresh17:39 UTC includes complete16–17UTC with39min observation lag:188873884reads/188746writes/19627requests. Versus15–16 reads125713939/writes144331/requests~16543, reads rose50.2%, writes30.8%, requests18.6%. Equal complete3h14–17 versus11–14 reads498367400vs769496971(-35.2%), writes479007vs421724(+13.6%). Thus elevated usage fluctuates with a latest-hour rebound, not continuous decline or established sustained acceleration. No incident fix was live during either window.

Monitoring remains proposal-only. User prefers deterministic alerts awakening an agent only for anomalies, with12h agent fallback. Existing authorized CF credential proved alert/catalog access and webhook eligibility; SQL catalog91datasets contains no DO dataset, and a successful D1 SQL query proves SQL access only, not DO eligibility. Existing DO GraphQL metrics support a deterministic checker fallback. CF generic `cf-webhook-auth` differs from SAM bearer ingress, so native alerts need an adapter. No monitor schedule/prompt, webhook credential, permission or security configuration changed.
