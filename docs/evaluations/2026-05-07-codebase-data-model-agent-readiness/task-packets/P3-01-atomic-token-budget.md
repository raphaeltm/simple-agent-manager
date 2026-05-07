# P3-01: Atomic Token Budget Accounting

**Phase**: 3 (Security & Data Integrity)
**Priority**: P0
**Risk Level**: High — modifies security-critical budget enforcement
**Effort**: M (1-2 days)
**Source Findings**: F-001 (Track 1: Data Model — CRITICAL)
**Recommended Skill(s)**: `$cloudflare-specialist`, `$security-auditor`, `$test-engineer`
**BLOCKED**: Until Phase 2 testing foundation is in place and human reviews this plan

## Scope

KV-based token budget accounting at `apps/api/src/services/ai-token-budget.ts` uses non-atomic read-modify-write. Under concurrent requests, budget can be bypassed (two requests read the same counter, both increment, one write is lost) or double-counted.

## Files Likely Touched

- `apps/api/src/services/ai-token-budget.ts` — replace KV read-modify-write with atomic operation
- Possible new Durable Object or service files for atomic counter
- `apps/api/tests/` — regression tests for concurrent budget operations

## Compatibility Constraints

- Existing budget semantics must be preserved (daily limits, user-scoped budgets)
- Migration path from KV counters to new atomic storage must be seamless
- No user-visible API changes
- Budget enforcement must remain fail-closed (if the atomic store is unavailable, deny requests)

## Automated Tests to Add/Run

- Regression test simulating concurrent spend attempts (verify total never exceeds budget)
- Unit tests for new atomic counter implementation
- `pnpm --filter @simple-agent-manager/api test`

## Manual Staging Verification

- Deploy to staging, configure a low daily budget (e.g., 1000 tokens)
- Send 5 concurrent AI proxy requests
- Verify total tracked usage matches actual usage (no lost increments)
- Verify budget enforcement blocks requests when limit is reached

## Expected Current Staging State Dependency

- AI proxy must be enabled (`AI_PROXY_ENABLED`)
- At least one user with budget settings configured

## Expected Post-Deploy State

- Token budget increments are atomic under concurrent requests
- No budget bypass possible via concurrent requests
- KV may still be used for budget settings (not the counter)

## Visible Behavior Changes

- None visible to end users under normal operation
- Under high concurrency: budget enforcement is now reliable (may block requests that previously leaked through)

## Rollback Notes

- Revert to KV-based accounting. If a new DO was created, it can be left in place (no data loss from reverting the code). Ensure KV budget data is not cleared during the migration.
- **Risk**: Rollback re-introduces the race condition. Only rollback if the new implementation has a worse bug.

## Acceptance Criteria

- [ ] Token budget increments are atomic under concurrent requests
- [ ] Existing budget semantics (daily limits, user-scoped) are preserved
- [ ] Regression test simulates concurrent spend attempts and verifies atomicity
- [ ] Documentation explains why KV is no longer used for the atomic counter
- [ ] Budget enforcement remains fail-closed
- [ ] `pnpm --filter @simple-agent-manager/api test` passes
- [ ] Security review before merge

## Links

- Track report: `tracks/01-data-model.md` (C1: CRITICAL — KV Race Condition)
- Track report: `tracks/07-security-isolation.md` (HIGH-6: MCP rate limiter non-atomic KV)
- Finding: F-001 in `findings-index.md`
- Related: `implementation-backlog.md` Wave 1, Task 1A
- Code: `apps/api/src/services/ai-token-budget.ts:190-221`
