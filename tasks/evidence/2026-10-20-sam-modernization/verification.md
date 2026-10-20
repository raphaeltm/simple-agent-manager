# SAM modernization verification

This is an implementation checkpoint, not a release certificate. No staging or production deployment has been performed.

## Local evidence

- Full workspace tests:21 successful tasks. API:907 files/12,869 tests passed;1file/2tests skipped and excluded from pass counts.
- Workspace typecheck:19 tasks passed. Workspace build:9 tasks passed.
- Native bundled workerd/Mastra:19 tests passed with real D1/DO SQLite and HTTP-boundary model fixtures. Both provider adapters, usage accounting, actual tool execution, input validation, opt-in, recovery and cancellation exercised.
- SQLite-backed operator security:13 tests passed. Shared dispatch/Instant paths independently tested with duplicate/lost-ack/effect-fence scenarios.
- Mocked browser audit:26 mobile/desktop cases; additional final control/receipt regressions passed. Eight latest cases cover unavailable receipts and uncertain dispatch across four viewport sizes.
- Screenshots in this directory are mocked local visual evidence. They do not establish live model quality, project dispatch, or staging correctness.
- Final event-watch budget/retry/scheduling correction and final-head quality checks remain pending at this checkpoint. Earlier broad passes do not prove those latest changes.

## Release blockers and pending evidence

Existing `SAM_PLAYWRIGHT_PRIMARY_USER` was rejected by staging `POST /api/auth/token-login` with HTTP401 `Invalid token format`. A valid existing dedicated credential must be supplied through the workspace environment. No replacement token, new grant or secret was created. No account was enabled.

After resolving authentication:

1. Coordinate shared staging ownership, deploy exact reviewed branch commit and record workflow/deployment identifiers.
2. Run `staging-sam-operator.spec.ts`: default-off, settings enable/refresh, isolation, replay/reconnect, cancellation and stale-tab disable; dedicated accounts only; cleanup opts both out.
3. Run the bounded behavioral matrix in `completion-review.md`, inspecting actual operation inputs/results. Runtime model fixtures are not evidence of the initial model following privacy/routing instructions.
4. Exercise one bounded real project dispatch/VM lifecycle, preserving selected profile and constraints; reconcile duplicate/uncertain effects before any retry. Verify heartbeat, report/source link, follow-up, cancellation and cleanup.
5. Verify dashboard/projects/settings, mobile/desktop, console errors and observability noise. Record exact commit and screenshots.
6. Complete final-head CI/security/specialist review and CodeRabbit gate, then merge and verify exact production commit/deployment and minimal default-off smoke. Never enable real users.

The canonical source was recovered in full (63,451 characters). Full settings/connections/compute/automation/deployment parity and general standing autonomy remain later roadmap stages, explicitly documented in the architecture decision and user guide.
