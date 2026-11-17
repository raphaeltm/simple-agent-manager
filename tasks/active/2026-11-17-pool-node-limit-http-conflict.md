# Pool node limit returns an actionable HTTP conflict

## Problem and scope

External reporter leonceaklin observed HTTP 500 when creating a node at a compute pool's
`max_nodes` on self-hosted Infomaniak. Fix #2844 with a **draft PR only** against main.
Do not mark ready, merge, deploy to production, or create GitHub issues. Keep unrelated
credential and ACP fixes in the reporter's fork out of scope.

## Research and preflight

- Base: `e5c5aa4f77e6adf389a24b25b9470a69c24acbff`.
- Classification: cross-component-change, business-logic-change, public-surface-change,
  docs-sync-change. No external service contract or new configuration changes.
- `0167_capacity_pool_max_nodes.sql` atomically raises `capacity_pool_node_limit` at
  insertion. Keep this final enforcement and its counting semantics unchanged.
- `services/nodes.ts:createNodeRecord` walks wrapped DB errors and throws
  `CapacityPoolNodeLimitExceededError`, currently a plain Error.
- `routes/nodes.ts:POST /api/nodes` awaits that insert before routing telemetry and
  `scheduleDirectProvisioning`. `middleware/app-error-handler.ts:handleAppError` maps
  AppError to its public JSON/status, otherwise redacts to 500 INTERNAL_ERROR.
- Use the shared worker-core AppError (already re-exported by middleware/error), with
  409 / CAPACITY_POOL_NODE_LIMIT. Guidance must work for pool members without edit rights.
- `task-runner/node-provisioning-step.ts` matches the exception's **name**, releases its
  admission lease and delegates to `waitOrThrowForCapacityPoolNodeLimit`. Preserve this.
- Other createNodeRecord callers include workspace creation, Instant placement,
  deployment placement and provisioning infrastructure. They inherit structured AppError
  behavior without new per-route handling or changes to allocation enforcement.
- Existing route tests often supply their own error handler, leaving the production
  composition untested. Add a real-route/real-handler regression and use shipped trigger
  SQL with the existing SQLite-backed D1 adapter. Related lesson: rule 72's unreachable
  classifier and rule 62's real-trigger requirement.
- Principles II/IV/X/XI/XIII: discriminating tests first, actionable error, minimal
  subclass change, no new tunables, fail before provider work.
- SAM supplies the isolated output branch/workspace. Keep task documentation here on
  the feature branch so this draft-only task never pushes main or triggers production.

## Implementation checklist

- [x] Add POST /api/nodes tests using production handleAppError, real createNodeRecord,
  Drizzle and shipped 0167 trigger; assert 409/code/message, unchanged row count and no
  scheduling/provider work, successful under-limit control, unrelated failures remain 500.
- [x] Pin real service DB-trigger conversion and exception identity; test nested DB cause.
- [x] Exercise actual exception class in task-runner capacity waiting and fail policies;
  assert lease release, waiting alarm/state, and no provider call.
- [x] Run new regression tests on pre-fix code and record expected failure.
- [x] Extend the exception from shared AppError; preserve its name and DB classification.
- [x] Update API reference documentation and regression guidance.
- [ ] Run relevant lint/typecheck/test/build and full CI while PR stays draft.
- [ ] Complete specialist, test, documentation, constitution and completion reviews.
- [ ] Verify on staging, clean up fixtures and release lease; no production deployment.
- [ ] Publish draft PR with Closes #2844, reporter/fork credit, validation and review evidence;
  file nonblocking human-review inbox item and complete SAM task with PR URL.

## Acceptance criteria

1. A node insert rejected at the pool limit responds HTTP 409, JSON code
   CAPACITY_POOL_NODE_LIMIT and safe actionable guidance through the production handler.
2. Rejection writes no node and schedules no provisioning. Pool enforcement stays intact.
3. Unrelated failures remain redacted 500 INTERNAL_ERROR; under-limit creation still succeeds.
4. Task-runner lease release and existing waiting/fail policies work with the actual class.
5. Delivery remains draft against main, with attribution and a nonblocking review inbox item.

## References

- https://github.com/raphaeltm/simple-agent-manager/issues/2844
- https://github.com/zebra-pig/simple-agent-manager/pull/9 (evidence only; unrelated fixes excluded)
- SAM idea `01M7MBNVA0XMH3YCZJPAD20J2M`; task `01M7MBPJ6H0GDWE95E6K67C656`.

## Post-mortem

The user-visible failure was a 500 for an expected configured capacity rejection. The
domain exception did not implement the API error contract, so the global handler treated
it as an internal failure. Existing quota and trigger tests did not compose the route,
service conversion and production handler. Regression coverage at that boundary prevents
recurrence; relevant regression guidance is updated with this fix.

## Validation evidence

- Baseline root lint/typecheck passed.
- TDD: 3 expected pre-fix failures and 37 passing controls across 2 files; after fix,
  40 tests pass. Each independent Cloudflare and test reviewer reran all 40 successfully.
- Cloudflare, constitution and test specialist reviews PASS. Doc review refinements
  addressed: per-person scope described accurately, code paths cited, historical specs left alone.
- Instruction context-budget check passed. Broad checks, CI and staging pending.
