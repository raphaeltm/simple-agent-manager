# Enforce D1 Expression-Depth Headroom for Placement Authority Statements

## Problem

D1 caps SQLite expression depth at 100. PR #2853 found the composable placeholder-attach statement
at depth 102 and grouped the authority `EXISTS` conditions to bring every composable caller under
the cap. The Cloudflare review measured restart 80/83 and attach 76/79, about 17 levels of margin.
Every new term in the `node_scope` chain or the authority predicate lowers it.

`apps/api/tests/workers/composable-authority-d1-expression-depth.test.ts` runs on Miniflare's D1 and
fails only at the cap itself. Miniflare cannot lower the limit, so the margin is not enforced.

## Context

Deferred LOW from the cloudflare-specialist review of PR #2853 (task
`tasks/archive/2026-09-25-composable-capacity-source-anchor-guard.md`).

## Acceptance Criteria

- [ ] A test captures the composed attach and restart statements (the deepest callers) and proves
      they still prepare on Miniflare D1 with a fixed padding (for example 15 extra `AND 1 = 1`
      terms on the outer chain), so the margin is enforced, not only the cliff.
- [ ] The padding amount is a named constant with its rationale in a comment.
- [ ] Optionally group the 16-term `node_scope` chain and the `cc_*` `EXISTS` chain to widen the margin.
