# SonarQube Cloud CI Coverage Ingestion

## Problem

SAM's GitHub Actions CI runs `pnpm test:coverage`, and the CLI job writes
`packages/cli/coverage.out`, but SonarQube Cloud currently uses Automatic Analysis.
Automatic Analysis cannot ingest coverage reports, the Vitest coverage runs do not emit
LCOV, and no CI scanner receives the Go report. As a result, Sonar reports no project
coverage measures and `0` new lines to cover even when the test suites exercise changed
production code.

This task owns only the coverage-report and CI scanner pipeline tracked by SAM Idea
`01M1P3WCG1183BCMED999BYE47`. It must not modify, close, push to, or merge PRs #2010,
#2011, or #2015. The merge continuation additionally must not modify PRs #2019 or #2021.
The result must remain a draft PR until the external Sonar cutover has been completed and a
real PR scan exposes nonzero coverage measures through Sonar's API.

## Preflight Classification

- `external-api-change`: introduces CI-based analysis through SonarQube Cloud's official
  GitHub Action.
- `cross-component-change`: connects Turbo/Vitest output, GitHub Actions artifacts, Go
  coverage, repository analysis settings, and SonarQube Cloud.
- `business-logic-change`: adds deterministic validation of coverage-report contracts.
- `docs-sync-change`: documents the operator cutover and validation procedure.
- `security-sensitive-change`: forwards a repository secret to a third-party action.
- `infra-change`: changes the repository CI workflow and its external configuration gate.
- Not a `public-surface-change` or `ui-change`; no runtime product behavior or UI changes.

## Research Findings

### Current repository behavior

- `.github/workflows/ci.yml:test` builds packages and runs `pnpm test:coverage`, but does
  not retain coverage as an artifact.
- Root `package.json:test:coverage` invokes each workspace through Turbo. Twelve pnpm
  workspaces expose Vitest-based coverage commands and therefore have deterministic
  report destinations under their workspace-local `coverage/` directory:
  - `apps/api/coverage/lcov.info`
  - `apps/tail-worker/coverage/lcov.info`
  - `apps/web/coverage/lcov.info`
  - `apps/www/coverage/lcov.info`
  - `packages/acp-client/coverage/lcov.info`
  - `packages/cloud-init/coverage/lcov.info`
  - `packages/eslint-plugin-sam/coverage/lcov.info`
  - `packages/providers/coverage/lcov.info`
  - `packages/shared/coverage/lcov.info`
  - `packages/terminal/coverage/lcov.info`
  - `packages/ui/coverage/lcov.info`
  - `infra/coverage/lcov.info`
- `vitest.coverage.ts:coverageConfig()` preserves package thresholds but declares only
  `text`, `json`, and `html` reporters. Other Vitest workspaces use the same default
  reporter set. The root coverage command can add LCOV consistently without changing
  any threshold.
- Workspace-local Vitest LCOV records use workspace-relative `SF:src/...` paths. A
  root Sonar scan needs those source paths normalized to repository-relative paths such
  as `packages/shared/src/...` so the analyzer can map records deterministically.
- `turbo.json:test:coverage` declares no outputs. A cached task is therefore not
  contractually required to restore `coverage/**` files.
- `.github/workflows/ci.yml:cli-test` already generates and uploads
  `packages/cli/coverage.out` as `cli-go-coverage`, but only for CLI changes.
- `sonar-project.properties` declares only
  `sonar.go.coverage.reportPaths=packages/cli/coverage.out`. It has no JS/TS LCOV
  paths.
- There is no scanner job. `gh secret list --app actions` exposes only the configured
  secret names and confirmed that `SONAR_TOKEN` is absent; `gh variable list` is empty.
- The public Sonar API baseline for main SHA
  `831d14e2a05c0bed92f419646828a826f9616c73` contains only
  `new_lines_to_cover=0`; it has no `coverage`, `lines_to_cover`, or `new_coverage`
  measure.

### Official service constraints

