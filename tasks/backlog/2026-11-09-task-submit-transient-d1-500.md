# Task submit returns 500 on a transient D1 error in project authorization

SAM idea: `01M6Z3PER77CKTAW6JMJ200X7P`.

## Problem

Concurrent `POST /api/projects/:id/tasks/submit` requests can fail with `500 INTERNAL_ERROR`
when the first D1 read, `requireProjectCapability` (`services/submit-task-implementation.ts`),
hits a transient D1 error. The diagnostics classify it correctly (`failingOperation:
project_authorization`, `causeCode: D1_ERROR`, `d1Category: d1_transient`, see
`lib/d1-error-code.ts`), but nothing retries the read or returns a retryable status. The
caller gets a generic 500 for a read-only check that would very likely succeed a moment later.

## Context

Found on staging on 2026-11-09 at 02:38:16Z while verifying queue-aware placement (task
`2026-11-08-queue-aware-workspace-placement.md`, PR #2600). Four submits were sent at once for
one project. Three failed within 20 ms of each other, all in `project_authorization`, and the
fourth succeeded. The requests failed before the task insert, so no rows were left behind.
Request IDs: `6b3fb507-c3de-48ee-9232-eecced28e8cc`, `a27a70a7-688e-40a1-8486-e6bfb05765b1`,
`2d27b071-dbad-4000-99c5-576281c48182` (staging `platform_errors`). The code path is not
changed by PR #2600.

## Acceptance Criteria

- [ ] A transient D1 error on the read-only authorization step is retried a bounded,
      configurable number of times before failing
- [ ] If retries are exhausted, the response is a retryable status (for example 503 with
      `Retry-After`), not a generic 500
- [ ] No retry happens after any effect, such as a task insert
- [ ] Test: a D1 stub that fails once with a transient error and then succeeds yields a
      successful submit; a non-transient D1 error still fails immediately
