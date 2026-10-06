# Platform Feedback Triage Resilience

## Problem

Platform feedback triage currently treats each sweep as a mostly linear unit of work. A single diagnosis or commit failure can abort the sweep, cron/manual callers may only see a rejected job without group-level detail, and interrupted manual runs can leave claimed rows with no durable failure marker until lease expiry. This hardening slice should make automated feedback triage resilient to per-group failures and stale/zombie claims without changing the human-loop semantics of draft Ideas.

## Research Findings

- `apps/api/src/services/platform-feedback-triage.ts` owns grouping, claim acquisition, diagnosis, draft Idea insertion/update, and claim release.
- `runPlatformFeedbackTriage` currently clears a claim in its catch block but rethrows the group failure, aborting later groups in the same sweep.
- The `platform_feedback_triages` table in `apps/api/src/db/migrations/0101_platform_feedback_triages.sql` and `apps/api/src/db/schema.ts` has claim fields but no retry/failure accounting fields.
- The manual superadmin trigger is `POST /api/admin/observability/feedback-triage` in `apps/api/src/routes/admin.ts`; it directly returns the service result.
- The hourly cron wrapper is `apps/api/src/scheduled/platform-feedback-hourly.ts`; it logs only whether triage rejected and simple success counters.
- Existing focused tests are `apps/api/tests/unit/services/platform-feedback-triage.test.ts`, `apps/api/tests/unit/scheduled/platform-feedback-triage-cron.test.ts`, and admin route coverage in `apps/api/tests/unit/routes/admin-observability.test.ts`.
- PR #1702/#1703 protections must be preserved: normalized/redacted grouping, allowlisted sources, bounded evidence refs, and untrusted evidence fencing in Idea content.
- PR #1704 config/rate-limit cleanup must be preserved: do not reintroduce duplicate env declarations or broad config changes.
- D1 schema changes must use append-only migrations and update Drizzle schema/tests together.
- Stored/logged failure reasons must be sanitized and bounded because source errors or diagnosis errors can contain sensitive operational data.

## Implementation Checklist

- [x] Add bounded triage failure/retry fields to `platform_feedback_triages` with an append-only D1 migration and matching Drizzle schema.
- [x] Add sanitized, bounded failure reason handling for per-group diagnosis/commit failures.
- [x] Change the sweep loop so one failing group increments structured failure accounting and later groups still run.
- [x] Make stale/zombie claim recovery deterministic across sweeps by reclaiming expired claims and recording retry/failure state.
- [x] Ensure manual trigger responses and cron logs expose enough sanitized aggregate failure detail for operators.
- [x] Preserve untrusted evidence fencing, source allowlisting, and redaction behavior in generated Ideas.
- [x] Add/adjust unit tests for per-group failure isolation, stale claim recovery/failure marking across two sweeps, and sanitized cron/manual diagnostics.
- [x] Run focused platform feedback triage tests.
- [x] Run API lint/typecheck and proportional repo validation.
- [x] Run Cloudflare/D1 and security review checks before finalizing.

## Acceptance Criteria

- A diagnosis failure for one error group does not prevent later groups in the same sweep from creating/updating Ideas.
- Claimed rows that expire without completion can be reclaimed or marked failed deterministically on a later sweep.
- Manual trigger responses and cron logs include sanitized, bounded failure/retry detail useful to admins/operators.
- No sensitive raw observability text, tokens, emails, or untrusted instructions are stored in trusted Idea text, failure reasons, route responses, or cron logs.
- Focused service, scheduled cron, and admin route tests pass.
- API lint/typecheck and proportional validation pass or any unrelated local failures are precisely documented and PR CI Test is green before merge.

## References

- `apps/api/src/services/platform-feedback-triage.ts`
- `apps/api/src/routes/admin.ts`
- `apps/api/src/scheduled/platform-feedback-hourly.ts`
- `apps/api/src/db/migrations/0101_platform_feedback_triages.sql`
- `apps/api/src/db/schema.ts`
- `apps/api/tests/unit/services/platform-feedback-triage.test.ts`
- `.claude/rules/09-task-tracking.md`
- `.claude/rules/32-cf-api-debugging.md`

