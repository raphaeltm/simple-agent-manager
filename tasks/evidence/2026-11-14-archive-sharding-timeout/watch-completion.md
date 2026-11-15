# Archive timeout task closeout

Completed 2026-11-15 after the original watch deadline. PR2724 matched merge: `6ce953a11775905fa0fdf08a2148ab023e52d2fc`; PR2739 matched merge: `7649cbfbe88af94af2c91e7aaa0490aaf5924ada`. Both exact heads were approved by the coordinator before merge.

## Final observation

Original window: November14 11:59:39.619–November15 11:59:39.619 UTC. Final scheduled check ran12:05:52.316–12:05:54.616 UTC; managed job `sx-2618851c5e1ad1420f9254e8168b6b4037ecf241438fd80ca13f0fd20eece25d` completed0. API200healthy12:05:54.533. Failed0, poisoned0, identityMismatch0 among **nonpublished** migrations including frozen; budgetStalls0. Cadence4100 succeeded, lastcompleted11:57:31.017, no error/lease, operation60.481s. Two queries read217+1=218D1rows, wrote0, SQL3.1583+0.3606ms.

The final health aggregate explicitly used `idx_project_data_archive_migrations_state_lease` with the eleven nonpublished states; failed/poisoned and identity counts used SUM/CASE. The second query selected the singleton cadence by its primary key. No final published-row aggregate, global identity scan, DO archive table, or row_usage query ran. This scope follows the coordinator's request after investigating a D1 overload near hour22.

All eight migrations affected by an earlier transient R2 internal10001 burst automatically published and reclaimed; final one at01:26:05.873 November15. That milestone was reported once at hour14. Last full throughput snapshot, hour22 at10:13UTC:3870published/allreclaimed,40new since original start. Published rows were not rescanned in the final two observations. Source preservation was established by the reclaim guard, not a physical sample.

Hour19 remains an accepted monitoring gap: no managed job receipt returned. One same-key replay at08:06 returned a fresh hour20 execution; it is not historical hour19 evidence. Hour22 metadata writes failed transiently and recovered once. The hour22 production query job ended10:13:06.429; the coordinator reported an overload burst10:13:38–41. Five SELECTs included broad migration aggregates, with an estimated upper bound about12.2k row visits; actual D1 row-read metadata was not captured then. No causation is asserted. Subsequent observations were narrowed to indexed health counters and recorded actual row-read metadata. No manual migration retry or production mutation was performed.

## Task Completion Validation Report

Tasks: archive timeout and deterministic automation/session follow-up. Branch: `sam/deterministic-automation-session-tests`. Compared merged implementations6ce953a and7649cbf, retained evidence, and refreshed GitHub release receipts. Verdict: **PASS**.

| Check | Status | Evidence |
|---|---|---|
| A: Research → Checklist | PASS | Quadratic lookups/FTS fixture, browser input overhead/navigation, native minute clock/mock teardown all addressed. |
| B: Checklist → Diff | PASS | Three shared unique-key seeks and fail-closed identity guard; real multipage fixture/assertions; test-only paste/navigation, native Date-only clock and bounded real waitUntil drain. Stale release boxes reconciled at closeout. |
| C: Criteria → Tests | PASS | Archive30normal+30loaded full files/2820PASS, three restored RED mutations; follow-up120fullfiles/3840PASS, label/rate/drain RED controls; lint/types/build and real-workerd regression previously passed. |
| D: UI → Backend | N/A | No product UI input/API contract change; existing UI payload assertions preserved. |
| E: Multi-Resource | N/A | No provider/resource selection change. |
| F: Vertical Slice | PASS | Real native workerd/DO request and model lifecycle, UI routes and asserted payloads, archive seal/flip/reclaim and fail-closed identity tests. |

No uncovered research or acceptance item remains. Staging exact-head deployment43578609385 and authenticated smoke passed, but did not select a fresh multipage archive; this limitation is retained. The authorized read-only production watch is complete with the explicit gap above.

Refreshed release receipts: PR2724 MERGED at approvedheadbb22bfa5d2ef251a40199bf258cb24b12240d31a; CI43585850934 attempt2SUCCESS; inclusive Deploy43592048272SUCCESS. PR2739 MERGED at approvedhead6ec28fb472de0ce04b2fe5d961cf11916461fcdf; mainCI43641698266SUCCESS; whole Deploy43643978384SUCCESS. PR2728 inclusive Deploy43628133084SUCCESS. Three actual-main Test samples22:54/25:25/22:44, median22:54, accepted. No new implementation or extra test repetitions were needed during closeout.
