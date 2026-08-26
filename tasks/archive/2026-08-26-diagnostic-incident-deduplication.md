# Diagnostic incident deduplication and durable triage dispatch

## Problem

The 2026-08-25 production stability audit found that diagnostic evidence capture works, but throughput to durable diagnosis or repair work does not. In the audited 48-hour window, 77 of 82 diagnostic incidents were repeats of one known stopped-workspace snapshot race, while the feedback triage queue held 14 signatures with 187 lifetime occurrences, 22 diagnosis failures, 12 budget-blocked signatures, one HTTP 429, and zero dispatch attempts.

This task must bound repeated diagnostic evidence volume, keep frequency visible, and make budget-blocked feedback signatures retryable and dispatchable. It must not fix the underlying stopped-workspace snapshot race.

## Research findings

- Audit source: library file `/reliability/audits/production-stability-audit-2026-08-25.md`, section “Diagnostics capture works; diagnosis throughput does not”. It explicitly calls for deduplicating repeated diagnostic signatures, budget-aware retry, and an end-to-end dispatch/resolution test.
- Persistent knowledge says the stopped-workspace snapshot race is already tracked as SAM idea `01M0SHQC8V34S2P0JMZR53TEJN`, so this task should not create a duplicate idea unless later evidence contradicts that.
- `apps/api/src/routes/node-diagnostic-incidents.ts` sees the VM error message/source before `ensurePendingIncidents()`. That is the right boundary to compute a diagnostic signature and suppress duplicate incident/artifact rows before artifact registration.
- `apps/api/src/services/diagnostic-incidents.ts` currently keys one `diagnostic_incidents` row and one deterministic artifact per VM `incidentId`. It lacks signature/deployment columns, occurrence accounting, and a lightweight duplicate occurrence map for duplicate error IDs.
- The VM agent always tries to register and upload its ready artifact after the error batch is acknowledged. The API therefore needs to acknowledge duplicate artifact registration/upload as a no-op so the VM does not retry forever, while still avoiding duplicate `diagnostic_artifacts` rows and R2 objects.
- `apps/api/src/services/platform-feedback-triage.ts` currently groups recent platform errors, claims a signature, runs `runDebugDiagnosis()`, and records ordinary failures. Budget errors from `debug-agent.ts` are plain `Error` messages (`Daily deployment debugging budget exhausted`, `Per-run debugging token ceiling reached`) and can currently increment `failure_count` until rejection.
- `apps/api/src/services/platform-feedback-incidents.ts` already has queue states, dispatch leases, claim leases, resolution, and expiry. Dispatch leases are reclaimed, but expired agent claims are only reclaimable if a later agent targets the same signature; they are not automatically returned to the pending dispatch set.
- `apps/api/src/scheduled/incident-triggers.ts` dispatches only active `source_type='incident'` triggers. Production had zero active incident triggers, the UI excludes incident trigger creation, and the MCP create-trigger tool only creates cron triggers. Without a server-side ensured private incident trigger, pending incidents can remain durable but never dispatch.
- `apps/www/src/content/docs/docs/guides/reporting-issues.md` currently documents repeated triage failures as rejected and manual budget retries as failing until the next day. This must be updated to reflect budget deferral and automatic retry/dispatch behavior.
- Rule `.claude/rules/47-control-loop-io-budget.md` applies: changed cron/queue candidate selection must state expected candidate volume, worst-case cost, and an escape path for every selected candidate. The incident trigger sweep already limits triggers and backlog summaries; this task must preserve bounded pages and add tests for retry/lease escape paths.
- Migrations must be additive only. `triggers` and many parent tables are unsafe to recreate (`.claude/rules/31-migration-safety.md`).

## Implementation checklist

- [x] Add additive D1 migration and Drizzle schema fields for diagnostic incident signature, deployment discriminator, occurrence counter, last-seen timestamp, and lightweight duplicate occurrence mapping.
- [x] Compute a redacted diagnostic signature at VM error ingestion, deduplicate at least by signature + deployment, and increment occurrence accounting exactly once per duplicate platform error ID.
- [x] Make duplicate diagnostic artifact registration/upload acknowledge successfully without creating duplicate `diagnostic_artifacts` rows or R2 objects.
- [x] Expose diagnostic occurrence count and last-seen timestamp through shared types/API summaries, and surface them proportionally in the admin diagnostic evidence card.
- [x] Add additive D1 migration and Drizzle schema fields for feedback triage severity and budget deferral metadata.
- [x] Classify daily/per-run budget errors separately from ordinary diagnosis failures; budget deferral must not increment the permanent failure/rejection counter.
- [x] Prioritize triage diagnosis candidates by severity and novelty before low-severity repeats, within existing bounded group limits.
- [x] Keep budget-deferred signatures pending/dispatch-eligible, skip diagnosis before their defer-until time, and retry diagnosis when the budget refresh/defer window passes.
- [x] Revive existing budget-rejected signatures during migration by clearing rejection for rows whose last failure reason is a known budget-block message.
- [x] Reclaim expired incident agent claims back to pending so claimed-but-abandoned incidents have an automatic dispatch escape path.
- [x] Ensure a single canonical private incident trigger exists for the configured feedback project when pending incidents need dispatch, without creating duplicates or overriding existing operator-created incident triggers.
- [x] Preserve dispatch idempotency: one eligible backlog dispatch creates exactly one trigger execution/task link, and repeated sweeps do not duplicate work while the prior dispatch/claim is active.
- [x] Update public docs/config references for diagnostic deduplication, budget-deferred triage retry, and server-ensured private incident dispatch.
- [x] Add the process-rule fix required for this production bug class.
- [x] Add audit-required automated coverage: repeated diagnostic signature many times, mixed severities, exhausted daily budget then retry after refresh, lease recovery, durable dispatch creates exactly one task/no duplicates, resolution, and at least one eligible incident reaches dispatch end-to-end.

