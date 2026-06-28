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

- [ ] Replace or delete `apps/api/tests/unit/node-lifecycle.test.ts` so no NodeLifecycle implementation-internal source-fragment assertions remain.
- [ ] Add behavior-focused service wrapper tests proving deterministic `idFromName(nodeId)` resolution and correct forwarding for `markIdle`, `markActive`, `tryClaim`, and `getStatus`.
- [ ] Ensure `NodeLifecycle` default/no-state behavior is covered by Miniflare or an equivalent behavioral test.
- [ ] Add an observable warm timeout override test that fails if the override is ignored.
- [ ] Add focused coverage proving workspace deletion alarms are preserved when `markActive` and `tryClaim` clear warm state.
- [ ] Make only tiny directly adjacent hygiene fixes if touched.
- [ ] Run focused NodeLifecycle tests first, then API package quality checks required by the repo.
- [ ] Run specialist review appropriate for API/Cloudflare/test behavior and address findings.

## Acceptance Criteria

- [ ] No source-fragment test remains for NodeLifecycle implementation internals.
- [ ] Behavior around service forwarding, default state, warm claiming, alarm preservation, and workspace deletion scheduling is covered by real tests.
- [ ] Focused tests pass locally.
- [ ] API package quality checks pass, or any intentionally skipped expensive checks are documented with exact commands run.
- [ ] Branch is pushed and a PR is opened according to `/do`; merge only if the normal `/do` gates are satisfied.

## References

- `apps/api/src/durable-objects/node-lifecycle.ts`
- `apps/api/src/services/node-lifecycle.ts`
- `apps/api/tests/unit/node-lifecycle.test.ts`
- `apps/api/tests/workers/node-lifecycle-do.test.ts`
- `apps/api/tests/workers/node-lifecycle-proxy.test.ts`
- `apps/api/src/middleware/node-auth.ts`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/35-vertical-slice-testing.md`
