# P4-06: Split Oversized Route Files

**Phase**: 4 (Performance & Code Organization)
**Priority**: P1
**Risk Level**: Medium — file splitting refactoring
**Effort**: L (2-3 days)
**Source Findings**: F-011, F-015 (Track 3, Track 4: Code Organization, Coding Standards)
**Recommended Skill(s)**: General

## Scope

15 files exceed the 800-line mandatory split limit. 7 route files exceed 500 lines (up to 995 lines). Split each using the directory pattern from Rule 18: one file per operation group + `index.ts` barrel.

## Files Likely Touched

- `apps/api/src/routes/tasks/crud.ts` (995 lines) → `list.ts`, `create.ts`, `detail.ts`, `status.ts`
- `apps/api/src/routes/projects/crud.ts` (920 lines) → `list.ts`, `create.ts`, `detail.ts`, `update.ts`
- `apps/api/src/routes/triggers/crud.ts` (842 lines) → split by operation
- `apps/api/src/routes/workspaces/runtime.ts` (814 lines) → split by operation
- `apps/api/src/routes/mcp/dispatch-tool.ts` (685 lines) → split
- `apps/api/src/routes/chat.ts` (655 lines) → split
- `apps/api/src/routes/credentials.ts` (682 lines) → split
- Barrel `index.ts` files for each split directory

## Compatibility Constraints

- No behavior changes — pure file splitting
- Existing tests must pass unmodified
- Import paths that change must be updated across all consumers
- Barrel files must re-export the same public API

## Automated Tests to Add/Run

- All existing tests must pass unchanged
- `pnpm --filter @simple-agent-manager/api test`
- `pnpm lint && pnpm typecheck`
- Verify no route files over 500 lines after split

## Manual Staging Verification

- Deploy to staging, verify all API routes still work
- Spot-check: task submission, project CRUD, workspace operations

## Expected Post-Deploy State

- No route file exceeds 500 lines
- Each split directory has a barrel `index.ts`
- Same API behavior

## Visible Behavior Changes

- None

## Rollback Notes

- Revert file splits. Pure refactoring — no state to clean up.

## Acceptance Criteria

- [ ] All 7 oversized route files split into sub-files under 500 lines
- [ ] Each split uses directory pattern with `index.ts` barrel
- [ ] No behavior changes — existing tests pass unmodified
- [ ] `pnpm lint && pnpm typecheck` passes
- [ ] `pnpm --filter @simple-agent-manager/api test` passes

## Links

- Track report: `tracks/03-code-organization.md` (Files Exceeding Limits)
- Track report: `tracks/04-coding-standards.md` (F05: Oversized Route Files)
- Findings: F-011, F-015 in `findings-index.md`
- Rule: `.claude/rules/18-file-size-limits.md`
