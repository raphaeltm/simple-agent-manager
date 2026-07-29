# Strict CTO remediation mega PR

## Problem

Eight remediation PRs have been completed independently and need to be integrated into one safe mega PR. The integration must preserve each remediation's tests and guarantees, validate the combined diff locally and on staging, and merge to production only after all gates pass.

## Input PRs

- #1689 default-branch/output-branch safety
- #1690 deploy-reusable Wrangler sync env parity
- #1691 fail-closed workers.dev/cron setup
- #1692 deployment docs and Worker secret inventory drift
- #1693 VM-agent shutdown idempotency
- #1694 configurable Cloudflare container max_instances
- #1695 ProjectData row fault isolation + bootstrap TTL wording
- #1696 atomic bootstrap token redemption

## Research findings

- SAM instructions require progress updates, use of the output branch `sam/execute-task-using-skill-ggdn3n`, and no merge until validation is complete.
- Existing local main worktree has an unrelated `.codex/config.toml` modification that must be preserved and excluded.
- All eight PRs are open against `main` and initially report clean merge state from GitHub.
- Affected areas are expected to include task dispatch/branch handling, deployment scripts/docs/env inventory, Cloudflare Worker setup, VM agent Go shutdown behavior, ProjectData Durable Object message listing, and bootstrap token redemption.

## Checklist

- [x] Create integration branch from current `origin/main`.
- [x] Merge/cherry-pick PRs #1689 through #1696.
- [x] Resolve conflicts without dropping tests or docs from any remediation.
- [x] Run targeted tests for all affected areas.
- [x] Run full feasible local validation: lint, typecheck, tests, build.
- [x] Run local specialist reviews for correctness, security, Cloudflare/env consistency, Go quality, task completion, and test quality.
- [ ] Open mega PR with specialist review evidence.
- [ ] Wait for CI to be completely green.
- [ ] Check staging state before deploy and avoid clobbering active validation.
- [ ] Deploy the mega PR to staging.
- [ ] Validate affected surfaces on staging: task dispatch/output branches, bootstrap token flow, ProjectData message listing, deploy workflow config behavior, docs/build/quality checks, and VM-agent shutdown as safely testable.
- [ ] Validate core agent workflows on staging for both Claude and Codex using Playwright token-login and platform credential fallback.
- [ ] Merge mega PR only after all gates pass.
- [ ] Monitor production Deploy Production workflow by merge `headSha` and require a successful deploy run.
- [ ] Report final PR URL, merge commit, staging evidence, core Claude/Codex evidence, production deploy evidence, and source PR disposition.

## Acceptance criteria

- One integration PR contains all eight remediation PRs' intended code, docs, and tests.
- CI is green on the integration PR.
- Staging deploy succeeds and all listed affected surfaces are verified.
- Both Claude and Codex core staging workflows return valid responses.
- Production deploy succeeds after merge.
- No individual remediation PR is merged as a substitute for the mega PR.
