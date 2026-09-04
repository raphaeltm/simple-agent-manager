# Repository quality program

The quality program preserves the existing application runtime while progressively adding
deterministic repository checks. The root developer entry point is:

```bash
pnpm check:fast
```

It runs the formatting ratchet, the Oxlint shadow, authoritative workspace ESLint checks, and
the blocking type-boundary ratchet. CI invokes those same leaf commands rather than maintaining
different matcher logic in workflow YAML; see `.github/workflows/ci.yml` and
`scripts/quality/ci-quality-program.test.ts`.

## Authoritative and advisory layers

- ESLint 9 flat config remains authoritative. `eslint.config.mjs` preserves the captured legacy
  finding set, hosts `@simple-agent-manager/eslint-plugin-sam`, and retains `simple-import-sort`.
- The three `sam/*` rules are `error` (blocking) in production source and `off` in test files as
  of the 2026-08-11 ai-slop debt burn-down, once production sites reached zero. Their ownership,
  stages, and baselines live in `packages/eslint-plugin-sam/rules.manifest.json`; fixtures run
  with ESLint 9 `RuleTester`.
- `pnpm quality:type-boundaries` is the blocking net-count ratchet. The baseline in
  `scripts/quality/type-boundary-baseline.json` was driven to zero blocking-class debt (0/0/0/0
  across `as-any`, `hono-req-json-generic`, `typed-json-parse`, `local-record-guard`) by the
  2026-08-11 ai-slop debt burn-down, so any single new occurrence now fails the ratchet with
  deterministic `file:line` output. `JSON.parse(...) as unknown` is allowed. Broad
  `Record<string, unknown>` and `as unknown as` populations remain report-only — recorded for
  visibility at 66 and 114 respectively, and never failing the run.
- `pnpm quality:runtime-boundary-semantics` runs the two bounded ts-morph checks for unvalidated
  DO/D1 row narrowing and blind external-payload narrowing. It is not a whole-repo type-aware gate.
  Blocking is driven by `scripts/quality/runtime-boundary-semantic-evidence.json`: when
  `blockingEnabled` is true and its `scope` matches the scope being audited (`apps/api/src` as of
  the 2026-08-11 ai-slop debt burn-down, promoted after reaching 0 diagnostics), any new diagnostic
  fails the run with a nonzero exit code — no `--fail-on-findings` flag required. Other scopes
  remain advisory (exit 0 regardless of findings) until their own evidence is promoted.
- `pnpm lint:oxlint` is report-only. Promotion is forbidden until
  `scripts/quality/lint-adoption-evidence.json` records finding, fix-diff, scope, template,
  suppression, and cold-performance parity. Type-aware Oxlint is disabled.

Boundary guidance and sanctioned Valibot patterns are in
`.claude/rules/51-runtime-boundary-validation.md`. Current helpers live in
`apps/api/src/lib/runtime-validation.ts` and `apps/api/src/schemas/_validator.ts`.

## Workspace and template coverage

`scripts/quality/workspace-quality-coverage.test.ts` proves that every pnpm workspace has the
intended lint and type/template-validation scripts. Astro templates use `astro check`; they are
not described as TypeScript compiler coverage. `tools/og-image` uses its scoped TypeScript
configuration.

## Supply-chain checks

- `pnpm quality:direct-dependency-evidence` requires authoritative evidence for direct npm and Go
  manifest changes. Its checked-in snapshot makes staged, unstaged, and untracked manifest
  changes visible to the same policy.
- `pnpm quality:gitleaks:current` and `pnpm quality:gitleaks:pr` run Gitleaks against the current
  tree and PR range. Both modes accept only exact, unredacted, expiring digests from the reviewed
  baseline, so a formatting-only touch to a known marker does not require history rewriting while
  changed bytes remain blocking. Public logs expose counts and disposition only; secret-like
  findings and full-history evidence remain private.
- `pnpm quality:govulncheck-diff` blocks locally changed Go modules and uses the locked tool module
  in `scripts/quality/govulncheck-tool/`.

Scanner jobs install the frozen lockfile without lifecycle scripts, and CI passes explicit scanner
binary paths to the wrappers. Do not publish scanner reports, hashes, advisories, or candidate
secret material in logs, PR text, or public issues.