- SonarSource documents that JavaScript/TypeScript coverage requires CI-based analysis,
  LCOV output, and `sonar.javascript.lcov.reportPaths`; Automatic Analysis must be
  disabled before CI analysis to prevent conflicting duplicate analyses:
  <https://docs.sonarsource.com/sonarqube-cloud/enriching/test-coverage/javascript-typescript-test-coverage>
- SonarSource's GitHub Actions guide requires a `SONAR_TOKEN`, full Git history, and the
  official `SonarSource/sonarqube-scan-action`:
  <https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/ci-based-analysis/github-actions-for-sonarcloud>
- The current official action release is `v8.2.1` (2026-07-15), commit
  `22918119ff8e1ca75a623e15c8296b6ea4fbe28f`; repository policy requires immutable
  action SHAs:
  <https://github.com/SonarSource/sonarqube-scan-action/releases/tag/v8.2.1>
- SonarSource recommends a scoped organization token where the plan supports it. The
  token can be limited to this project and the `Execute analysis` permission:
  <https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/scoped-organization-tokens>
- GitHub does not pass Actions secrets to fork pull requests and recommends keeping
  secrets out of command-line arguments. The scanner must remain on `pull_request`, not
  `pull_request_target`, and must explicitly skip fork heads:
  <https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets>
- GitHub also treats Dependabot-triggered `pull_request` workflows like fork workflows and
  withholds ordinary Actions secrets. The two Sonar jobs must exclude `dependabot[bot]` unless
  a same-named Dependabot secret is deliberately provisioned:
  <https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions>

### Existing incident lesson and root-cause trace

The retained `docs/notes/2026-05-19-cli-sonar-quality-gap-postmortem.md` (available in
commit `746129eccef387e64d8362ba555606a21d8c76c1`) records the earlier class of failure:
a new package added coverage generation and a Sonar path without proving the entire CI
consumer path. That commit added the Go property, but Automatic Analysis still could not
consume it. Commit `7b69f9d64903a651cbe740595184cad251550fc0` centralized JS/TS thresholds without
adding LCOV. The current gap is therefore not low coverage; it is an unconnected report
producer/consumer boundary whose missing output has been interpreted as success.

### Merge continuation findings (2026-09-04)

- The continuation re-resolved the existing PR branch at `859e5f7f6` and current `main`
  at `510d9d9f9`, then merged current `main` without rewriting the PR branch.
- Repository-level Actions metadata still had no `SONAR_TOKEN` secret and no
  `SONAR_CI_ENABLED` variable. Neither GitHub deployment environment had a Sonar-named
  key. SAM exposed no agent-accessible deployment environment, Sonar-named workspace
  variable, or Sonar-looking project-library file.
- The public Sonar API showed that Automatic Analysis of PR #2020 had one reliability
  bug and two maintainability findings in `check-sonar-coverage.ts`: S2871 (default
  string sort), S3776 (LCOV parser complexity), and S3358 (nested ternary). The gate
  failed only on the D new-code reliability rating; coverage measures remained absent.
- The secured workspace GitHub identity was tested without logging credential values. It has
  read-only repository permission, and GitHub left SonarQube Cloud OAuth authorization disabled;
  it cannot administer the linked Sonar project or create the analysis token. No other
  SAM/project/repository/environment Sonar credential source exists. The minimum human action is
  for a Sonar project/org admin to disable Automatic Analysis and store a project-scoped Execute
  Analysis token as repository Actions secret `SONAR_TOKEN`; the continuation can then enable
  `SONAR_CI_ENABLED` and complete the live proof.

### Cross-component data flow

1. Root `package.json:test:coverage` invokes workspace coverage tasks through
   `turbo.json:test:coverage`.
2. Each Vitest workspace writes `coverage/lcov.info`; a repository quality command
   normalizes every `SF:` record and fails on missing, empty, or unresolvable reports.
3. `.github/workflows/ci.yml:test` uploads those validated paths from the checked-out
   workflow SHA.
