# FTS5 Query Sanitization Hardening

**Priority**: P0
**Source**: Evaluation F-003 / HIGH-2

## Problem

FTS5 `buildFtsQuery` is implemented three times with inconsistent sanitization:

1. **`messages.ts:494-498`** — quotes words, escapes internal `"`, but does NOT strip FTS5 operators (`*`, `^`, `NEAR/N`) or reserved keywords (`AND`, `OR`, `NOT`, `NEAR`). An input like `hello* OR /etc/passwd` passes FTS5 prefix/operator syntax through.
2. **`sam-session/index.ts:101-104`** — identical to messages.ts (same weakness). Also imported by `project-agent/index.ts`.
3. **`knowledge.ts:513-522`** — strips all non-word chars, filters reserved keywords. Stronger, but does NOT quote words (relies on implicit AND).

Secondary bug: `knowledge.ts:searchObservationsLike` (line 324) does NOT escape LIKE wildcards (`%`, `_`, `\`), unlike messages.ts which does (line 459).

## Research Findings

### Files to modify
- `apps/api/src/durable-objects/project-data/fts-utils.ts` — NEW shared module
- `apps/api/src/durable-objects/project-data/messages.ts` — replace local `buildFtsQuery` with import
- `apps/api/src/durable-objects/project-data/knowledge.ts` — replace local `buildFtsQuery` + fix LIKE escaping
- `apps/api/src/durable-objects/sam-session/index.ts` — replace local `buildFtsQuery` with import
- `apps/api/src/durable-objects/project-agent/index.ts` — update import path

### Consumers
- `messages.ts:searchMessagesFts()` calls `buildFtsQuery`
- `knowledge.ts:searchObservationsFts()` calls `buildFtsQuery`
- `sam-session/index.ts:searchMessages()` calls `buildFtsQuery`
- `project-agent/index.ts` imports `buildFtsQuery` from sam-session
- Tests: `sam-session.test.ts`, `message-materialization.test.ts`

### Best sanitization approach
Combine both strategies: strip non-word chars first (kills operators), filter reserved words, then quote each surviving word (prevents any edge case). This is strictly safer than either current approach.

## Implementation Checklist

- [ ] Create `apps/api/src/durable-objects/project-data/fts-utils.ts` with shared `sanitizeFtsQuery()` and `escapeLikeWildcards()`
- [ ] `sanitizeFtsQuery`: strip non-word chars, filter FTS5 reserved words, quote each word, return null for empty
- [ ] `escapeLikeWildcards`: escape `%`, `_`, `\` in query for safe LIKE usage
- [ ] Replace `buildFtsQuery` in `messages.ts` with import from `fts-utils.ts`
- [ ] Replace `buildFtsQuery` in `knowledge.ts` with import from `fts-utils.ts`
- [ ] Fix knowledge.ts LIKE path to use `escapeLikeWildcards`
- [ ] Replace `buildFtsQuery` in `sam-session/index.ts` with re-export from `fts-utils.ts`
- [ ] Update `project-agent/index.ts` import if needed
- [ ] Update existing tests in `sam-session.test.ts` to match new behavior
- [ ] Update existing tests in `message-materialization.test.ts` to match new behavior
- [ ] Add comprehensive unit tests for `sanitizeFtsQuery` covering: quotes, FTS5 operators, punctuation, empty/whitespace, reserved words, mixed inputs
- [ ] Add unit tests for `escapeLikeWildcards`
- [ ] Verify `pnpm typecheck` passes
- [ ] Verify `pnpm --filter @simple-agent-manager/api test` passes

## Acceptance Criteria

- [ ] All ProjectData FTS5 query paths use a shared sanitizer
- [ ] Regression tests cover dangerous inputs (quotes, operators, punctuation, empty queries)
- [ ] `pnpm --filter @simple-agent-manager/api test` passes
- [ ] LIKE fallback paths all escape wildcards
- [ ] Security specialist review evidence included

## References

- `docs/evaluations/2026-05-07-codebase-data-model-agent-readiness/tracks/07-security-isolation.md` (HIGH-2)
- `docs/evaluations/2026-05-07-codebase-data-model-agent-readiness/implementation-backlog.md` (1C)
