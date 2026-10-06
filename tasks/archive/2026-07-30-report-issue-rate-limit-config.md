# Report Issue POST rate limit and config consistency

## Problem

`POST /api/report-issue` creates draft Ideas in the maintainer feedback project from an externally reachable, authenticated app endpoint. The endpoint currently validates auth, approval, payload shape, feedback project configuration, untrusted content fencing, and secret redaction, but it does not consume a bounded request budget. Fable also flagged that Report Issue max-length configuration is partially wired: API `Env` and service parsing exist, but deploy/sync plumbing may not forward the env vars.

## Research findings

- `apps/api/src/routes/report-issue.ts` mounts authenticated/approved `GET /config` and `POST /` handlers. Rate limiting belongs on `POST /` after auth context is established and before JSON validation/report creation work.
- `apps/api/src/middleware/rate-limit.ts` is the project-standard KV-backed middleware. User-scoped limits key by `auth.user.id` and fall back to IP only if auth context is unexpectedly missing. `RateLimitError` produces status `429`, code `RATE_LIMIT_EXCEEDED`, `Retry-After`, and `X-RateLimit-*` headers through the standard error middleware.
- `apps/api/src/services/report-issue.ts` already parses `REPORT_ISSUE_TITLE_MAX_LENGTH`, `REPORT_ISSUE_DESCRIPTION_MAX_LENGTH`, and `REPORT_ISSUE_CONTENT_MAX_LENGTH` with shared defaults.
- `apps/api/src/env.ts` already declares the Report Issue max-length env vars.
- `scripts/deploy/sync-wrangler-config.ts` and `.github/workflows/deploy-reusable.yml` currently forward `PLATFORM_FEEDBACK_PROJECT_ID` and platform feedback triage envs, but not the Report Issue max-length env vars.
- `scripts/quality/sync-wrangler-config.test.ts` and `scripts/quality/deploy-reusable-workflow.test.ts` cover this deployment env forwarding pattern.
- `.env.example` currently has no `PLATFORM_FEEDBACK_PROJECT_ID` entry, so the prior duplicate is already gone and should not be churned.
- Relevant retained lesson: `tasks/archive/2026-04-12-rate-limit-bypass-dompurify-tighten.md` records that user-scoped rate limiting must not bypass protection when auth context is missing; preserve the existing IP fallback behavior.

## Implementation checklist

- [x] Add a Report Issue POST default rate-limit key to `DEFAULT_RATE_LIMITS` and `Env`.
- [x] Add a small Report Issue POST middleware wrapper using the existing KV rate-limit helper.
- [x] Apply the middleware to `POST /api/report-issue` with a user-scoped key prefix.
- [x] Add focused API route tests proving allowed requests receive project-standard rate-limit headers and exhausted requests return project-standard `429` shape/status without creating an Idea.
- [x] Forward `REPORT_ISSUE_TITLE_MAX_LENGTH`, `REPORT_ISSUE_DESCRIPTION_MAX_LENGTH`, and `REPORT_ISSUE_CONTENT_MAX_LENGTH` through deploy workflow env and sync-wrangler config.
- [x] Update deployment plumbing tests for the Report Issue max-length envs.
- [x] Verify `.env.example` still has no duplicate `PLATFORM_FEEDBACK_PROJECT_ID`; do not edit it unless a duplicate exists.
- [x] Preserve trusted metadata/PAT redaction behavior covered by existing Report Issue tests.
- [x] Run focused Report Issue tests, API lint/typecheck, and proportional repository validation.
- [x] Run env-validator, security-auditor, and task-completion-validator.

## Acceptance criteria

- `POST /api/report-issue` enforces a bounded, configurable, authenticated-user-scoped rate limit using the existing project middleware and standard `429` response shape.
- Rate-limit behavior is covered by focused route tests, including the standard response body/status and no draft Idea creation when blocked.
- Report Issue max-length env vars are consistently declared, parsed, and forwarded by deployment/sync plumbing if set.
- `.env.example` duplicate `PLATFORM_FEEDBACK_PROJECT_ID` entries are reconciled only where still present.
- PR remains scoped to Report Issue abuse protection and directly related config consistency; no platform feedback triage resilience/usability work is included.
- Existing trust-boundary/PAT redaction behavior remains intact.

## Validation log

- 2026-07-30: Root `.env.example` contains no `PLATFORM_FEEDBACK_PROJECT_ID` or `REPORT_ISSUE_*` entries. Follow-up review found `apps/api/.env.example` still duplicated `PLATFORM_FEEDBACK_PROJECT_ID`; removed the stale triage-block duplicate and kept the canonical Report Issue / Platform Feedback entry.
- 2026-07-30: `pnpm --filter @simple-agent-manager/api test -- tests/unit/report-issue.test.ts tests/unit/routes/report-issue.test.ts` passed (23 tests). Existing Report Issue service tests preserve trust-boundary/PAT redaction behavior.
- 2026-07-30: `pnpm vitest run scripts/quality/sync-wrangler-config.test.ts scripts/quality/deploy-reusable-workflow.test.ts` passed (33 tests).

- 2026-07-30: `pnpm --filter @simple-agent-manager/api lint` passed (0 errors; existing warnings).
- 2026-07-30: `pnpm --filter @simple-agent-manager/api typecheck` passed.
- 2026-07-30: `pnpm lint` passed (0 errors; existing warnings).
- 2026-07-30: `pnpm typecheck` passed.
- 2026-07-30: `pnpm build` passed (existing `@simple-agent-manager/api#build` output warning).
- 2026-07-30: `pnpm test` passed (19/19 tasks; API 476 files / 6510 tests; web 236 files / 2844 tests).
- 2026-07-30: env-validator result: PASS. Report Issue max-length and rate-limit envs are declared in `Env`, parsed/defaulted by API code, forwarded by deployment/sync-wrangler plumbing, and documented in `apps/api/.env.example`; `PLATFORM_FEEDBACK_PROJECT_ID` now has one canonical example entry.
- 2026-07-30: security-auditor result: PASS. POST remains authenticated/approved, user-scoped rate limiting runs before validation/report creation, blocked requests use the standard `429` shape and do not create Ideas, and existing tests preserve trust-boundary/PAT redaction. Existing KV increment behavior is best-effort/non-atomic, appropriate for abuse bounding rather than strict quota accounting.
- 2026-07-30: task-completion-validator result: PASS. Diff matches the requested narrow scope: Report Issue POST rate limiting, directly related env/deploy consistency, duplicate env-example cleanup, and focused tests.
