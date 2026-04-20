# Staging D1 migration v8 corruption blocks all staging deploys

## Problem

The staging D1 database has an orphaned/corrupt v8 migration entry that prevents the `Deploy Staging` workflow from completing. Every attempt to trigger `deploy-staging.yml --ref <branch>` fails during the wrangler migration step with a conflict on migration `v8`, regardless of what the PR contains.

This is infrastructure state corruption, not a code defect — the migration file in the repo is syntactically valid, but the staging D1's internal migrations tracking table has it half-applied (or has a duplicate row).

## Impact

- Every agent running `/do` that reaches Phase 6 (Staging Verification) is blocked
- Agents must fall back to `needs-human-review` label per rule 25, which defers PR merge to a human
- Rule 13 (staging verification as a hard merge gate) is effectively inoperative for any PR that does NOT touch the v8 migration itself
- Discovered while working on `sam/sidebar-menu-project-chat-01kph4` (nested chat sidebar PR) — the PR touches zero infrastructure/migration files yet is blocked by this

## Context (where discovered)

- Date: 2026-04-18
- Branch attempting deploy: `sam/sidebar-menu-project-chat-01kph4`
- Workflow: `deploy-staging.yml`
- Failure point: wrangler D1 migration step reports conflict on v8

## Acceptance Criteria

- [ ] Identify the corrupt migration entry in the staging D1 `d1_migrations` table
- [ ] Either: drop the orphaned row, restore the database to a clean state, or re-create the staging D1 database
- [ ] Verify that `deploy-staging.yml` now completes end-to-end for an unrelated branch
- [ ] Document the remediation steps in `docs/guides/self-hosting.md` so this can be resolved quickly if it recurs
- [ ] (Optional) Add a pre-deploy wrangler check that detects and warns about orphaned migration entries

## References

- Rule 13: `.claude/rules/13-staging-verification.md` — staging deploy is a hard merge gate
- Rule 25: `.claude/rules/25-review-merge-gate.md` — `needs-human-review` safety valve when gates can't complete
