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

- [ ] Inventory TaskRunner tests and classify them as behavioral, pure helper, or source-contract in this task record.
- [ ] Add executable behavioral coverage for `handleAgentSession()` or its alarm path proving agent session row creation, retry idempotency, `agentStarted` gating, MCP token persistence/redaction, and `transitionToInProgress()` effects.
- [ ] Add executable behavioral coverage for failure cleanup/state-machine behavior proving terminal tasks are not overwritten, failed task fields/events are written, MCP tokens are revoked, and workspace cleanup failures are isolated from task failure.
- [ ] Replace or sharply reduce TaskRunner behavior source-text assertions. Keep only static wiring/configuration checks that are intentionally source-contract based and document why.
- [ ] Make only minimal testability extractions if dynamic imports make direct handler tests too awkward.
- [ ] Validate constitution compliance: no new hardcoded operational constants unless backed by existing defaults or env configuration.
- [ ] Run targeted API tests for changed TaskRunner coverage.
- [ ] Run broader validation required by `/do`: lint, typecheck, test, build as feasible before PR.
- [ ] Run local specialist reviews: task-completion-validator, cloudflare-specialist, constitution-validator, security-auditor, and test-engineer.

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
