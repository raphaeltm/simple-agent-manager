# Harden Report Issue Configuration

## Problem

`GET /api/report-issue/config` currently enables the UI when `PLATFORM_FEEDBACK_PROJECT_ID` is present, even if that project ID does not exist in the deployment's D1 database. This creates a false enabled state: users can open Report Issue, but `POST /api/report-issue` fails because the configured feedback project cannot be found.

## Research Findings

- `apps/api/src/routes/report-issue.ts` uses `isReportEnabled(env)` in both config and POST preflight.
- `apps/api/src/services/report-issue.ts` implements `isReportEnabled(env)` as an env-presence check only.
- `submitReport()` already queries `projects` by the configured feedback project ID before creating an Idea, but the missing-project error currently exposes internal configuration detail.
- `packages/shared/src/types/report.ts` defines `ReportIssueConfig` as `{ enabled: boolean }`; no frontend shape change is needed.
- `apps/api/tests/unit/report-issue.test.ts` mocks Drizzle and already covers env-only enabled checks plus missing feedback project behavior.
- Prior task `tasks/archive/2026-07-29-report-issue-idea-flow.md` established the Report Issue flow and disabled state for unset env, but did not cover an env value that points at a project absent from the current D1 database.
- Related config principle: `.claude/rules/03-constitution.md` and `.specify/memory/constitution.md` Principle XI require deployment-specific IDs to come from configuration, not hardcoded values.

## Implementation Checklist

- [x] Add a small service helper to resolve the configured feedback project from D1.
- [x] Make config route asynchronous and return `{ enabled: false }` when the env var is absent, blank, or points at a missing project.
- [x] Keep `POST /api/report-issue` fail-closed:
  - [x] Missing env still returns not configured.
  - [x] Missing/invalid configured project returns a safe regular-user error.
  - [x] Server-side logs include enough context for maintainers without exposing secrets in API responses.
  - [x] No Idea is inserted for invalid config.
- [x] Preserve `ReportIssueConfig` shape.
- [x] Extend unit tests:
  - [x] no env -> disabled
  - [x] invalid env/project missing -> disabled
  - [x] valid env/project present -> enabled
  - [x] invalid env POST does not create an Idea and returns a safe error

## Acceptance Criteria

1. Regular users receive `{ enabled: false }` from `GET /api/report-issue/config` when `PLATFORM_FEEDBACK_PROJECT_ID` is missing or points to a project absent from D1.
2. Regular users receive `{ enabled: true }` only when the configured feedback project exists in D1.
3. `POST /api/report-issue` still refuses missing configuration and refuses missing configured projects without creating an Idea.
4. Missing-project POST errors do not disclose the configured project ID or internal env variable details to regular users.
5. Existing shared config response shape remains compatible.
6. Relevant API unit tests and required `/do` checks pass.