## Acceptance criteria

- [x] Repeating the same diagnostic signature many times in one deployment creates one canonical diagnostic incident/artifact, increments occurrence count once per distinct platform error ID, updates last-seen, and resolves duplicate error IDs to the canonical safe evidence.
- [x] Duplicate artifact registration/upload attempts from the VM are acknowledged without storing duplicate artifacts or R2 objects.
- [x] Budget-blocked triage signatures remain pending and dispatch-eligible, are not rejected because a daily/per-run budget ran out, and are retried after the defer/refresh time passes.
- [x] High-severity and novel signatures consume diagnosis budget ahead of low-severity repeats under a constrained budget.
- [x] Pending, dispatched, claimed, budget-deferred, rejected, resolved, and expired queue paths have explicit success, retry, terminal, or max-age escape behavior per rule 47.
- [x] At least one eligible incident reaches durable dispatch end-to-end in tests, and repeated sweeps create exactly one task link rather than duplicates.
- [x] An expired dispatch/agent lease is recovered and an incident can be claimed then resolved.
- [x] The stopped-workspace snapshot race itself is not fixed here; existing idea tracking is verified or a new SAM idea is created only if missing.
- [x] Focused tests, full local quality gates, specialist reviews, and responsive UI verification complete; CI, merge, and production deploy monitoring are tracked in the PR/post-merge phase.

## Validation evidence

- Focused API diagnostic/triage/incident tests passed.
- `pnpm test` passed after rerun of a transient MCP timeout.
- `pnpm typecheck` passed with existing Astro template baseline only.
- `pnpm lint` passed with existing warnings only.
- `pnpm format:check` passed.
- `pnpm quality:migration-safety && pnpm quality:do-migration-safety` passed.
- `git diff --check` passed.
- Playwright diagnostic audit passed on `iPhone SE (375x667)` and `Desktop (1280x800)`: 26 tests passed.

## Control-loop load review

- Hourly feedback triage remains bounded by `PLATFORM_FEEDBACK_TRIAGE_ERROR_LIMIT` input rows and `PLATFORM_FEEDBACK_TRIAGE_GROUP_LIMIT` processed signatures per run. Candidate ordering changes, but candidate volume does not widen beyond the configured caps.
- Incident dispatch remains bounded by `PLATFORM_FEEDBACK_INCIDENT_TRIGGER_LIMIT` triggers and `PLATFORM_FEEDBACK_INCIDENT_SUMMARY_LIMIT` pending incidents per dispatch summary.
- Worst-case expensive work remains one `runDebugDiagnosis()` per selected group and one trigger task submission per dispatch sweep. Budget-deferred groups skip diagnosis until their defer-until time; duplicate diagnostic artifact uploads are no-op persisted state checks plus no R2 write.
- Escape paths: diagnosis success creates/updates the draft Idea; ordinary diagnosis failures reject after bounded failures; budget failures defer and retry while remaining dispatch-eligible; dispatch leases requeue/reject; agent claims requeue after lease expiry; unresolved active incidents expire after `PLATFORM_FEEDBACK_INCIDENT_MAX_AGE_MS`.

## References

- `/reliability/audits/production-stability-audit-2026-08-25.md`
- `apps/api/src/routes/node-diagnostic-incidents.ts`
- `apps/api/src/services/diagnostic-incidents.ts`
- `apps/api/src/services/platform-feedback-triage.ts`
- `apps/api/src/services/platform-feedback-incidents.ts`
- `apps/api/src/scheduled/incident-triggers.ts`
- `apps/api/tests/unit/services/diagnostic-incidents.test.ts`
- `apps/api/tests/unit/services/platform-feedback-triage.test.ts`
- `apps/api/tests/unit/services/platform-feedback-incidents.test.ts`
- `apps/api/tests/unit/scheduled/incident-triggers.test.ts`
- `apps/www/src/content/docs/docs/guides/reporting-issues.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/31-migration-safety.md`
