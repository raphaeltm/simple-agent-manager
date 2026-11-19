# Reliability C replacement release evidence

Status: source and coordinated staging sweep validated, including compatible rollback and fixture cleanup. PR/production remain pending. Do not treat this as a completed release.

> **Reconciliation 2026-10-26:** This record stops before the release. The release finished on
> 2026-10-17: #2371 merged as `8394efa14`, production run 39044559133 (attempt 2) succeeded, the
> activation record was published by run 39047889679, and cutover happened at 16:15 UTC. The #2371
> PR body is the final record.

## Provenance and scope

Task `01M54TW40EA2VTA54SJ34SRJX1`, chat `3cb2972f-c7c7-43d1-ab2b-8db206e84628`, agent session `01M54V4ZKDD3YWQ7HD2P9G47JR`; assigned named branch `sam/ship-reliability-c-kv-4srjx1`. Primary D1 read (0 writes) confirms profile `01KSSMJCG4EE1XS153GNZX5B09`, `openai-codex`, `gpt-6.1-sol`; local turn context agrees. Preserved source remote `74d5b9486f60152c2d9be9f1ba357da3435355eb`, current main `980cef76cfca70842492d501307e660798155747` merged normally. Original sleeping owner remains untouched. All independently shipped main changes retained.

User's 2026-10-17 11:41 UTC quiet-window authorization supersedes provider/global-retirement proof. Extra authenticated admissions and missing bounded diagnostics from old invocations accepted without a fixed overlap ceiling. No support contact, forced stops, new credentials/auth surface, outage or immutable-record replacement.

## Current checks

- Repository lint: 13 tasks PASS (existing warnings only).
- Repository typecheck: 19 tasks PASS (existing Astro baseline).
- Repository build: 9 tasks PASS; explicit standalone marketing build 243 pages PASS after an initial generated-chunk failure while running other checks.
- Repository tests:21 tasks PASS, including API887 files /12483passed /2skipped (1file skipped) and web343files /4096passed.
- Lifecycle + storage unit regression: 2 files / 35 tests PASS. Clear failure prevents dispatch, records retryable failure, retry succeeds, successor lifecycle claim is preserved. MCP activation/DO failures recover with the same identity/window and consumed quota, without KV fallback.
- Real Worker storage: 1 file / 18 tests PASS. Atomic admissions, fallback identities, held bodies, log ordering/clear/TTL/deduplication, immutable guards and compatible-instance state retention; unsafe old-writer overlap retained as accepted-risk characterization.
- Activation script: 1 file / 6 tests PASS. Pinned live SHA/version/bindings, read-only preflight, idempotent exact retry, conflict/expiry/alignment/config-change rejection and atomic SQL. Actual JSON Number values plus fractions/strings tested.
- All deployment/quality script tests: 55 files / 741 tests PASS using two workers. Initial checks found unsafe workflow expression in shell (fixed via env), main's newly ignored checkpoint invalidating synthetic fixtures (test-only fixture correction), and two existing shell test timeouts during concurrent full-suite/build activity. No timeout/gate weakened.
- Migration ordering, DO migration compatibility and Wrangler bindings checks PASS; generated clean/upgrade migrations and binding behavior covered in scripts suite. C guard migration is0197 because shipped admin settings owns0196.
- Formatting and diff whitespace PASS.

## Independent local Sol reviews

| Reviewer                                    | Status    | Outcome                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| security_review                             | PASS      | No blocking findings; final env-supplied SHA, numeric guards and primary-read assertion rechecked. Independently ran original activation6tests.                                                                                                                                                                 |
| cloudflare_review / constitution            | ADDRESSED | Atomic SQL/mutex/retention/primary reads, bindings and clean/upgrade history sound. Numeric transport issue resolved with actual D1 observation and strict integral CAST validation; activation6tests independently passed.                                                                                     |
| lifecycle_review / docs/test/env/completion | PASS      | Minimal rebuild recovery fix, tests, workflow docs and existing-secret consistency reviewed; independently35unit+6activation passed. Live completion gates remain pending. Final numeric/adjacent synthetic fixture recheck PASS; constructed snapshot test is not production snapshot implementation coverage. |

## Read-only live observations

- Production Cloudflare Worker `85d8c86d-e005-4016-9a65-d0f19ef3fa5b` at100%; staging `d6c2ab4e-e63c-4888-9227-9b5528e03528` at100% before C deployment.
- Existing deployment successes: production run38984656469 on main980cef76c; staging38981626221 on admin candidatea0e3fc4b.
- Safe allowlisted version inspection confirmed `resources.bindings` with `DATABASE.id` and version annotations shape. Full settings/versions bodies never logged.
- Staging D1 REST query `SELECT typeof(?1)` with JSON parameter180 returned `real`, `served_by_primary=true`, 0rows_written. Publication SQL therefore validates exact numeric integrality and casts stored JSON integers. Every publication/readback API response requires explicit primary servicing.
- Supported Playwright staging token-login200, active smoke superadmin. Before C: no activation record,0creating workspaces;3retained nodes are sleeping. No fixtures created/mutated.
- Staging release requested from coordinator and previous admin2304 owner; no overwrite before explicit release.

