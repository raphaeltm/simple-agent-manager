# workers-setup-session sweep spec fails: no such table: users

## Problem

`cd apps/api && npx vitest run --config tests/vitest.workers-setup-session.config.ts` fails
`tests/workers-setup-session/setup-session-sweep.spec.ts` at load with
`D1_ERROR: no such table: users: SQLITE_ERROR` (1 file failed, 9 passed, 3 skipped). The pool DO
spec passes.

## Context

Found 2026-11-17 while validating L19 (task 01M7M9FHH6VPWVFTVB6P8X230P). Reproduces on the
committed baseline with the L19 changes stashed, so it predates that work. The config is not run
by CI (`git grep workers-setup-session` finds only the config and its specs), so nothing reports it.

## Acceptance Criteria

- [ ] The sweep spec's D1 has the schema it needs (migrations applied in the config's setup)
- [ ] The config runs green locally
- [ ] Either CI runs it, or the config is removed with its specs folded into a CI-run suite
