# Fix Instant execution-step contract mismatch

## Problem

The Instant `cf-container` runtime writes `tasks.execution_step = 'agent_running'`, but
`agent_running` is not part of the shared `TASK_EXECUTION_STEPS` contract. API mapping
normalizes that persisted value to `null`, so Instant task progress is silently lost. The
2026-08-25 production stability audit lists this as P2 and asks for a small, separately
reviewed fix.

## Research findings

- Audit reference: library file `/reliability/audits/production-stability-audit-2026-08-25.md`
  file ID `01M0XK1XYNB34YB0X6Z41HM542`, priority P2 and sequenced step 6.
- Shared contract: `packages/shared/src/types/task.ts` defines `TASK_EXECUTION_STEPS`;
  `running` is present and `agent_running` is not.
- Instant writer before this fix: `apps/api/src/services/instant-session.ts` wrote
  `executionStep: 'agent_running'` after the ACP session starts.
- VM writer: `apps/api/src/durable-objects/task-runner/state-machine.ts`
  `transitionToInProgress()` writes `execution_step = 'running'` for the same agent-running
  phase.
- Existing invalid test seed before this fix: `apps/api/tests/workers/instant-runtime-recovery-failure.test.ts`
  seeds `executionStep: 'agent_running'`.
- Relevant rules: `.claude/rules/61*` requires cross-runtime agreement for equivalent
  runtime phases; `.claude/rules/62-tests-must-observe-the-real-trigger.md` requires tests
  to fail on the real invalid path rather than hand-feeding normalized values.

## Checklist

- [x] Add a mechanical guard that detects execution-step literals written outside the
      shared contract.
- [x] Verify the guard fails if `agent_running` or another invalid execution-step literal is
      reintroduced at a write site.
- [x] Change the Instant runtime writer to the canonical `running` step used by the VM
      runtime.
- [x] Update the worker test that seeded `agent_running` so it uses/asserts the canonical
      contract.
- [x] Keep the change narrow; do not modify deletion lifecycle writers or unrelated task
      lifecycle semantics.

## Acceptance criteria

- No source write site persists `agent_running` as `tasks.execution_step`.
- Invalid execution-step literals at guarded write sites fail the test suite.
- Instant runtime and VM runtime both report the agent-running phase as `running`.
- The existing worker recovery test no longer seeds the invalid literal.
- Targeted tests and repository quality gates pass.