4. The existing `.github/workflows/ci.yml:cli-test` artifact supplies Go coverage when
   CLI code changed; a supplemental Go-only producer supplies it on other enabled Sonar
   scans without rerunning the full CLI build/test job.
5. `.github/workflows/ci.yml:sonar` checks out the same SHA with full history, downloads
   the current workflow run's artifacts at their configured repository paths, validates
   them again, and invokes the pinned official scanner with `SONAR_TOKEN` scoped only to
   the fail-closed token check and scanner steps.
6. SonarQube Cloud associates the analysis with the PR/main SHA and exposes measures via
   `/api/measures/component` after the one-time external cutover.

### External-integration threat model

- The shared external resources are one SonarQube Cloud project and one GitHub repository
  secret. The scanner job has only `contents: read`; it receives no write-capable
  `GITHUB_TOKEN` permission.
- Fork PR code never receives `SONAR_TOKEN` and never runs the secret-bearing scanner
  job. The workflow does not use `pull_request_target`.
- A compromised scoped organization token can submit analysis only for the selected
  Sonar project with `Execute analysis`; it cannot administer the organization/project.
  Use an expiry and rotate before expiry. If the plan lacks scoped organization tokens,
  use a dedicated least-privilege account PAT with project-level Execute Analysis only.
- Self-hosters do not need this canonical repository's token to run SAM. This is
  contributor/repository quality infrastructure, documented with the quality tooling
  rather than as a deployment prerequisite.

## Implementation Checklist

### Report production and validation

- [x] Add LCOV to the root coverage invocation while retaining text, JSON, HTML, and all
      existing package thresholds.
- [x] Declare `coverage/**` as Turbo outputs so successful cached tasks restore reports.
- [x] Add a deterministic quality command that derives intended Vitest workspaces from
      pnpm manifests, normalizes LCOV source paths to repository-relative paths, and rejects
      missing, empty, malformed, or mispointed reports.
- [x] Test the validator with valid, missing, empty, malformed, source-mispointed, and
      `sonar-project.properties` drift cases.
- [x] Configure the exact derived JS/TS LCOV path list in `sonar-project.properties` and
      preserve `sonar.go.coverage.reportPaths=packages/cli/coverage.out`.

### CI artifact and scanner boundary

- [x] Validate and upload JS/TS LCOV from the existing `test` job; do not rerun the full
      pnpm suite in the scanner job.
- [x] Reuse the existing CLI artifact on CLI changes and add only the missing Go coverage
      producer for other enabled Sonar scans.
- [x] Add an opt-in `sonar` job that checks out the same SHA with full history, restores
      both artifacts to the configured paths, revalidates them, and runs pinned
      `SonarSource/sonarqube-scan-action` with least privilege.
- [x] Gate CI scanning on repository variable `SONAR_CI_ENABLED=true`, explicitly skip
      fork pull requests and Dependabot-triggered workflows, scope `SONAR_TOKEN` only to the
      fail-closed token check and scanner steps, and fail with a non-secret diagnostic when the
      gate is enabled without the secret.
- [x] Add structurally parsed workflow tests covering producer/consumer paths, action
      pins, current-run artifacts, change-filter behavior, fork safety, secret scope, and the
      no-duplicate-test invariant.

### Documentation and external cutover

- [x] Document the exact one-time cutover in `scripts/quality/README.md`: create a
      project-scoped Execute Analysis token, store it as repository secret `SONAR_TOKEN`,
      disable Automatic Analysis, then set repository variable `SONAR_CI_ENABLED=true`.
- [x] Document rollback (set `SONAR_CI_ENABLED=false` before re-enabling Automatic
      Analysis), token rotation, deterministic local validation, artifact paths, and the API
      queries used to prove nonzero coverage.
- [ ] Keep the PR draft and unmerged until a real same-repository PR scanner run succeeds
      and Sonar's API reports nonzero `lines_to_cover` plus coverage for the PR.
