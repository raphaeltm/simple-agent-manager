# P4-02: Parallelize VM Agent RPCs in Cron

**Phase**: 4 (Performance & Code Organization)
**Priority**: P1
**Risk Level**: Medium — modifies cron job concurrency
**Effort**: S (4-8 hours)
**Source Findings**: F-018 (Track 5: Performance)
**Recommended Skill(s)**: `$cloudflare-specialist`

## Scope

Node cleanup cron at `apps/api/src/scheduled/node-cleanup.ts:276-320, 392-405` iterates orphaned workspaces sequentially, making per-workspace HTTP calls to VM agents. Each RPC has 50-500ms latency. Parallelize with `Promise.allSettled()` bounded to concurrency of 5.

## Files Likely Touched

- `apps/api/src/scheduled/node-cleanup.ts` — parallelize RPCs

## Compatibility Constraints

- Must preserve error isolation (one failed RPC shouldn't block others)
- Concurrency limit must be configurable (env var with default of 5)
- Must not exceed Worker CPU time budget

## Automated Tests to Add/Run

- Test: multi-node cleanup with mocked RPCs completes faster than sequential
- Test: RPC failure for one workspace doesn't affect others
- `pnpm --filter @simple-agent-manager/api test`

## Manual Staging Verification

- Deploy to staging, verify cron runs successfully with multiple workspaces

## Expected Post-Deploy State

- Cron duration reduced from O(n) to O(n/5) for node cleanup
- Same cleanup behavior, just faster

## Visible Behavior Changes

- None to end users

## Rollback Notes

- Revert to sequential RPCs. No data migration.

## Acceptance Criteria

- [ ] Node cleanup RPCs are bounded and parallelized (`Promise.allSettled`, concurrency=5)
- [ ] Concurrency limit is configurable via env var
- [ ] Tests cover multi-node behavior
- [ ] Error isolation preserved
- [ ] `pnpm --filter @simple-agent-manager/api test` passes

## Links

- Track report: `tracks/05-performance-cost.md` (Section 5.1: Sequential RPCs)
- Finding: F-018 in `findings-index.md`
- Code: `apps/api/src/scheduled/node-cleanup.ts:276-320, 392-405`
