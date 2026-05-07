# P3-03: FTS5 Query Sanitization Hardening

**Phase**: 3 (Security & Data Integrity)
**Priority**: P0
**Risk Level**: High — modifies query sanitization for full-text search
**Effort**: S (4-8 hours)
**Source Findings**: F-003 (Track 7: Security)
**Recommended Skill(s)**: `$cloudflare-specialist`, `$security-auditor`
**BLOCKED**: Until Phase 2 testing foundation is in place and human reviews this plan

## Scope

FTS5 sanitization behavior differs across ProjectData query paths. `knowledge.ts` has comprehensive sanitization (`sanitizeFts5Query` at line 513-522) while `messages.ts` (line 494-498) uses a weaker pattern. All FTS5 MATCH queries must use one shared sanitizer.

## Files Likely Touched

- `apps/api/src/durable-objects/project-data/messages.ts` — adopt shared sanitizer
- `apps/api/src/durable-objects/project-data/knowledge.ts` — source of reference sanitizer
- New shared utility or extract into `apps/api/src/durable-objects/project-data/fts5-utils.ts`
- `apps/api/tests/` — tests for sanitization edge cases

## Compatibility Constraints

- Search behavior should remain functionally equivalent for normal queries
- Edge cases (quotes, operators, punctuation, empty strings) must be safely handled
- LIKE fallback path must remain safe and documented
- No change to FTS5 table schema

## Automated Tests to Add/Run

- Tests covering: quotes in search terms, FTS5 operators (AND, OR, NOT, NEAR), punctuation, empty queries, Unicode characters, very long queries
- Test: verify LIKE fallback produces safe SQL
- `pnpm --filter @simple-agent-manager/api test`

## Manual Staging Verification

- Search for messages/knowledge with various special characters
- Verify no SQL errors or unexpected results
- Verify LIKE fallback works for edge-case queries

## Expected Current Staging State Dependency

- Projects with existing messages and knowledge entities for search testing

## Expected Post-Deploy State

- One shared FTS5 sanitizer used across all ProjectData query paths
- Consistent handling of special characters in search

## Visible Behavior Changes

- Searches with special characters may return slightly different results if the weaker sanitizer was producing incorrect matches

## Rollback Notes

- Revert to per-path sanitization. No data migration needed.
- **Risk**: Rollback re-introduces inconsistent sanitization.

## Acceptance Criteria

- [ ] One shared sanitizer used for all FTS5 MATCH queries
- [ ] Tests cover: quotes, operators, punctuation, empty queries, Unicode
- [ ] LIKE fallback path remains safe and documented
- [ ] `pnpm --filter @simple-agent-manager/api test` passes

## Links

- Track report: `tracks/07-security-isolation.md` (HIGH-2: FTS5 Sanitization)
- Finding: F-003 in `findings-index.md`
- Related: `implementation-backlog.md` Wave 1, Task 1C
- Code: `apps/api/src/durable-objects/project-data/messages.ts:494-498` vs `knowledge.ts:513-522`
