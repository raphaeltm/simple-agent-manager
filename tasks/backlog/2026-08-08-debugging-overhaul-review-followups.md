# Debugging Overhaul — Deferred Review Follow-ups

Non-blocking findings from the five specialist reviews of PR #1765 (debugging-experience overhaul). All CRITICAL/HIGH findings were fixed in the PR; these are the explicitly deferred MEDIUM/LOW items.

## Security (MEDIUM, hardening)

- [ ] Extend `apps/api/src/services/secret-redaction.ts` patterns: classic-format OpenAI keys (`sk-` + alnum, no marker suffix) fall through every pattern; consider a generic high-entropy heuristic near key/token/secret/password words. Matters more now that `app.onError` persists globally.
- [ ] `apps/api/src/services/node-agent.ts:206,808` embed raw upstream response bodies in thrown error messages — stop echoing raw bodies into `err.message`.
- [ ] Write-time sampling/dedup for `scheduleErrorPersistence` (`apps/api/src/middleware/app-error-handler.ts`): during an outage every 500 writes a row at request rate; the retention purge bounds steady state but not bursts. A per-fingerprint/minute cap (pattern exists in `stuck-tasks.ts` task-scoped dedup) or a documented accept-as-is decision.

## Cloudflare (MEDIUM, scalability)

- [ ] `GET /api/admin/observability/nodes` predicate is non-sargable (`OR` + `datetime()`-wrapped columns; `nodes` has no status/heartbeat indexes) — full scan+sort per call. Fine at current scale (superadmin, LIMIT<=100); add an index or restructure before the nodes table grows large.

## UI/UX (SHOULD-FIX, minor)

- [ ] `.sam-scroll-button` can visually overlap the expanded FailureCard's Timeline label on mobile (measured ~1-2px at 375x667). Hide it while the failure card is expanded or make its offset aware of `floatingHeaderHeight`.
- [ ] `ActiveTaskCard` cannot show `errorMessage` because `DashboardTask` (`packages/shared/src/types/task.ts`) does not carry it — plumb the field through the dashboard API to match `TaskList`'s failed-row preview.
- [ ] `LogViewer`'s Apply button is visually scoped to the search input but governs time-range/level selects too — either auto-apply selects (debounced) or visually group Apply with all filters.
- [ ] Migrate `apps/web/tests/playwright/failure-card-audit.spec.ts` from a static HTML mockup to the real-render pattern used by `admin-errors-audit.spec.ts` (the mockup cannot catch component-level regressions like the aria-label bug the review found).
- [ ] `ObservabilityFilters` `idExpanded` derives from URL params only at mount; a same-page param change won't auto-expand the ID panel.
- [ ] `AgentCrashReportView` "Copy report" lost its hover treatment in the token conversion — add a token-based hover state.
- [ ] Pre-existing (verified on main): time-range select renders "Last 24l" instead of "Last 24h" in one admin context — screenshot `REVIEW-timerange-select-zoom.png` from the 2026-08-08 review session.

## Test hygiene (LOW)

- [ ] Consolidate the two `useActivityVerifyTimer` test files (`tests/unit/useActivityVerifyTimer.test.ts` and `tests/unit/components/useActivityVerifyTimer.test.ts`) into one.
- [ ] `CopyableIdPill` truncation slicing (`value.slice(0,6)+'…'+value.slice(-4)`) has no direct rendered-text assertion for long IDs.
- [ ] Env-override tests for the five new `OBSERVABILITY_ADMIN_*`/`OBSERVABILITY_NODE_INCIDENTS_*` limits (defaults + ceilings are tested; the override path follows the pre-existing untested convention).

## References

- PR #1765; `tasks/active/2026-08-07-debugging-experience-overhaul.md`
- Review agents' full reports live in the coordinator session (2026-08-08)
