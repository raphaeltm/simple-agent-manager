# Reduce production error noise

## Problem and scope
Five production diagnostics hide actionable failures: idle snapshot capture races sleep teardown; legacy task repair inserts deleted workspace foreign keys; wrapped D1 errors lose safe cause codes; quarantine records omit reason/attempts; TaskRunner warnings use stale task candidates. API-only fixes; optional VM logging changes deferred from this bundle.

## Preflight and research
Classes: business-logic-change, cross-component-change. No new external service, configuration, schema or trust boundary.
Production read-only D1 baseline (2026-10-08 ~13:57 UTC): snapshot API errors October 5/6/7 = 21/32/43; October 8 = 23. All 23 taskless session summaries reference missing workspaces. Use CF_PRODUCTION_ACCOUNT_ID (production account differs from staging), CF_PRODUCTION_DEBUGGING_TOKEN. Baseline JSON retained locally in .codex/tmp/noise-baseline.json.
Data paths: ACP activity HTTP callback → markTerminalContainerWorkEnded → VM capture → snapshot prepare HTTP → prepareSessionSnapshot → D1 CAS → global handleAppError → observability D1. Scheduled session-task reconciliation → ProjectData session → ensureSessionTaskBacked → tasks FK → linkSessionToTask. NodeLifecycle deletion retry → deadLetterExact → platform_errors. Scheduled stuck task scan → TaskRunner probe → refreshed D1 task → warning persistence.
Preserve sleep transitions, last good snapshots, real 5xx failures and credential redaction. Snapshot race is a conflict (409), not an internal failure. Workspace existence must be evaluated atomically at insertion to avoid a new check/delete race. No migrations expected.
Tests use existing Workers/Miniflare real D1/DO/HTTP fixtures, including controlled task-state convergence and positive capture controls. Diagnostic tests seed arbitrary parameter canaries.
Rules: API AGENTS.md; 02 quality, 05 preflight, 13 staging, 14 workflow state, 35 vertical slices, 62 real trigger; scoped API error handling and CF debugging. Callback-auth incident requires real route path; ordering tests must control race midpoint. Documentation: update relevant error/observability contract documentation if present, otherwise task/PR explain internal-only fixes.
Coordination: reliability-wave-1008 subscription active. Ownership published. Obey staging lease and migration claims; no staging deploy before all local reviews complete.

## Implementation checklist
- [x] Skip idle capture for sleepingAt or stopping/sleeping snapshot; retain normal idle capture.
- [x] Return typed 409 for snapshot teardown/CAS races with HTTP/persistence coverage.
- [x] Atomically omit missing workspace FK during legacy task repair; scheduled path repairs and links chats idempotently.
- [x] Extract only allowlisted D1 cause codes; persist/log codes without SQL parameters or cause messages.
- [x] Persist quarantine reason and attempt count via actual retry/dead-letter path.
- [x] Re-read task after DO probe before diagnosing/persisting mismatch; retain true mismatch warning.
- [x] Run regression discrimination and relevant lint/typecheck/test/build validation.
- [x] Complete local specialist reviews and completion validator.
- [ ] Acquire staging lease, deploy and verify live behavior; release cleanly.
- [ ] PR/CI/CodeRabbit request-and-wait, merge, production deployment.
- [ ] Verify production counts and automatic repair of the 23 historical chats.
- [ ] Append PR/evidence to five ideas and queue section; complete only deployed verified ideas.
- [ ] Publish MERGED/DONE and cancel subscription.

## Acceptance criteria
Each fix has a real-path regression that fails on old behavior. Known snapshot races return 409 without persisted 500; normal capture and genuine 500 remain observable. Task repair succeeds with deleted workspace references and preserves existing valid references. Cause diagnostics contain only allowlisted codes and no raw parameters. Quarantine diagnostics retain reason/attempts. Converged tasks produce no mismatch warning; genuine mismatch persists once. Staging passes, PR is reviewed/green/merged, deployment succeeds, and production evidence quantifies noise reduction and historical repair.

## Local review and validation
Cloudflare/security, test-engineer/task-completion and docs/constitution reviewers all passed; removed their common finding, an unused snapshot join outside the idle path. Root lint 13/13, typecheck 19/19, build 9/9 passed. Full root tests and final callback regression are running. Real Workers route/cron tests passed for prepare conflicts (including both lost CAS races), stale workspace repair, D1 cause persistence/redaction, NodeLifecycle quarantine and task-warning convergence. Optional VM typed-status classification remains open; no VM rollout in this PR.

## Bug post-mortem and loop budget
`a04bb62d14` (#2218) introduced durable capture-vs-teardown fencing but used generic errors; the idle caller did not consult the fence. `d590ec5626` (#1572) copied historical workspace IDs while materializing tasks, although deleted workspaces are valid conversation history. `0e655f49f1` classified TaskRunner handoff from the scan's stale D1 row. `94ae09f758` persisted quarantine without the already-known reason/attempt; `8eed3b7402` persisted wrapper messages without nested D1 categories. These are cross-boundary state/diagnostic gaps. Existing unit doubles did not reproduce durable deletion and callback/probe interleavings. The process fix is six real Workers regression paths and old-behavior discrimination under existing rules 35/62; no new standing rule is needed.

Candidate sets and existing scheduler limits are unchanged. Task repair keeps its default 25 candidates/run (configured maximum 200), with one indexed workspace scalar lookup inside the existing INSERT and no extra network call. Successful repair leaves the candidate set. Mismatch diagnosis adds one primary-key D1 read only after an already-successful completed DO probe; terminal/converged rows skip the existing observability query/write. Idle capture adds one indexed, unique chat snapshot join to the existing workspace query and skips VM I/O after teardown claims.

Fresh production baseline at 2026-10-08 14:58 UTC: today's API snapshot signature count is 30 (Oct5/6/7 still 21/32/43). Retained the exact 23 taskless IDs locally for postdeploy comparison. Use `instr(message, ...)` for signature counts: an unbounded LIKE hit SQLite's pattern-complexity error on an existing oversized message.

Regression discrimination (2026-10-08 15:03 UTC): in a separate detached checkout, removed idle sleep admission, restored generic prepare errors/stale workspace copying, removed cause/quarantine fields, and restored stale delegated classification. All six test files failed at expected assertions (13 failing cases, three positive controls passing; one repair positive case also saw the unrepaired deleted candidate). Restoring the unchanged feature source made all 16 selected cases pass across all six files. Callback full file 7/7, snapshot/observability/stuck-task rerun 36/36, repair 2/2 and NodeLifecycle full suite passed. Final API typecheck passed. No mutation touched the feature checkout.

Final validation (2026-10-08 15:18 UTC): full root tests21/21 tasks PASS, including API828files/11,620tests and Web336files/4,023tests. Initial five failures were preexisting source-reader paths after helper extraction; updated readers retain every assertion, focused79/79PASS, reviewer deltaPASS, then final full run green. Root lint13/13, typecheck19/19, build9/9 and file-size checkPASS. Playwright Chromium and shared staging helpers launch successfully without contacting staging. Ready for a20–25minute, zero-VM staging lease; expiry task still holds lease43. No deploy or PR yet.
