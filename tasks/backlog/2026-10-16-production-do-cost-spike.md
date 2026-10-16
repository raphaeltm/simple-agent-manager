# Production Durable Object read/write cost incident

## Objective
Understand October15 monitored usage spike, ship the smallest safe causal fix through normal gates, and verify actual production metrics after reporting lag. Preserve data, active sessions, security and monitoring.

## Evidence (2026-10-16 UTC)
- PR2357 and2363 remain open drafts/unmerged. 2357's new counter/log DOs are absent from production; not a shipped fix or cause.
- Latest successful production run https://github.com/raphaeltm/simple-agent-manager/actions/runs/38907594785 at main7e8d6985829842897fcdca912a7a9a7413ecf963. CF live100%55714c04-891a-4ab2-8ba5-2b7e1de3ed31 uploaded13:35:31.
- CF periodic rows ProjectData Oct9 163981785read/1044058written; Oct14 495980679/960360; Oct15 2230149580/2527103; Oct16 partial15:54 3427059592/2368591. Oct14 available now; monitor missing-day status is not absent CF data.
- Oct15 all-namespace rows and31-day projection reproduce reads44.15USD and writes28.39USD using25B/50M monthly allowance and0.001USD/1M reads,1USD/1M writes. Projection, not invoice.
- Oct16 object breakdown main SAM root3.447Breads/1.661Mwrites; second project root2.128Mreads/649205writes. Archive shards each <=103kreads. Spike is overwhelmingly main root reads; archive migration is not dominant.
- Existing production alarm logs show empty task-wait passes24522reads and mailbox sweep9531reads. Schedule computations are outside section metering, so section logs undercount total work.
- Concrete amplification: computeMailboxAlarmTime counts every queued/delivered row each scheduling recalculation although only existence matters. updateNodeHeartbeats and many mutation paths recalculate; empty task-wait pass also recalculates unnecessarily before outer alarm recalculates again. Independent SQLite100kdelivered fixture COUNT300030VMsteps vs EXISTS25. Approx9.5krows*190kRPC/day explains order of billions (inference; exact production mailbox state count not yet read).
- Separate nextSequence MAX scans entire session due index(session_id,created_at,sequence).100k fixture500013VMsteps vs18 with new(session_id,sequence) index. Defer broad index until migration capacity justified: root9096073216bytes/10GB at15:55; extra~39MB/million raw messages, construction/write costs. Do not conflate with confirmed dominant cause.
- Dependency install hit host ENOSPC; investigating safe recovery without touching other sessions. API tests pending.

## Implementation and acceptance checklist
- [ ] Replace mailbox scheduling COUNT with indexed existence check, preserving due semantics.
- [ ] Remove redundant no-mutation task-wait schedule recalculation, preserving mutation/failure scheduling.
- [ ] Native Worker SQLite regression with large retained mailbox and full scheduler; bounded reads independent of history.
- [ ] Test empty task waits call counts and due/failure/retry behavior.
- [ ] Validate lint/typecheck/relevant suites/build and migration/security checks as applicable.
- [ ] Independent specialist/completion reviews; all findings resolved.
- [ ] Coordinate active owners2304/2305/reliability; staging on pinned SHA, verify behavior.
- [ ] PR CI/Sonar/security and CodeRabbit request/wait; normal merge/deploy.
- [ ] Verify deployed SHA/version, health, native per-call evidence and lagged comparable production usage; quantify remaining uncertainty.

## Coordination
Old coordinator01M50044HCHRVR12B4337721G5 failed; message rejected. Active owners01M52KPD9FDR724Z371666KAHE,01M4ZVWEGJ8WMFK69JNE7W7M5Y,2304owner01M52PEXV56VPD7H8541HP8EFJ,2305owner01M52PF30AYFJN0YM8KPQ8ME45 notified of owner incident priority. Accepted delivery is not acknowledgment.
