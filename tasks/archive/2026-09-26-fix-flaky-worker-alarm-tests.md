# Fix flaky worker alarm tests

## Problem

Two worker-runtime tests race alarms that they schedule themselves under load:

- `project-data-storage-safety.test.ts` can read `state.storage.getAlarm()` while a runtime-delivered ProjectData alarm is already running, producing a transient `null`.
- `reserved-task-submission-task-runner.test.ts` can let the TaskRunner's immediate first alarm advance from `node_selection` before the test samples the state.

These failures are unrelated to product changes and delayed production validation on 2026-09-26.

## Research Findings

- SAM task `01M3FED1QMBY9R6P17DSSAQ7X9` captured CI evidence showing the ProjectData test had two alarm completions: the manual `instance.alarm()` and a second runtime-fired gated alarm.
- The 2026-09-25 backlog item `tasks/backlog/2026-09-25-timing-sensitive-workers-tests.md` names the TaskRunner overlap test as the sibling timing-sensitive failure.
- Rule 62 applies: ordering-dependent tests must own the critical ordering rather than sampling after an uncontrolled scheduler turn.
- The attention-expiry worker test already controls this class by deleting the runtime alarm and pausing timer delivery around the manual alarm.

## Checklist

- [x] Read the source SAM task and confirm the ProjectData ordering race.
- [x] Check the 2026-09-25 backlog item for the second flaky test.
- [x] Update the ProjectData storage-safety test to assert re-arm scheduling inside the same controlled Durable Object turn.
- [x] Update the TaskRunner overlap test to pause both direct and transactional alarm scheduling while testing first-start deduplication.
- [x] Run the focused worker tests repeatedly.
- [x] Run required validation and local review.
- [x] Open PR, get CI green, complete CodeRabbit, merge.
  - _Reconciled 2026-09-30:_ PR #2156 merged 2026-09-26T23:37Z (`398fb92d6`) after green CI; production deploy run 36280892213.

## Acceptance Criteria

- [x] No retries or longer timeouts are used as the fix.
- [x] The affected tests control alarm ordering deterministically.
- [x] Focused repeated worker-test runs are stable.
- [x] PR CI is green and CodeRabbit gate is complete before merge.
  - _Reconciled 2026-09-30:_ PR #2156 merged with green CI; its CodeRabbit outcome is recorded in the PR.

## Validation

- Focused exact-case Workers run passed 20/20:
  `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/project-data-storage-safety.test.ts tests/workers/reserved-task-submission-task-runner.test.ts -t "deletes only bounded terminal-session event-log cleanup candidates|deduplicates overlapping real TaskRunner first-start calls before allocation" --reporter dot`
- Full affected worker files passed: 2 files, 50 tests.
- `pnpm lint` passed with existing warnings in unrelated UI files.
- `pnpm typecheck` passed; the www package reported its existing Astro template baseline count.
- `pnpm build` passed.
- `pnpm --filter @simple-agent-manager/api test` passed: 770 files, 10,580 tests.
- `pnpm test` completed earlier with 1 unrelated timeout in `tests/unit/routes/project-capacity-pools.test.ts` and 10,579 passing tests. The timed-out test passed in isolation in 3.95s before the full API package suite passed.

## Local Review

### test-engineer

PASS. The changed tests keep the existing vertical Worker/Durable Object coverage, preserve realistic persisted state, and avoid empty internal mocks. The new helpers pause only alarm delivery while the real `alarm()`/`start()` logic, SQLite storage, cleanup queries, and D1-facing setup still run.

### cloudflare-specialist

PASS. The changes are limited to Miniflare/Workers tests and do not change Worker configuration, bindings, D1 schema, KV/R2 usage, or production Durable Object code. The helpers restore spies and delete synthetic alarms in `finally` blocks to preserve test isolation.

### constitution-validator

PASS. No production business logic, URLs, timeouts, limits, or deployment identifiers were added. Existing test fixture values remain test data.

### task-completion-validator

PASS. Research findings map to checklist items and the diff covers both planned test fixes. Acceptance criteria are covered by repeated focused worker runs, full affected-file worker runs, and repository validation. No UI/backend propagation or multi-resource selection concerns apply.

---

_Reconciled 2026-09-30 (weekly queue reconciliation): shipped via PR #2156 (`398fb92d6`, merged 2026-09-26), first successful production deploy run 36280892213._