## Remaining release gates

Focused PR exact CI/Sonar and trusted CodeRabbit request/wait remain pending, followed by canonical production SHA/run/live CF/health, actual natural quiet-window observations including the release session, immutable future activation and postactivation MCP/counter/log/no expected hot KV write evidence. Staging publication/readback, configured VM lifecycle, compatible rollback and cleanup are complete as recorded below. Preserve any observed old outliers separately. This file will be updated with actual production outcomes.

## Coordinated staging observations — 2026-10-17

The prior owner explicitly released staging and the coordinator confirmed the slot. The single fallback check was used because GitHub workflow wake delivery was not verified. [Pinned staging run39031095066](https://github.com/raphaeltm/simple-agent-manager/actions/runs/39031095066) succeeded on exact7939ff8b9c247ae0686f70b3d7ba52955c763ae9, including standard smoke. Cloudflare version d4427158-eba0-4033-9222-d9156e48baa5 was100% with that commit annotation, both DO bindings and the expected primary database/window. Migration0197 and all three immutable guards were present before publication.

One workspace01M54X8H4YHWWGBQGTW2Q4S5V3 was created through the normal user API with only name/projectId, using the configured pool and no sizing overrides. New node01M54X8GXAGSYTPZ3AJ3NECDRC used the normal cx23 offering. Heartbeat and supported node access were verified; actual agent version b5394835cff9475de9cff9f8e39e64a99d19d180. Workspace creation returned201 at12:26:53 UTC; cold provisioning completed workspace_ready at12:34:51 and was observed running at12:36:32. This is not a two-minute cold-start claim. Eighteen real bridge boot entries were retained. The mobile workspace screen was inspected and had no horizontal overflow.

A normal manually created agent session01M54XTQYM87Z6AE4P8SCPA07X provided its product-issued MCP identity. Preactivation initialize and get_workspace_info passed; auth controls returned401, notification returned empty202, limit120 and remaining119→118. No token value or full settings/log payload was retained as evidence.

[Read-only activation preflight39033203116](https://github.com/raphaeltm/simple-agent-manager/actions/runs/39033203116) passed with record absent. Its tentative13:15 cutover was never published. [Actual deployment-owned publication39033250142](https://github.com/raphaeltm/simple-agent-manager/actions/runs/39033250142) succeeded using existing deployment credentials, with primary immutable readback: publishedAt1792240653, rateCutoverAt1792240920, bootLogCutoverAt1792240920, windowSeconds60. The published cutover is12:42UTC and must never be changed. Production remains untouched by C. Postactivation lifecycle, exact burst, compatible rollback and fixture cleanup are still pending.

Postactivation same-window restart passed at12:42:20: restart returned200/creating and the same agent quota moved119→118 with reset1792240980 unchanged. The concurrent burst then admitted exactly117 and rejected3 with429, exact remaining-header sequence and valid Retry-After. Real restart logs contained only new12:42 entries, showing clear-before-dispatch and DO append; the workspace returned running at12:42:51. The old KV payload still hashed dbcc527ab719a1d6a7adbad922e49bcf3756870b3d2313f1255d4938928f8500, while the current rate key was404. A local journal comparison flag initially lacked its baseline because parallel helper writes raced; before/after raw hashes independently matched, and the fixture journal was restored from those recorded values. Subsequent journal-mutating helpers are serialized.

Rebuild was not dispatched at12:43: the test harness exhausted the existing20/hour fresh token-login limit and received429 at login. No auth configuration changed and no alternate identity was used. Continue after the normal13:00UTC reset, reusing a single authenticated context for rebuild polling. The compatible second deployment39033319997 is running; actual rollback/cleanup remain pending. The sole VM remains the same fixture; retained baseline sleepers remain untouched.

At13:00 UTC the normal login reset worked. The fixture had become stopped without error while its same node remained running. The bounded single-login check restarted that existing workspace/node, then rebuilt:202 at13:01:32, immediate creating response with empty logs, new callback steps13:01:33–47, running/no error13:01:54. No new workspace or VM was created. Post-rebuild MCP smoke passed with auth401 controls, notification202 and quota119→118; the scoped old boot-log KV hash remained unchanged and the current-window rate key remained404. Playwright dashboard/projects/settings each loaded200 with no horizontal overflow and zero page errors.

Compatible deployment39033319997 succeeded at305a34208ab7267f4d8f7c01b48b8890c70c5451. Actual CF version d1da6ea3-9e69-4925-b5b1-b4d5c37a3e24 at100%, exact commit annotation, bindings, primary unchanged activation and health200 were verified13:00:43. Canonical run39031095066 attempt2 is the requested rollback to exact7939; final rollback proof is still pending.

A fixed SELECT-only Data Studio read against the existing own staging DO returned403 with the debugging token; no permission change was attempted. The existing deployment-owned activation workflow now optionally verifies paired own workspace/rate identity ULIDs after elapsed immutable activation, with publish=false and the same pinned live version guards. It returns only validated aggregate counts/timestamps/state and bounded counter rows, requiring zero query writes. No payloads, messages, generic SQL, namespace override, credentials or runtime auth route were added. Independent security, CF/constitution and docs/test/env source reviews all PASS. Focused activation/evidence/workflow suites:3files76tests PASS, including malformed/missing IDs, ambiguous namespaces, bounded enumeration and canary rejection. Live deployment-credential verification remains pending; empty results are not successful-workload evidence.

## Compatible rollback and actual stored data

Canonical run39031095066 attempt2 succeeded on exact7939ff8b9. At13:18:34, actual CF version de2d30f3-b3ee-4c21-8ed0-b632bb1d101b was100%, exact commit annotation/bindings/primary immutable activation unchanged, health200. This is a compatible rollback, never a prebridge KV fallback. Runtime code at305a and7939 is identical; deployment versions are distinct. Real Worker tests separately cover same-window quota retention across compatible instances; a20minute live pipeline cannot prove same-window retention.

Deployment-owned read-only workflow39036034718 succeeded after rollback and found18 retained rebuild entries (reporter timestamps13:01:33–48), expiry1792243909105 and allowLegacy0. Its counter read fell at13:19:00 and returned no active window; that was not counted as workload evidence. The bounded18-call/10second normal MCP workload continued. A second fixed read-only workflow [39036148911](https://github.com/raphaeltm/simple-agent-manager/actions/runs/39036148911) succeeded, preserving the exact immutable record, the18 retained entries and suppression marker, and returned a real counter row windowStart1792243200/resetAt1792243260/count4. All SELECT metadata reported0rows_written. [Sanitized exact artifact](staging-storage-readback.json). No raw payloads or messages were collected. Fixture cleanup is next.

At13:21:28, both the own legacy boot-log key and current-window rate key returned404. The original boot-log key had naturally exceeded its30minute KV TTL; the earlier unchanged-hash observations remain separate from this absence observation. No old outlier was observed; this does not prove absence of every delayed old write.

## Fixture cleanup

The bounded18-call MCP workload completed normally at13:21:56. Guarded cleanup used only the exact own workspace/node, deleted the workspace200 with deletionStatus=confirmed, checked fresh node occupancy zero, then deleted the new own node200 at13:22:27. The managed node deletion route requires strict runtime termination confirmation before success. Fresh verification at13:23:17 found own node404, workspace deleted, all three baseline sleeping nodes retained and zero active staging nodes for the smoke owner. Playwright dashboard/projects/settings remained200 with zero page/console errors and no overflow. No duplicate fixture, sizing/pool override, retained-node deletion, or original-owner wake occurred. The exclusive staging lease is released.

### PR Sonar follow-up

Sonar's 4.2% new duplication was repeated unpublished-activation test setup. A shared fixture now preserves all first-primary, exact SELECT and activation-key assertions with a fresh mock for each caller; five route suites pass (323 tests). The activation CLI entry now uses top-level await with the same caught-error/exit-code behavior; activation/evidence/workflow suites pass (76 tests). Independent lifecycle reviewer: PASS. No deployment behavior changed and the completed staging sweep remains applicable.

Two `plsql:S1192` reports on `0197_reliability_storage_activation.sql` are inapplicable to this SQLite DDL: SQLite trigger definitions cannot declare reusable PL/SQL constants. Repeated activation-key and abort-message literals intentionally enforce the same immutable protocol across all three independent triggers. A lookup table or user-defined function would add mutable dependencies and weaken the guard. The already-applied migration remains byte-for-byte unchanged; no broad rule suppression or scanner exclusion was introduced. These two reports are explicitly resolved by this reviewed technical rationale, not claimed as source edits or remote Sonar issue-status changes.

### CodeRabbit review corrections

Review5558224357 identified three valid issues. Expired caller-pinned counter windows now return ordinary denial before alarm/SQL access, avoiding both boundary500s and resurrection of pruned quota; caller clock skew no longer fails a still-live window. Two real Worker regressions cover repeated expired denial, current-window recovery and future-clock quota continuity (20 Worker tests PASS). Optional diagnostic boot-log read failures now omit `bootLogs` from the authorized workspace response; auth/resource errors and awaited append/clear behavior remain unchanged. Logs contain only workspace ID and fixed error type. Real-SQL CRUD tests cover failure/recovery and foreign workspace rejection (16 tests PASS). Runbook SQL now exactly matches the supported deployment statement's key/shared cutover/window parameters; direct equality check PASS. Independent Cloudflare and lifecycle reviewers PASS. No schema, binding, migration or authentication change; both reviewers found no reason to repeat the completed real-VM sweep for this focused delta. Exact new-head CI and incremental CodeRabbit wait remain release gates.
