# Cut pull-request CI time and wasted runner slots

SAM task `01M7G563236JS5VPXXCMYPQ7VW`, dispatched by coordinator `01M7FXB4800VH9YT1ZZDC2QZ2N`
(channel `feature.ship-faster`). Evidence: idea `01M7FYGMEESYH3AJZJ0CT3NKCZ` (B2, B3, B4) and item 2
of idea `01M79M6CRX5KSHYEA6GM413061`. Raphaël requested the change directly on 2026-11-15; merge
when every gate passes. No paid plan.

## Problem

- A green PR run takes 22 min at the median. `Test` (`pnpm test:coverage --concurrency=2`) is the
  floor: p50 20.4 min, p90 30.6 min, job limit raised to 45 min as a stopgap.
- GitHub caps the account at 20 concurrent jobs; one run starts 18 to 27 jobs; 517 jobs waited
  more than 5 min for a runner in 8 days.
- 181 of 457 PR runs were cancelled by a newer push after their jobs started.
- The public-site browser tests (about 450 s) run in both `Marketing Site` and
  `Workspace Quality Surfaces`.
- Main runs are serialized by `concurrency: ci-${{ github.ref }}` (push to first job p90 10.7 min).

## Research findings

- Ruleset `Main` (id 13102493) requires one check: `Durable Object Workers` (GitHub Actions). A
  skipped job reports success, so today that check is green for every PR that does not touch the
  API, whatever `Test` says. The ruleset cannot be edited with the agent token (403), so the guard
  has to live in `ci.yml` under the existing check name.
- Baseline runs: 43734352275 (API, web and VM changes): 22 jobs started, `Test` 20.9 min (coverage
  step 1158 s), DO shards 15.8 to 20.9 min, Playwright 23.3 min, `Workspace Quality Surfaces`
  11.1 min (public-site browser 505 s), `Marketing Site` 9.5 min (public-site browser 462 s).
  43740801279: `Test` 26.6 min (1479 s).
- Vitest 4.1.5: a `--shard` run with `--coverage` also checks thresholds
  (`generateReports` -> `reportThresholds`), so shard runs must zero the thresholds; `--merge-reports
--coverage` applies the config thresholds to the merged map. Verified locally on
  `packages/shared`: merged coverage equals the unsharded run exactly, a merge missing one shard
  fails the thresholds. The merge needs no package build (dist removed, merge ran in 4 s).
- `turbo run test:coverage --filter=!api --filter=!web` selects exactly the other 20 packages
  (22 in total).
- Root `pnpm lint` / `pnpm typecheck` (turbo) already lint and type-check `apps/www`, so when the
  repo-quality jobs run, the `Marketing Site` job only duplicates them plus the docs build and the
  browser tests that `Workspace Quality Surfaces` also runs.
- `Build` (`pnpm build`) is the first step of `Type Check`; the job is a pure duplicate.
- `scripts/quality/ci-quality-program.test.ts` forbids `ci.yml` in the expensive path filters, so a
  CI-only PR runs narrow CI by design. To prove the new jobs on real runners this PR temporarily
  touches a `repo-quality` path and an `apps/www` path, then reverts them (documented in the PR).
- Deploy gate: `deploy.yml` serializes trusted production runs in one concurrency group and
  `validate-production-dispatch.ts` (`requireCurrentMainTip`) refuses any SHA that is not the current
  main tip. `scripts/quality/deploy-safety.test.ts` "fails closed instead of rolling back when an
  older main CI finishes late" covers the overlap case.
- `scripts/quality/pr-evidence-source.ts` documents the PR trigger types; it must be updated when
  `ready_for_review` is added.
- Channel addendum (policy `73ed7a68`, updated by Raphaël 2026-11-15): request CodeRabbit when the PR
  is marked ready, in parallel with reviewers, CI and staging; end the wait at once on a rate-limit,
  quota or `Review skipped` reply.

## Implementation checklist

- [ ] `ci.yml`: `pull_request` types include `ready_for_review`
- [ ] `ci.yml`: draft PRs run only quick checks (Detect Changes, PR Evidence, Lint, Build and Type
      Check, Code Quality Checks, Secret Scan); every other job is skipped on drafts
- [ ] `ci.yml`: required check `Durable Object Workers` becomes the full-suite gate: never reported
      under that name on a draft run, waits for every non-evidence job, fails on any failure or
      cancellation, still requires every Workers shard when the API changed
- [ ] `ci.yml`: split `Test` into `test-api` (3 shards), `test-web` (2 shards), `test-packages`, and a
      final `Test` job that merges the blob reports and enforces each package's coverage thresholds;
      lower the job limits
- [ ] `ci.yml`: public-site browser tests run once per run (`Marketing Site` only when
      `Workspace Quality Surfaces` does not run); `pnpm quality:browser-evidence` unchanged
- [ ] `ci.yml`: merge `Preflight Evidence`, `Specialist Review Evidence`, `UI Compliance` into one
      `PR Evidence` job; fold `CI Workflow` into `Code Quality Checks`; drop the duplicate `Build`
      job; fold `VM Agent E2E` into `VM Agent Integration`
- [ ] `ci.yml`: concurrency group per commit for non-PR events; PR runs still cancel superseded runs
- [ ] Wiring tests in `scripts/quality/ci-*.test.ts` updated and extended (draft gating, gate
      discrimination, shard/merge consistency, browser tests once, concurrency)
- [ ] `scripts/quality/pr-evidence-source.ts` trigger comment updated
- [ ] `.gitignore`: `.vitest-reports/`
- [ ] Agent docs: `.claude/commands/do.md` (open a draft PR early, mark ready when the candidate is
      complete, CodeRabbit at mark-ready), `.agents/skills/do/SKILL.md`,
      `.claude/rules/25-review-merge-gate.md`, `.claude/rules/14-do-workflow-persistence.md` if it
      conflicts, `.github/pull_request_template.md` CodeRabbit section, `docs/guides/ci-wait-recovery.md`
      if it states when CI runs
- [ ] Real CI proof on this PR: draft run shows only the quick set; ready run executes every suite
      with test counts equal to the baseline; full run about 12 min or less
- [ ] Idea `01M7FYGMEESYH3AJZJ0CT3NKCZ` note with before/after durations and job counts, plus next
      steps for the out-of-scope items
- [ ] After merge: two close main pushes both start CI at once; production deploys the tip

## Acceptance criteria

- [ ] A full run on the PR finishes in about 12 min or less (excluding the out-of-scope DO Workers
      and Playwright visual jobs, which this PR does not trigger) with all suites executed and
      test counts matching the baseline
- [ ] A draft push runs only the quick set
- [ ] A PR cannot be merged on the quick checks alone
- [ ] Coverage thresholds are enforced on the whole of `apps/api` and `apps/web`
- [ ] Full PR run job count stays at or under about 24
- [ ] After merge, overlapping main pushes both get CI immediately and production deploys the tip

## Out of scope

`turbo --affected`, a turbo cache, the Durable Object Workers shard count, Playwright visual shards
(next steps noted in the idea). `deploy-reusable.yml` and `deploy-staging.yml` belong to sibling tasks.
