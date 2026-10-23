# The UI Compliance CI check never sees UI changes

## Problem

The `UI Compliance` job in `.github/workflows/ci.yml` passes on every pull request without checking
anything. `scripts/ci/check-ui-compliance.mjs` lists changed files with
`git diff --name-only origin/${GITHUB_BASE_REF}...HEAD` and falls back to
`git diff --name-only HEAD~1 HEAD`. The job's `actions/checkout` step uses the default shallow fetch,
so `origin/main` does not exist and `HEAD~1` was never fetched. Both commands fail, the checker gets
an empty file list, and it prints "No UI file changes detected. UI compliance check passed."

So the required UI checklist items are never enforced, even on PRs that change `apps/web/` or
`packages/ui/`.

## Context

Found on 2026-10-23 on draft PR #2413, which changes many `apps/web/` files. CI run 39882787351,
job `UI Compliance`, logged "No UI file changes detected". Run locally with
`GITHUB_BASE_REF=main` against the same PR body, the checker found the UI changes and failed on a
missing checklist phrase.

## Acceptance Criteria

- [ ] The job fetches the base branch (for example `fetch-depth: 0`, or an explicit
      `git fetch origin ${{ github.base_ref }}`) so the diff sees the PR's files
- [ ] The checker fails, rather than passing, when it cannot list changed files
- [ ] A test runs the checker against a repository where the base ref is missing and asserts it
      fails, plus a control where UI files changed and the checklist is complete
- [ ] Open PRs that change UI files still pass, or are fixed, once the check works