- [ ] After ordinary CI is green, request iterative CodeRabbit review with the
      `coderabbit-review` label and resolve all findings. The first real Sonar scan remains
      a separate merge blocker until the external cutover is complete.
- [x] Do not deploy this CI-only change to staging; staging validation is not applicable.
- [ ] After the now-authorized merge, monitor the repository's automatic production workflow to
      completion without starting a separate manual deployment.

### Merge continuation

- [x] Re-resolve the remote PR head and current `main`, reuse only PR #2020 and its
      existing branch, and merge current `main` without rewriting history.
- [x] Query the public Sonar API for the exact failed conditions and issues; fix all
      three findings without changing any quality threshold. Add a regression that
      distinguishes locale-aware alphabetical ordering from the unreliable default sort.
- [x] Exhaust the existing authorized GitHub/SAM/project credential sources without exposing
      values; record that none provides the required Sonar admin/token capability.
- [ ] Have a Sonar project/org admin create and store `SONAR_TOKEN`, disable Automatic Analysis,
      and then enable `SONAR_CI_ENABLED` in that documented order. Do not log or persist token
      values outside the GitHub secret.
- [ ] Prove on the final PR head that the scanner job executed (not skipped), all exact-head
      CI checks passed, and Sonar's API reports nonzero `lines_to_cover` and coverage with
      a green quality gate.
- [ ] Reconfirm current CodeRabbit approval with zero unresolved feedback, make the PR
      ready if needed, merge #2020, and monitor its production workflow to completion.

## Acceptance Criteria

- Every Vitest workspace participating in root `pnpm test:coverage` produces a
  nonempty deterministic LCOV report whose `SF:` entries resolve from the repository
  root; all existing thresholds and reporters remain intact.
- `sonar.javascript.lcov.reportPaths` exactly enumerates those report files, and the
  existing Go path remains unchanged.
- CI validates producer output before upload and consumer output after download. Tests
  prove missing, empty, malformed, and mispointed files fail.
- The scanner consumes artifacts from the existing coverage jobs on the same workflow
  SHA and never duplicates the full pnpm coverage run.
- The scanner uses immutable action SHAs, `contents: read`, a step-scoped secret, no
  `pull_request_target`, and explicit same-repository plus non-Dependabot guards.
- Documentation provides a no-double-analysis cutover and rollback. Enabling the gate
  without `SONAR_TOKEN` fails visibly without logging any token.
- Go-only changes receive both the CLI coverage artifact and the JS/TS project artifact;
  documentation-only changes do not trigger expensive repository coverage/scanning.
- Local focused tests, lint, typecheck, full tests, build, task-completion validation,
  domain reviews, ordinary PR CI, and CodeRabbit are recorded. Staging is explicitly
  not applicable for this CI-only change.
- The PR remains unmerged until a real PR scan reports nonzero Sonar measures.

## Validation Evidence

- TDD red: the initial coverage-pipeline suite failed all 18 cases before the validator
  and workflow wiring existed.
- Focused green: `sonar-coverage-pipeline.test.ts` passes 20/20 cases, including exact
  artifact layouts, current-run downloads, immutable action pins, fork gating, secret
  scope, change filters, and the no-duplicate-suite contract. The final four-file CI
  quality slice passes 32/32 tests.
- The first unbounded root coverage run and a bounded Turbo `--concurrency=2` retry
  exposed timeout flakes while API and web competed on the fallback container's single
  CPU and 4 GiB RAM. No repository concurrency, timeout, or threshold was changed.
- Isolated marketing coverage passes 2/2 tests and reports seven tracked TypeScript
  source files. The ignored generated tracker is no longer present in LCOV.
- Isolated web coverage passes 302/302 files and 3,600/3,600 tests with 22,697 line
  records and 65.61% line coverage. Isolated API coverage passes 656/656 files and
  8,841/8,841 tests with 48,175 line records and 71.08% line coverage.