## SonarQube Cloud coverage ingestion

The CI workflow retains LCOV from the existing `pnpm test:coverage` run instead of running the
JavaScript/TypeScript suites again. `pnpm quality:sonar-coverage:javascript` invokes `runCli` and
`prepareJavaScriptCoverageReports` only to normalize every `SF:` entry to a repository-relative
source path and reject missing, empty, malformed, or mispointed reports. The CI `test` job then
separately uploads these current-run files as the `js-ts-lcov` artifact:

```text
apps/api/coverage/lcov.info
apps/tail-worker/coverage/lcov.info
apps/web/coverage/lcov.info
apps/www/coverage/lcov.info
infra/coverage/lcov.info
packages/acp-client/coverage/lcov.info
packages/cloud-init/coverage/lcov.info
packages/eslint-plugin-sam/coverage/lcov.info
packages/providers/coverage/lcov.info
packages/shared/coverage/lcov.info
packages/terminal/coverage/lcov.info
packages/ui/coverage/lcov.info
```

Go coverage remains at `packages/cli/coverage.out` in the `cli-go-coverage` artifact. The ordinary
CLI job produces it when CLI inputs change. When CI-based Sonar analysis is enabled and that job
is skipped, the bounded `Sonar Go Coverage` job runs only the CLI tests needed to produce the
report. The scanner job downloads both artifacts from the same workflow run, validates every
input with `pnpm quality:sonar-coverage`, and then invokes the SHA-pinned official scanner action.
It has `contents: read` permission, does not run for fork pull requests, and exposes
`SONAR_TOKEN` only to the token check and scanner steps.

Coverage import requires CI-based analysis; SonarQube Cloud Automatic Analysis does not import
these reports. Automatic and CI-based analysis must not run together. Complete this one-time
cutover in order:

1. In SonarQube Cloud, create an expiring token limited to this project and the **Execute
   Analysis** permission when the organization plan supports scoped tokens. Otherwise, use a
   dedicated analysis-only user token with the narrowest available permissions.
2. From a trusted terminal for `raphaeltm/simple-agent-manager`, run `gh secret set SONAR_TOKEN`
   and provide the value through its standard-input prompt. Never put the token in a command-line
   argument, log, issue, or pull-request body.
3. In the SonarQube Cloud project, open **Administration → Analysis Method** and disable
   **Automatic Analysis**.
4. Only after the secret exists and Automatic Analysis is off, enable the repository gate with
   `gh variable set SONAR_CI_ENABLED --body true`.
5. Push or rerun the draft pull request. Require the `SonarQube Cloud` job to succeed, then query
   the pull-request measures (replace `<PR>`):

   ```bash
   curl --fail --silent --show-error \
     'https://sonarcloud.io/api/measures/component?component=raphaeltm_simple-agent-manager&pullRequest=<PR>&metricKeys=coverage,lines_to_cover,new_coverage,new_lines_to_cover'
   ```

   Do not mark the rollout complete or merge the draft until this response maps nonzero lines to
   cover and real coverage values to the pull request.

If the CI scanner must be rolled back, first run
`gh variable set SONAR_CI_ENABLED --body false`; only then re-enable Automatic Analysis. This
ordering avoids double analysis. Rotate or revoke `SONAR_TOKEN` through SonarQube Cloud and update
the repository secret with the same standard-input command.

This follows the official SonarSource guidance for
[JavaScript/TypeScript coverage](https://docs.sonarsource.com/sonarqube-cloud/enriching/test-coverage/javascript-typescript-test-coverage),
[GitHub Actions analysis](https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/ci-based-analysis/github-actions-for-sonarcloud),
[Automatic Analysis](https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/automatic-analysis),
and
[scoped organization tokens](https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/scoped-organization-tokens).

## Rollback switches

Each layer is independently reversible:

- keep or restore ESLint as the complete authoritative layer and leave Oxlint report-only;
- disable the blocking `sam/*` rules without changing the independent type-boundary ratchet;
- remove a leaf invocation from CI or `check:fast` without changing application runtime;
- disable an individual supply-chain job without publishing or accepting its findings as a new
  baseline.

Never remove the current authoritative path until its replacement has passed the documented
parity and rollout gates.
