# VM Size Minimum Selection

## Problem

Project/task VM size selection currently resolves a requested size, but node reuse treats size as a soft preference. This means a task that requests `large` can reuse an existing or warm `medium` node when no exact large node is available.

The intended behavior is minimum-capacity semantics: smaller work may run on larger nodes, but larger work must not run on smaller nodes.

## Research Findings

- Project default VM size is stored on `projects.defaultVmSize` / `default_vm_size` in `apps/api/src/db/schema.ts`.
- Task submit resolves VM size as explicit task value, then agent profile override, then project default, then platform default in `apps/api/src/routes/tasks/submit.ts`.
- TaskRunner auto-provisioning creates new nodes with `state.config.vmSize` in `apps/api/src/durable-objects/task-runner/node-steps.ts`.
- Hetzner provider maps abstract `large` to `cx43` in `packages/providers/src/hetzner.ts`.
- The bug is in reuse selection: warm and existing nodes sort by exact size match but do not reject undersized nodes.
- Staging D1 inspection on 2026-05-01 found no project currently set to `default_vm_size = 'large'`, so the exact reported incident could not be confirmed from persisted staging state.
- Task records do not persist the resolved requested VM size, which makes post-hoc auditing harder.

## Implementation Checklist

- [x] Add shared helper that compares VM sizes as ordered capacity tiers.
- [x] Use the helper in standalone node selector warm-node filtering.
- [x] Use the helper in standalone node selector existing-node filtering.
- [x] Use the helper in TaskRunner warm-node filtering.
- [x] Use the helper in TaskRunner existing-node filtering.
- [x] Reject explicitly selected preferred nodes that are smaller than requested.
- [x] Add tests proving larger nodes satisfy smaller requests and smaller nodes do not satisfy larger requests.
- [x] Run focused tests and typechecks.
- [x] Run full lint/typecheck/test validation.
- [ ] Complete `/do` specialist review and staging verification.

## Acceptance Criteria

- [x] `small` requests can use `small`, `medium`, or `large` nodes.
- [x] `medium` requests can use `medium` or `large` nodes.
- [x] `large` requests only use `large` nodes.
- [x] Warm-node reuse follows the same minimum-size rule.
- [x] Existing-node reuse follows the same minimum-size rule.
- [x] Explicit preferred node selection cannot bypass the minimum-size rule.
- [ ] Staging verification confirms the changed behavior or provides concrete evidence if full VM provisioning is blocked.

## Validation Log

- 2026-05-01: Focused builds/tests/typechecks passed for `shared`, `providers`, `cloud-init`, and `api`.
- 2026-05-01: `pnpm lint` passed with existing warnings.
- 2026-05-01: `pnpm typecheck` passed.
- 2026-05-01: Initial `pnpm test` run exposed an unrelated `ButtonGroup` assertion that depended on CSS zero-value serialization.
- 2026-05-01: Fixed the `ButtonGroup` test to accept equivalent `0` / `0px` style serialization.
- 2026-05-01: `pnpm --filter @simple-agent-manager/ui test -- ButtonGroup` passed.
- 2026-05-01: Full `pnpm test` rerun passed: 19 packages successful.

## References

- `.claude/rules/02-quality-gates.md`
- `.claude/rules/10-e2e-verification.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/32-cf-api-debugging.md`
