# Require the real Durable Object worker suite in CI

## Problem

The API's `test:workers` tier is the only suite that runs worker integration files inside workerd with real Durable Object `SqlStorage`, D1, KV, and R2 bindings. The default Vitest config excludes that directory, while CI previously ran only `pnpm test:coverage`. The entire cross-runtime tier therefore provided no merge protection.

After integrating current `main` on 2026-07-20, the directory contains 37 test files rather than the ten present at the PR's original merge base. The gate now keeps the existing `tests/workers/**/*.test.ts` wildcard instead of a seven-file allowlist, so current and future worker tests cannot silently fall out of CI.

Local SAM sandboxes also make workerd fail before collection. The March 2026 binary pinned through `@cloudflare/vitest-pool-workers@0.14.0` repeatedly received SIGSEGV, including with one worker and an unrelated smoke file. Updating to the Vitest 4-compatible 0.16.18 pool moves to the June runtime and makes the failure terminate visibly, but the sandbox still delivers SIGSEGV before import. Native GitHub Actions is therefore authoritative for this gate.

## Consolidated provenance

This record supersedes and preserves the findings from:

- `tasks/backlog/2026-07-11-workers-pool-tests-not-run-in-ci.md` — discovered during PR #1567 after scheduled stuck-task assertions silently diverged.
- `tasks/backlog/2026-07-11-ci-does-not-run-do-worker-tests.md` — documented PR #1569's origin propagation incident and the pre-collection SIGSEGV.
- The original `tasks/backlog/2026-07-16-wire-test-workers-into-ci.md` — added the deferred large-`listSessions` real-DO slice.

The two July 11 files are removed by this task so there is one canonical lifecycle record.

## Research findings

- `apps/api/vitest.config.ts` excludes `tests/workers/**`; this is intentional because the worker pool needs a separate runtime.
- `apps/api/package.json:test:workers` was not a turbo task and no workflow invoked it.
- Archived tasks consistently reproduce workerd signal 11 before test import across Node versions, files, and `maxWorkers=1`, isolating the local issue from assertions and fixture state.
- `@cloudflare/vitest-pool-workers@0.14.0` pinned Miniflare/workerd 1.20260329.1. Version 0.16.18 supports Vitest 4 and pins a newer June workerd runtime.
- A required path-filtered job must still report on unrelated PRs; skipping the entire job can strand branch protection. The job therefore always exists and runs an explicit no-op step when irrelevant.
- Worker runtime concurrency is the primary resource risk. `WORKERS_TEST_MAX_WORKERS` and `WORKERS_TEST_TIMEOUT_MS` centralize the serialized default and per-test/hook timeout.
- `recoverStuckTasks` proves task-scoped liveness through D1 workspace/node state plus ProjectData ACP session state; a node heartbeat alone is insufficient.
- `ProjectData.listSessions` must query only the requested page and must not load large message history while enriching session rows.

## Implementation checklist

- [x] Reproduce and isolate the local pre-collection workerd crash with a minimal smoke file and one worker.
- [x] Pin the Vitest 4-compatible Cloudflare worker pool and preserve fatal startup failures.
- [x] Add a visible deterministic `Durable Object Workers` CI job with pinned actions, `contents: read`, and worker-relevant path detection.
- [x] Run `pnpm --filter @simple-agent-manager/api test:workers` on native `ubuntu-24.04` with centralized configurable worker/time bounds.
- [x] Add a real-D1 → reconciler → ProjectData DO vertical slice proving a genuinely live task-scoped ACP session is skipped.
- [x] Add a real DO SQLite slice with 1,500 `chat_sessions` and 5,000 messages proving `listSessions` returns a bounded page without throwing.
- [x] Push a deliberately wrong assertion and record the worker job failure, then restore the correct assertion in a later commit.
- [x] Restore the wildcard suite so all current worker test files enter the native CI gate automatically.
- [ ] Complete specialist reviews and address all correctness findings.
- [x] Run supported local full gates.
- [x] Remove the two duplicate backlog records and preserve their provenance here.
- [ ] Obtain the coordinator's staging lease or equivalent CI-only gate release before merge.
- [ ] Merge only with all required checks green and monitor main/production workflow health.

## Acceptance criteria

