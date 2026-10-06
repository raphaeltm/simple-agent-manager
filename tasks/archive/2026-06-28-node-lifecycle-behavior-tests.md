# NodeLifecycle behavior test remediation

## Problem

`apps/api/tests/unit/node-lifecycle.test.ts` reads implementation source files and asserts exact string fragments. That is brittle under legitimate refactors and does not prove the safety properties of the NodeLifecycle Durable Object or service wrapper. The slice needs behavior-focused coverage for deterministic Durable Object routing, warm-state transitions, timeout override behavior, and alarm preservation for workspace deletion.

## Research Findings

- `apps/api/src/services/node-lifecycle.ts` is a thin wrapper over `env.NODE_LIFECYCLE.idFromName(nodeId)` and RPC methods `markIdle`, `markActive`, `tryClaim`, and `getStatus`.
- `apps/api/src/durable-objects/node-lifecycle.ts` stores warm state in DO storage, updates D1 `nodes.warm_since`, multiplexes warm timeout and pending workspace deletion alarms, and keeps pending workspace deletion alarms when warm state is cleared.
- `apps/api/tests/workers/node-lifecycle-do.test.ts` uses Miniflare and real DO storage/D1 for direct state-machine coverage.
- `apps/api/tests/workers/node-lifecycle-proxy.test.ts` uses Miniflare to exercise the service wrapper against real DOs.
- `.claude/rules/02-quality-gates.md` explicitly prohibits source-contract tests for behavior-bearing code and calls out `readFileSync` + `toContain()` as false confidence.
- `.claude/rules/35-vertical-slice-testing.md` says Worker-to-Durable-Object behavior should be tested through realistic DO state rather than internal source assertions.

## Implementation Checklist

- [x] Replace or delete `apps/api/tests/unit/node-lifecycle.test.ts` so no NodeLifecycle implementation-internal source-fragment assertions remain.
- [x] Add behavior-focused service wrapper tests proving deterministic `idFromName(nodeId)` resolution and correct forwarding for `markIdle`, `markActive`, `tryClaim`, and `getStatus`.
- [x] Ensure `NodeLifecycle` default/no-state behavior is covered by Miniflare or an equivalent behavioral test.
- [x] Add an observable warm timeout override test that fails if the override is ignored.
- [x] Add focused coverage proving workspace deletion alarms are preserved when `markActive` and `tryClaim` clear warm state.
- [x] Make only tiny directly adjacent hygiene fixes if touched.
- [x] Run focused NodeLifecycle tests first, then API package quality checks required by the repo.
- [x] Run specialist review appropriate for API/Cloudflare/test behavior and address findings.

## Acceptance Criteria

- [x] No source-fragment test remains for NodeLifecycle implementation internals.
- [x] Behavior around service forwarding, default state, warm claiming, alarm preservation, and workspace deletion scheduling is covered by real tests.
- [x] Focused tests pass in CI; local focused worker execution is blocked by a `workerd` SIGSEGV before test import and documented below.
- [x] API package quality checks pass, or any intentionally skipped expensive checks are documented with exact commands run.
- [x] Branch is pushed and PR #1430 is opened according to `/do`; merge only if the normal `/do` gates are satisfied.

## Verification Notes

- `pnpm --filter @simple-agent-manager/api typecheck` passed.
- `pnpm --filter @simple-agent-manager/api lint` passed with existing warnings.
- `pnpm quality:source-contract-tests` passed and reported no prohibited patterns in 742 test files.
- `pnpm lint` passed with existing warnings.
- `pnpm typecheck` passed.
- `pnpm test` passed: API 352 files / 5624 tests, web 199 files / 2442 tests, plus package tests.
- `pnpm build` passed.
- GitHub Actions CI `Test` passed on PR #1430, validating the worker test suite in CI after local `workerd` startup failure.
- Staging deployment workflow `28309341946` passed with deploy and smoke-test jobs green.
- Focused worker tests are currently blocked locally by the Cloudflare worker runtime crashing before test import:
  - `pnpm --filter @simple-agent-manager/api test:workers -- tests/workers/node-lifecycle-do.test.ts tests/workers/node-lifecycle-proxy.test.ts` entered a repeated `workerd` SIGSEGV crash loop.
  - `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts --maxWorkers=1 tests/workers/node-lifecycle-proxy.test.ts` failed before importing tests with `Worker cloudflare-pool emitted error` caused by `workerd` SIGSEGV.
  - Retried with Node 20.20.2 plus PNPM 9.15.9 directly from Corepack; the same `workerd` SIGSEGV occurred.
  - An unrelated control run, `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts --maxWorkers=1 tests/workers/worker-smoke.test.ts`, also failed before importing tests with the same `workerd` SIGSEGV, confirming this is local worker-harness startup failure rather than a NodeLifecycle assertion failure.
- Test-engineer review: PASS with residual risk from the local worker-harness crash. Coverage is behavior-focused, uses Miniflare DO/D1 state, avoids internal function mocks, and covers service forwarding, default state, warm claim behavior, warm timeout override, alarm preservation, and due workspace deletion processing.
- Cloudflare-specialist review: PASS with residual risk from the local worker-harness crash. The tests use `runInDurableObject` only to arrange or observe DO storage/alarm state that is otherwise not public, and they exercise real DO storage plus D1 instead of source fragments.
- Constitution-validator review: PASS. No production hardcoded timeout/URL/limit values were added; the new numeric timeout values are scoped to behavioral test fixtures.
- Local-environment note: focused NodeLifecycle worker test execution could not complete in this VM because `workerd` crashes before worker test import. GitHub Actions CI `Test` passed for PR #1430, so the merge gate now depends on the remaining PR evidence checks and normal branch protection.

## References

- `apps/api/src/durable-objects/node-lifecycle.ts`
- `apps/api/src/services/node-lifecycle.ts`
- `apps/api/tests/unit/node-lifecycle.test.ts`
- `apps/api/tests/workers/node-lifecycle-do.test.ts`
- `apps/api/tests/workers/node-lifecycle-proxy.test.ts`
- `apps/api/src/middleware/node-auth.ts`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/35-vertical-slice-testing.md`
