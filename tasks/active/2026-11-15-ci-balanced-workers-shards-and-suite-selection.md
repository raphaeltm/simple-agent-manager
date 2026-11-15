# CI round 2: balanced Durable Object Workers shards and change-based suite selection

SAM task `01M7GBMAC8B2CTNBVFKKZW1B4C`. Follows PR #2763. Background: idea `01M7FYGMEESYH3AJZJ0CT3NKCZ`,
findings of task `01M6Y5N5R79579YVN3RW007H25`.

## Problem

- A PR that touches the API paths waits on three `Durable Object Workers` shards that took 12 to 21 min in
  the five ready runs before this change (43749981572, 43750362842, 43740879496, 43734352275,
  43730544776). Vitest shards by file-path hash, so shard test time ranged from 586 s to 1,087 s inside a
  single run.
- `repo-quality` (any package, `apps/api`, `apps/web`) starts the API, web and public-site suites at once,
  so a web-only change runs ~15,700 API tests and an API-only change runs Storybook and the public-site
  browser tests.

## Research findings

- `tests/workers/timing-reporter.ts` uploads per-file `setupMs`/`collectMs`/`testsAndHooksMs`. Median over
  the 5 runs: 196 files, ~2,990 s. Longest file 64 s (`scheduled-stuck-tasks`). Greedy longest-first into 6
  shards gives ~510 s per shard; shard 1 also runs `vitest.sam-runtime.config.ts` (~55 s).
- Vitest 4 calls `sequence.sequencer.shard(files)` when `--shard` is set (`BaseSequencer.shard`), so a
  custom sequencer can balance by time while keeping the `--shard=i/n` interface.
- Workspace graph (package.json): api -> agent-email, ai-proxy, app-deployment, cloud-init, operations,
  project-data, providers, repo-hosting, scheduler-core, shared, worker-core. web -> acp-client, shared,
  terminal, ui. www -> ui.
- The current `api` filter misses `packages/providers` and `packages/cloud-init` (API dependencies) and
  lists `packages/task-runner` and `packages/config`, which do not exist.
- API unit tests read files outside the dependency closure: `packages/vm-agent` (Go sources, Makefile, `go
  test` in cf-container/session-sleep/publish-timeout contract tests) and `apps/tail-worker/src`
  (omitted-worker-var defaults). The Workers suite reads nothing outside `apps/api`.
- Web unit tests read only `packages/ui/src/tokens/theme.css` outside `apps/web` (in closure).
- `Test other packages` runs `apps/www`, `apps/tail-worker`, `apps/installer` tests, but its trigger
  (`repo-quality`) does not include those directories, so their unit tests never ran for a change to them.
- `Marketing Site` exists only for www changes that `Workspace Quality Surfaces` did not cover; it also lints
  and type-checks `apps/www`, which root Lint/Build and Type Check do when `repo-quality` runs.
- Root inputs every suite depends on: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`,
  root `tsconfig.json`, `vitest.coverage.ts`.
- `scripts/quality/ci-draft-and-gate.test.ts` has an Actions-expression simulator and the runner-budget
  test (every filter <= 27 jobs).

## Implementation checklist

- [ ] Timing-balanced Workers sequencer + committed per-file timings + refresh tool
- [ ] `vitest.workers.config.ts` uses it; CI runs 6 shards; build only `api^...`
- [ ] `changes` job: graph-derived filters `api`, `api-unit`, `web`, `public-site`, `packages`
      (YAML anchors for root inputs), forced true on `push`
- [ ] `test-api` on `api-unit`, `test-web` on `web`, `test-packages` on `packages`, `test` merges only
      what ran and requires skipped for unselected suites
- [ ] `workspace-quality-surfaces` on `public-site`/`browser-install`; lint and type-check www there when
      root Lint did not run; remove `Marketing Site`
- [ ] Shared simulator module; new `ci-suite-selection.test.ts` (graph coverage, cross-read scan, selection
      table, runner budget); update existing CI wiring tests
- [ ] Docs: references to Marketing Site / repo-quality test gating
- [ ] Real CI runs for at least two change kinds; durations and test counts recorded in PR

## Acceptance criteria

- [ ] API-touching ready run about 10 min; Workers shards balanced
- [ ] Selection table in PR, pinned by `scripts/quality/ci-suite-selection.test.ts`; a new package or a new
      dependency edge fails that test until the filters include it
- [ ] Main pushes run every suite
- [ ] Job counts before/after for API-only, web-only, shared-package PRs; worst case about 26 or less
- [ ] Test counts per suite unchanged from main where the suite runs
- [ ] Note on idea `01M7FYGMEESYH3AJZJ0CT3NKCZ`
