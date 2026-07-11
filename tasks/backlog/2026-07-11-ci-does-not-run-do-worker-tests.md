# CI does not run Durable Object worker-pool tests (`test:workers`)

## Problem

`apps/api` has two Vitest suites:
- `test` (`vitest run`) — Node-pool tests. **This is what CI runs** (`pnpm test` → `turbo run test`).
- `test:workers` (`vitest run --config vitest.workers.config.ts`) — Miniflare/workerd DO tests
  (`tests/workers/*.test.ts`: `project-data-do.test.ts`, `attention-markers.test.ts`,
  `project-data-service.test.ts`, `node-lifecycle-do.test.ts`, etc.).

Grepping `.github/workflows/ci.yml` for `test:workers` / `vitest.workers` returns **nothing** — CI
never runs the DO worker-pool suite. These same tests also reproducibly SIGSEGV locally in
miniflare 4.20260329 workerd before collection (reproduced on an unrelated `mailbox-do.test.ts`), so
they currently run **nowhere**.

## Impact (real incident)

During PR #1569 (origin-tag injected messages), the DO-side origin tests were written but never ran
(CI skips them, local SIGSEGV). A missing-propagation bug in `services/project-data.ts`
(`persistMessageBatch` dropped `origin` before the DO RPC) shipped through every local gate and CI,
and was only caught by manual staging E2E. The DO worker tests would not have caught it either
(they call the DO stub directly, bypassing the service), but the systemic gap is that a whole test
suite is dark.

## Acceptance Criteria

- [ ] Determine why workerd SIGSEGVs before collection in the current devcontainer (workerd version,
      resource limits, or vitest-pool-workers config) and whether CI's runner hits the same crash.
- [ ] Add a CI job (or extend the existing Test job) that runs `pnpm --filter @simple-agent-manager/api test:workers`
      and is a required merge gate, OR document explicitly why it cannot run and what compensating
      coverage exists.
- [ ] Confirm `project-data-do.test.ts` origin round-trip + `attention-markers.test.ts` exclusion
      tests execute in CI once the runner is fixed.
- [ ] If workerd cannot be stabilized, add Node-pool service-layer contract tests that cover the
      DO RPC boundaries the worker tests currently guard.

## References

- PR #1569 origin-tag injected messages
- `.claude/rules/10-e2e-verification.md`, `.claude/rules/35-vertical-slice-testing.md`
- Local crash: `pnpm --filter @simple-agent-manager/api test:workers` → "Worker exited unexpectedly"
