# TaskRunner Behavioral Test Remediation

## Problem Statement

The TaskRunner Durable Object is a central backend runtime path that coordinates DO state, D1 task/session/workspace rows, KV MCP tokens, ProjectData session state, VM-agent session calls, retries, cleanup, observability, and orchestrator notifications. Current coverage mixes useful Miniflare and pure helper tests with broad source-text assertions that mostly prove strings exist rather than behavior works. That creates false confidence for this risk profile and makes behavior-preserving refactors brittle.

Focus this task on the backend runtime slice under `apps/api/src/durable-objects/task-runner/` and related API tests. Do not touch unrelated content, docs, or local `.codex` files.

## Research Findings

- `apps/api/tests/workers/task-runner-do.test.ts` is genuinely behavioral Miniflare coverage for `start()`, `advanceWorkspaceReady()`, `getStatus()` redaction, alarm no-op behavior, and one failure path through the DO alarm.
- `apps/api/tests/unit/task-runner-health-check.test.ts` contains valuable pure readiness tests for `isNodeAgentReadyForWorkspaceDispatch`, including timestamp invariants and randomized signal timing, but also contains source-text checks around health wiring.
- `apps/api/tests/unit/task-runner-do-state.test.ts` is mostly source-contract testing across TaskRunner state, alarm dispatch, step handlers, failure handling, cleanup, and configuration.
- `apps/api/tests/integration/task-runner-do-infra.test.ts` is source-contract oriented but some checks guard static Cloudflare wiring and top-level configuration that is hard to execute in unit tests.
- `handleAgentSession()` is already extracted in `agent-session-step.ts`, but dynamically imports service functions (`node-agent`, `mcp-token`, `project-data`, `ulid`, `drizzle-orm/d1`). Direct behavioral tests may need small testability extractions for prompt/label construction or dependency boundaries.
- `transitionToInProgress()` and `failTask()` are exported from `state-machine.ts`, making D1/DO-state behavioral coverage practical without broad architecture changes.

## Implementation Checklist

- [x] Inventory TaskRunner tests and classify them as behavioral, pure helper, or source-contract in this task record.
- [x] Add executable behavioral coverage for `handleAgentSession()` or its alarm path proving agent session row creation, retry idempotency, `agentStarted` gating, MCP token persistence/redaction, and `transitionToInProgress()` effects.
- [x] Add executable behavioral coverage for failure cleanup/state-machine behavior proving terminal tasks are not overwritten, failed task fields/events are written, MCP tokens are revoked, and workspace cleanup failures are isolated from task failure.
- [x] Replace or sharply reduce TaskRunner behavior source-text assertions. Keep only static wiring/configuration checks that are intentionally source-contract based and document why.
- [x] Make only minimal testability extractions if dynamic imports make direct handler tests too awkward.
- [x] Validate constitution compliance: no new hardcoded operational constants unless backed by existing defaults or env configuration.
- [x] Run targeted API tests for changed TaskRunner coverage.
- [x] Run broader validation required by `/do`: lint, typecheck, test, build as feasible before PR.
- [x] Run local specialist reviews: task-completion-validator, cloudflare-specialist, constitution-validator, security-auditor, and test-engineer.

## Implementation Notes

- Added `buildTaskAgentSessionLabel()` and `buildTaskInitialPrompt()` in `agent-session-step.ts` to remove duplicated test-only prompt logic and enable direct executable coverage.
- The prompt tests now use the production helper directly and fixture attachments match the shared `TaskAttachment` shape (`size`).
- Added `task-runner-agent-session.test.ts` for direct `handleAgentSession()` behavior across D1 insert values, retry idempotency, `agentStarted` gating, MCP token persistence, VM start payload, ACP session transitions, and final in-progress transition.
- Extracted `redactTaskRunnerStatus()` so `getStatus()` token redaction is covered by the normal unit suite even when the local Worker test runtime is unavailable.
- Added `task-runner-state-machine.test.ts` for direct `transitionToInProgress()` and `failTask()` behavior with an executable D1/KV/storage shim and mocked external cleanup/token boundaries.
- Replaced `task-runner-do-state.test.ts` with `task-runner-static-wiring.test.ts`, limited to static public/storage contract checks that are intentionally not runtime behavior.
- Reduced `task-runner-health-check.test.ts` to pure readiness helper invariants and randomized timestamp checks.
- Trimmed `task-runner-do-infra.test.ts` by removing initial-prompt/idempotency source-text checks now covered by executable tests. Remaining source checks are static Cloudflare/env/config wiring.
- Attempted `pnpm --filter @simple-agent-manager/api test:workers -- tests/workers/task-runner-do.test.ts`, but local workerd repeatedly segfaulted before reporting test results. The attempted worker-test additions were moved into normal unit tests to avoid relying on the crashing worker runtime for the new coverage.