- Aggregate `pnpm quality:sonar-coverage:javascript` validation passes for all 12 LCOV
  reports: 1,582 repository source files and 78,754 line records. Go profile generation
  remains delegated to the ordinary GitHub CLI job because this fallback container has no
  Go toolchain; fixture tests cover valid and invalid Go report contracts locally.
- The full repository quality-script suite passes 41/41 files and 562/562 tests. Full
  lint passes 13/13 Turbo tasks with the same six pre-existing warnings; full typecheck
  passes 19/19 tasks; and the production build passes 9/9 tasks. Prettier passes for all
  changed supported files, and `git diff --check` passes. The repository-wide formatting
  ratchet could not fetch its lazy-clone baseline objects because the shell GitHub token
  expired; ordinary CI runs that ratchet in a fresh full checkout.
- Recovery review added exact contracts for the retained text/JSON/HTML/LCOV reporter set,
  Turbo's `coverage/**` cache output, the fail-closed non-secret missing-token diagnostic,
  and the `GO_VERSION`-derived supplemental Go assertion. The focused four-file slice now
  passes 33/33 tests.
- Final test review hardened the root trigger and exact fork/gate predicates, asserted the
  single repository-wide full coverage invocation, covered every fail-closed parser branch,
  and proved existing outside files and symlink escapes are rejected. The same focused slice
  passes 42/42 tests.
- Continuation env review found that Dependabot-triggered workflows satisfy a same-repository
  predicate even though GitHub withholds ordinary Actions secrets. TDD then failed the two exact
  Sonar condition cases (2 failed, 28 passed) before both jobs gained GitHub's documented
  `github.actor != 'dependabot[bot]'` exclusion; the focused suite passes 30/30 afterward.
- GitHub rejected the first two shell feature-branch push attempts because the injected
  token became invalid. The implementation was recovered and published to existing PR #2020.
  Exact-head ordinary CI and CodeRabbit passed at continuation checkpoint `7bcfea0b2`, with
  both review threads resolved; they must run again after the Dependabot hardening commit. The
  external cutover and real Sonar measures remain pending.

## Post-Mortem

### What broke

SonarQube Cloud displayed no project coverage and `0.0%` new-code coverage despite CI
executing coverage-enabled tests.

### Root cause

Coverage generation, report formats, CI artifacts, scanner execution, and Sonar's
analysis method were changed independently. The repository declared one Go report path
but never delivered that file to a scanner, generated no LCOV, and kept Automatic
Analysis enabled even though it cannot import coverage.

### Timeline

- 2026-05-07: commit `7b69f9d6` centralized Vitest coverage thresholds with text/JSON/
  HTML output only.
- 2026-05-19: commit `746129ec` added CLI coverage generation and the Go Sonar path but
  no CI scanner.
- 2026-08-30: PR #2015 review recorded that Sonar's API had no coverage measure.
- 2026-09-04: Idea `01M1P3WCG1183BCMED999BYE47` scoped the supported CI-based cutover.
- 2026-09-04: the first real LCOV generation revealed that the marketing workspace also
  instrumented an ignored generated `public/scripts/tracker.js`; a workspace Vitest config
  now restricts the report to tracked TypeScript under `src/`.

### Why it was not caught

Tests asserted workspace coverage thresholds and parts of CI wiring, but nothing
reconciled configured Sonar paths with real nonempty reports at both sides of the
artifact boundary. Sonar's absence of coverage was also not treated as a failing signal.

### Class of bug and process fix

This is a silence-is-success cross-job artifact contract bug. The process fix is a
reusable deterministic report validator plus structural CI tests that fail when the
producer, artifact, consumer, source paths, or Sonar properties drift apart.

## References

- SAM Idea `01M1P3WCG1183BCMED999BYE47`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/05-preflight.md`
- `.claude/rules/14-do-workflow-persistence.md`
- `.claude/rules/19-external-service-integration.md`
- `.claude/rules/22-infrastructure-merge-gate.md`
- `.claude/rules/36-cli-quality.md`
- `.specify/memory/constitution.md` Principles II, III, VI, X, XI, XII, and XIII
