# Workers-pool vitest tests do not run in CI

## Problem

The `@cloudflare/vitest-pool-workers` test suite under `apps/api/tests/workers/**`
(real D1 + Durable Object vertical-slice tests, run via
`vitest.workers.config.ts` / `pnpm --filter @simple-agent-manager/api test:workers`)
is **not executed by any CI workflow**:

- `apps/api/vitest.config.ts` sets `exclude: ['tests/workers/**']`, so the
  default `pnpm test` / `pnpm test:coverage` (what CI runs — `ci.yml` lines ~199
  and ~371) skips the entire workers pool.
- No workflow in `.github/workflows/` invokes `test:workers`.

Consequence: the workers-pool "cross-runtime" / vertical-slice tests (rule 10 /
rule 35 capability coverage) provide **zero CI protection**. They only run when a
developer manually runs `test:workers` locally.

## Evidence (discovered 2026-07-11, during Priority 5 — PR #1567)

Two pre-existing tests in `apps/api/tests/workers/scheduled-stuck-tasks.test.ts`
silently broke when the TaskRunner liveness logic changed, and nothing caught it:

- "fails in_progress task past hard timeout" — asserted `error_message` contains
  `'hard timeout'`; the new liveness-gated reason no longer contains that string.
- "skips in_progress task with recent heartbeat" — asserted
  `heartbeatSkipped >= 1`; under the new task-scoped liveness a node heartbeat
  alone no longer counts as a skip, so the counter stays `0`.

Both were fixed in PR #1567, but only by manual code reading — CI was green the
whole time because the workers pool never ran.

## Acceptance criteria

- [ ] The workers-pool suite (`test:workers`) runs in CI on every PR that touches
      `apps/api/**` (either as a dedicated job or folded into the Test job).
- [ ] The job is reliable in the CI runner (investigate `workerd` "Worker exited
      unexpectedly" crashes seen in some sandboxed environments; may need a
      runner/resource or `@cloudflare/vitest-pool-workers` config adjustment).
- [ ] A deliberately-broken workers-pool assertion fails the CI job (prove the
      gate works).
- [ ] Restore the workers vertical-slice for the "genuinely-live task is skipped"
      path in `scheduled-stuck-tasks.test.ts` (seed a live task-scoped ACP session
      in the ProjectData DO — `createAcpSession` + `transitionAcpSession` to
      `running` with a matching `workspaceId` and recent heartbeat). PR #1567
      converted that test to the fail-safe "inconclusive → preserved" path because
      the workers pool could not be run in the task workspace; the live-skip
      vertical slice should be re-added once the pool runs in CI.

## Context

- Discovered while completing Priority 5 (idea `01KT90PKF6167SXZ9YZY0R26MM`,
  PR #1567) — TaskRunner DO/D1 lifecycle reconciliation.
- Related rules: `.claude/rules/10-e2e-verification.md`,
  `.claude/rules/35-vertical-slice-testing.md`.