## Validation

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/durable-objects/task-runner-agent-session.test.ts tests/unit/durable-objects/task-runner-state-machine.test.ts tests/unit/durable-objects/task-runner-initial-prompt.test.ts tests/unit/task-runner-health-check.test.ts tests/unit/task-runner-static-wiring.test.ts tests/integration/task-runner-do-infra.test.ts` — passed, 65 tests.
- `pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `pnpm --filter @simple-agent-manager/api lint` — passed with existing warnings only.
- `pnpm --filter @simple-agent-manager/api test` — passed, 354 files / 5508 tests.
- `pnpm --filter @simple-agent-manager/api build` — passed.
- `pnpm typecheck` — passed.
- `pnpm lint` — passed with existing warnings only.
- `pnpm test` — passed, all 19 turbo tasks; API 354 files / 5508 tests and web 199 files / 2446 tests.
- `pnpm build` — passed, all 9 turbo tasks.
- `pnpm --filter @simple-agent-manager/api test:workers -- tests/workers/task-runner-do.test.ts` — local workerd repeatedly crashed with signal 11 before useful test results; no code assertion failure was reported.

## Specialist Review Results

- `$task-completion-validator` — PASS. Research findings, checklist items, and acceptance criteria are covered by the diff and validation evidence. No UI/backend propagation or multi-resource selection scope.
- `$cloudflare-specialist` — PASS. The tests exercise D1/KV/DO state through boundary shims, retain static Cloudflare wiring checks only where execution is impractical, and add no wrangler or binding changes.
- `$constitution-validator` — PASS. No new production operational constants, limits, timeouts, identifiers, or deployment-specific URLs. The MCP URL remains derived from `BASE_DOMAIN`; the test literal verifies that derivation.
- `$security-auditor` — PASS. MCP token persistence, revocation, and status redaction are covered; the helper returns a sanitized copy without mutating stored state.
- `$test-engineer` — PASS. Source-contract assertions were materially reduced and replaced with executable TaskRunner behavioral coverage. Remaining source-contract tests are explicitly limited to static public/storage/wiring contracts.

## Acceptance Criteria

- Behavioral tests cover the required agent-session and failure cleanup/state-machine cases.
- Source-text assertions for TaskRunner runtime behavior are removed or materially reduced.
- Any retained source-contract tests are limited to static wiring/configuration and clearly documented.
- No production behavior changes are introduced solely to satisfy tests unless a real bug is exposed.
- Targeted API tests pass locally.
- Branch is pushed, PR is opened, checks are monitored, and merge/deploy workflow follows project policy.

## References

- `apps/api/src/durable-objects/task-runner/index.ts`
- `apps/api/src/durable-objects/task-runner/state-machine.ts`
- `apps/api/src/durable-objects/task-runner/agent-session-step.ts`
- `apps/api/src/durable-objects/task-runner/readiness.ts`
- `apps/api/src/durable-objects/task-runner/types.ts`
- `apps/api/tests/workers/task-runner-do.test.ts`
- `apps/api/tests/unit/task-runner-do-state.test.ts`
- `apps/api/tests/unit/task-runner-health-check.test.ts`
- `apps/api/tests/integration/task-runner-do-infra.test.ts`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/03-constitution.md`
- `.claude/rules/35-vertical-slice-testing.md`
