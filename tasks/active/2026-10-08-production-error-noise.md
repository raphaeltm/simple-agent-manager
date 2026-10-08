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
- [ ] Run regression discrimination and relevant lint/typecheck/test/build validation.
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