- [x] Local instability has evidence-based diagnosis: sandbox workerd receives SIGSEGV before collection across two runtime versions; the failure remains non-zero and visible.
- [x] Every PR reports one deterministic `Durable Object Workers` check; worker-relevant paths run the real pool and unrelated paths run an explicit no-op.
- [x] CI actions are SHA-pinned and workflow permissions remain least-privilege `contents: read`.
- [x] Runtime bounds are centralized/configurable, with one worker and 30-second test/hook defaults plus a 30-minute job ceiling.
- [x] Commit `199901d5f` deliberately expected 1,501 sessions; CI run `29591413300`, worker job `87921526019`, ran all seven files and failed with `expected 1500 to be 1501`. Commit `4248088f4` restores 1,500.
- [x] CI run `29592232988`, worker job `87923979412`, passes 7 files and 228 tests; verbose logs visibly include the required named files and cases.
- [x] Live task-scoped ACP reconciliation and large-history bounded `listSessions` execute through real DO/D1 storage rather than mocks.
- [ ] Full supported local gates and all required specialist reviews pass.
- [x] The three open backlog records are consolidated into this single canonical record with provenance.
- [ ] Coordinator release is recorded before merge; no shared staging deployment occurs without it.

## Data-flow verification

1. PR path classification: `.github/workflows/ci.yml:changes` emits `api-workers`.
2. Deterministic merge check: `.github/workflows/ci.yml:durable-object-workers` either reports the explicit no-op or runs the real suite.
3. Runtime entry: `apps/api/package.json:test:workers` loads `apps/api/vitest.workers.config.ts`.
4. Real runtime/storage: `@cloudflare/vitest-pool-workers` executes every `tests/workers/**/*.test.ts` file with the configured Worker, DO, D1, KV, and R2 bindings.
5. Reconciliation slice: `scheduled-stuck-tasks.test.ts` seeds D1 node/workspace/task state and ProjectData ACP state, calls `recoverStuckTasks`, and asserts the task remains `in_progress`.
6. Listing slice: `project-data-do.test.ts` seeds real DO SQLite rows/message history, calls the public `listSessions` RPC, and asserts a bounded 25-row page, total, order, and `hasMore`.

## Verification evidence

- Historical branch-local `pnpm --filter @simple-agent-manager/api test:workers`: 7 files, 228 tests passed.
- Current-main local full wildcard run: fails visibly before collection with the documented sandbox-only workerd signal 11 when loading the production Worker entrypoint; it is not treated as a pass or hidden by the rejection filter.
- Current-main native GitHub Actions wildcard result: pending on the repair commit; merge is blocked unless all 37 files collect and pass there.
- Local `pnpm test`: 19/19 Turbo tasks passed; API 433 files, 6,154 tests passed.
- Local `pnpm build`: 9/9 Turbo tasks passed.
- API lint: zero errors (existing warning baseline); API typecheck passed.
- Independent review on 2026-07-20 found the seven-file allowlist, unrelated production observability fields, and broad rejection patterns unsafe. The allowlist is removed, the production behavior change is dropped, and exact anchored rejection-policy tests now prove unexpected errors remain fatal. Fresh specialist review is still required before merge.

## Post-mortem

### What broke

Real Durable Object/SqlStorage tests existed but were dark in CI. Regressions in scheduled reconciliation and message-origin propagation could pass every required check.

### Root cause

The worker suite remained a standalone script while the default suite explicitly excluded its directory. Local sandbox crashes were treated as a reason the tier could not be run, but no native CI runner path was established.

### Why it was not caught

There was no deterministic required check representing the tier, and a skipped test directory was indistinguishable from successful coverage in the existing Test job.

### Class of bug

Dark test tier / mock-hidden cross-runtime integration gap.

### Process fix

CI now has a named required worker-pool check that always reports, executes the actual package script on relevant changes, and fails on runtime crashes or assertions. This task record also requires red/green gate proof and preserves duplicate discovery provenance.

## References

- PR #1619
- GitHub Actions red-proof run 29591413300, worker job 87921526019
- GitHub Actions green run 29592232988, worker job 87923979412
- `.github/workflows/ci.yml`
- `apps/api/vitest.workers.config.ts`
- `apps/api/tests/workers/project-data-do.test.ts`
- `apps/api/tests/workers/scheduled-stuck-tasks.test.ts`
- `.claude/rules/10-e2e-verification.md`
- `.claude/rules/35-vertical-slice-testing.md`
