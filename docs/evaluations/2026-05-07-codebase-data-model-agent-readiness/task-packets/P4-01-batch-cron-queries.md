# P4-01: Batch Cron Queries

**Phase**: 4 (Performance & Code Organization)
**Priority**: P1
**Risk Level**: Medium — modifies cron job behavior
**Effort**: S (4-8 hours)
**Source Findings**: F-017 (Track 5: Performance)
**Recommended Skill(s)**: `$cloudflare-specialist`

## Scope

The stuck-task recovery cron handler at `apps/api/src/scheduled/stuck-tasks.ts:229-350` issues 3-4 D1 queries per stuck task sequentially. With 20 stuck tasks, this fires 80+ queries per cron invocation. Batch-fetch all task node IDs and heartbeat statuses in 1-2 queries upfront.

## Files Likely Touched

- `apps/api/src/scheduled/stuck-tasks.ts` — batch queries

## Compatibility Constraints

- Must produce identical results to current sequential approach
- Cron behavior must remain idempotent
- Error handling per-task must be preserved (one failed task shouldn't block others)

## Automated Tests to Add/Run

- Unit test: batched query returns same results as sequential for multiple stuck tasks
- Test: cron completes within 10 seconds for 50 stuck tasks (was ~25s sequential)
- `pnpm --filter @simple-agent-manager/api test`

## Manual Staging Verification

- Deploy to staging, verify cron job runs successfully
- Check Worker logs for cron execution time

## Expected Post-Deploy State

- Cron queries reduced from O(n) to O(1) per invocation
- Identical stuck-task recovery behavior

## Visible Behavior Changes

- None to end users
- Cron runs faster

## Rollback Notes

- Revert to sequential queries. No data migration.

## Acceptance Criteria

- [ ] Stuck-task cron fetches all task node IDs and heartbeat statuses in 1-2 queries
- [ ] Cron completes within 10 seconds for 50 stuck tasks
- [ ] Unit tests verify batched query returns same results as sequential
- [ ] `pnpm --filter @simple-agent-manager/api test` passes

## Links

- Track report: `tracks/05-performance-cost.md` (Section 5.1: Cron N+1)
- Finding: F-017 in `findings-index.md`
- Code: `apps/api/src/scheduled/stuck-tasks.ts:229-350`
