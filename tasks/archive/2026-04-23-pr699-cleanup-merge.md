# PR #699: Dead Code Removal and Minor Fixes

## Problem Statement

PR #699 ("chore: remove dead code and fix minor issues") has been open since 2026-04-14. It contains 7 valid cleanup fixes that are all still applicable to current main. The PR needs to be rebased/redone fresh with comprehensive tests for each change.

## Research Findings

All 7 changes from PR #699 verified as still applicable on current main (2026-04-23):

1. **`apps/api/src/lib/errors.ts`** — Dead file with zero imports. Entire codebase uses `AppError`/`errors` from `middleware/error.ts`.
2. **`apps/api/src/routes/chat.ts`** — Duplicate `requireRouteParam` function (lines 28-36). Canonical version exists in `apps/api/src/lib/route-helpers.ts`. Also found duplicate in `apps/api/src/routes/activity.ts`.
3. **`apps/api/src/routes/nodes.ts:261`** — `POST /:id/stop` returns `{ status: 'deleted' }` but should return `{ status: 'stopped' }` (the route stops nodes, not deletes them).
4. **`apps/api/src/routes/tasks/_helpers.ts:251-258`** — `console.error` call passes object as second arg (not structured JSON). Should use `JSON.stringify` for structured logging.
5. **`apps/web/src/pages/CreateWorkspace.tsx:205`** — Branch fetch failure logged with `console.log` instead of `console.error`.
6. **`packages/providers/src/types.ts`** — `ProviderError` class lacks `toJSON()`, so `JSON.stringify(error)` returns `{}`.
7. **`scripts/deploy/types.ts`** — `DeploymentState` interface and `DEPLOYMENT_STATE_VERSION` constant are unused (zero imports outside own file).

### Key Files
- `apps/api/src/lib/errors.ts` (to delete)
- `apps/api/src/routes/chat.ts` (remove duplicate)
- `apps/api/src/routes/activity.ts` (remove duplicate — discovered during implementation)
- `apps/api/src/routes/nodes.ts` (fix response status)
- `apps/api/src/routes/tasks/_helpers.ts` (structured logging)
- `apps/web/src/pages/CreateWorkspace.tsx` (console.error)
- `packages/providers/src/types.ts` (toJSON)
- `scripts/deploy/types.ts` (remove dead types)

## Implementation Checklist

- [x] 1. Delete `apps/api/src/lib/errors.ts`
- [x] 2. Remove duplicate `requireRouteParam` in `chat.ts` and `activity.ts`, add import from `lib/route-helpers.ts`
- [x] 3. Fix `{ status: 'deleted' }` → `{ status: 'stopped' }` in `nodes.ts` POST /:id/stop
- [x] 4. Structured JSON logging in `_helpers.ts` for trigger execution sync failure
- [x] 5. Fix `console.log` → `console.error` in `CreateWorkspace.tsx`
- [x] 6. Add `toJSON()` to `ProviderError` class
- [x] 7. Remove unused `DeploymentState` and `DEPLOYMENT_STATE_VERSION` from `scripts/deploy/types.ts`
- [x] 8. Write behavioral test: node stop endpoint returns correct status
- [x] 9. Write behavioral test: ProviderError.toJSON() serializes all fields
- [x] 10. Write test: requireRouteParam imported from canonical location (not duplicated)
- [x] 11. Write test: structured logging format in trigger execution sync
- [x] 12. Verify no remaining imports of deleted files

## Acceptance Criteria

- [x] All 7 changes from PR #699 applied cleanly (plus bonus activity.ts fix)
- [x] `apps/api/src/lib/errors.ts` no longer exists
- [x] `requireRouteParam` only defined in `lib/route-helpers.ts`, imported in `chat.ts` and `activity.ts`
- [x] Node stop endpoint returns `{ status: 'stopped' }` with behavioral test
- [x] `ProviderError.toJSON()` exists and serializes all fields with test
- [x] Trigger execution sync failure uses structured JSON logging
- [x] `console.error` used for branch fetch failures
- [x] `DeploymentState` and `DEPLOYMENT_STATE_VERSION` removed
- [x] All existing tests pass
- [x] Lint and typecheck pass

## References

- PR #699: https://github.com/raphaeltm/simple-agent-manager/pull/699
- Original branch: `sam/dead-code-removal-small-01kp4w`
