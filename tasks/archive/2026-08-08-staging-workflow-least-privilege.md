# Staging Workflow Least Privilege (WP-121)

## Problem

`.github/workflows/deploy-staging.yml` grants `pull-requests: write` to the
staging deployment workflow even though neither the caller nor the secret-bearing
reusable deployment workflow writes to pull requests. This violates least
privilege and unnecessarily broadens the impact of a compromised deployment step.

The delivery contract is one open, green, unmerged PR. This source PR must not
deploy to shared staging; the final integration task owns staging verification.

## Preflight Classification and Impact

- Change classes: `security-sensitive-change`, `infra-change`, and
  `cross-component-change` (caller workflow to reusable workflow).
- Public/API/CLI/data behavior: unchanged.
- Deployment behavior: unchanged; `workflow_dispatch`, reusable inputs, inherited
  secrets, dry-run propagation, and smoke-test sequencing remain intact.
- Out of scope: WP-117 authenticated-smoke enforcement and any speculative PR
  commenting behavior.
- Constitution alignment: the change removes authority and adds no URLs,
  timeouts, limits, identifiers, secrets, or new deployment prerequisites.

## Research Findings

1. Current `origin/main` at `8eed3b7402d2e036900a67db0232fe6c8623155a`
   still grants `pull-requests: write` in `.github/workflows/deploy-staging.yml`.
2. Commit `3ec20f63b` introduced the permission for a reusable
   `Comment Staging URLs on PR` step.
3. Commit `aaa6e00e6` removed that dead PR-comment step, but did not remove its
   caller permission. No current step in either staging workflow uses a PR write
   API, `gh pr comment`, or a PR-commenting action.
4. GitHub documents that a called reusable workflow receives the caller job's
   token permissions and may only downgrade them. The call job is therefore the
   narrowest place to declare the deployment contract.
5. The foundation-packet release order places WP-121 in W0. WP-117 is W2 and may
   later touch the smoke-test section, so this change must stay narrowly scoped
   and rebase conservatively.

## Post-Mortem

- **What broke**: a staging deploy retained repository pull-request write access
  after the only feature using that access was deleted.
- **Root cause**: commit `aaa6e00e6` removed the PR-commenting step without
  treating its adjacent permission as part of the same capability lifecycle.
- **Timeline**: the authority and commenting step were added together on
  2026-03-01 (`3ec20f63b`); the step was removed on 2026-04-13
  (`aaa6e00e6`); R10-012 identified the retained authority on 2026-08-08.
- **Why it was not caught**: workflow tests covered deploy behavior and pins, but
  no permission contract connected granted scopes to active capabilities.
- **Class of bug**: orphaned security authority after feature removal.
- **Process fix**: add a focused permission-contract regression test that rejects
  the original top-level grant, job-level relocation, broad write grants, and
  reintroduction of a PR-writing consumer without an isolated permission design.

## Implementation Checklist

- [x] Add a scenario-driven workflow permission contract test and first prove it
      fails against the current vulnerable staging workflow.
- [x] Scope the reusable deploy call to the required `contents`, `id-token`, and
      `deployments` permissions only; remove PR authority everywhere in scope.
- [x] Keep the smoke-test job unprivileged beyond its checkout requirement.
- [x] Prove the reusable call path, input types, and dry-run propagation remain
      valid.
- [x] Run the focused Vitest contract suite and pinned `actionlint` against all
      workflows.
- [x] Run all applicable repository quality gates without piping or skipped output;
      record current-main/local-runner failures separately from branch regressions.
- [x] Complete security, independent defensive, constitution, and test-quality
      reviews; address every correctness finding.
- [x] Complete the mandatory task-completion review immediately before archive.
- [x] Rebase on current `origin/main`, re-run validation, push, open one PR, and
      wait for every GitHub check to finish green.
- [x] Leave the PR open and unmerged; do not trigger shared staging.

## Acceptance Criteria

- [x] `pull-requests: write` is unavailable to both the staging caller and the
      called reusable workflow.
- [x] The reusable deploy job receives only the documented minimum deployment
      scopes; unspecified token scopes resolve to `none`.
- [x] No workflow step in scope requires or attempts PR write access.
- [x] The staging caller still invokes `deploy-reusable.yml` with `environment`,
      `skip_agent`, `dry_run`, and inherited secrets unchanged.
- [x] The reusable workflow's boolean dry-run contract remains valid under
      `actionlint` and the focused contract test.
- [x] Local applicable CI and every GitHub PR check are completely green.
- [x] PR evidence records that staging was intentionally not deployed and the PR
      was intentionally not merged under the direct user override.

## Validation Evidence

- TDD red: the new permission contract failed against the original workflow,
  reporting both the unexpected exact-allowlist entry and
  `pull-requests: write`.
- Focused contract suites: 44/44 passed across the new staging-permission,
  reusable-workflow, and deployment-hardening suites.
- Security, constitution, test-quality, and independent defensive reviewers
  approve after adversarial re-review. Their attempted bypasses now have
  regression fixtures for quoted and Unicode-escaped YAML keys, nested reusable
  permission overrides, multiline token-backed `gh api`, and third-party PR
  comment actions.
- `pnpm install --frozen-lockfile` passes with the new direct `yaml@2.9.0` test
  dependency. Its lockfile change is limited to the root importer's three lines;
  the package and snapshot already existed in the base lock.
- Repository quality scripts: 225/225 passed. Source-contract, file-size,
  dependency-governance, and stale-binary checks also passed.
- `actionlint` v1.7.12 passed every repository workflow after its official
  GitHub artifact attestation was verified. Optional shellcheck/pyflakes
  integrations were disabled because those binaries are not installed.
- `pnpm lint -- --quiet` passed (7/7), `pnpm typecheck` passed (16/16), and
  `pnpm build` passed (9/9).
- The exact local `pnpm test:coverage` gate completed but the API package had 20
  timeout-only failures under workspace load. No API file differs from
  `origin/main`, and the exact base SHA has a successful GitHub CI run. This is
  recorded as a local-runner limitation, not as a green result; clean-runner
  GitHub CI must pass before delivery.
- Repository-wide `pnpm format:check` reports 2,394 pre-existing files on the
  unchanged base. Every file changed by WP-121 passes its focused Prettier
  check.
- Task-completion validation passed checks A-F with no missing implementation,
  contract, or verification work. Rebase, PR checks, and final release-state
  evidence remain sequential delivery gates.
- The branch rebased cleanly onto `origin/main` at
  `8eed3b7402d2e036900a67db0232fe6c8623155a`; the rebase was a no-op because
  main had not advanced. Post-rebase frozen install, actionlint, focused 44/44,
  quality 225/225, lint, typecheck, and build all passed.
- PR #1772 is open and unmerged. GitHub CI run `31259521318`, E2E Smoke run
  `31259521329`, CodSpeed run `31259521315`, and SonarCloud all completed green,
  including Test (7m26s) and Durable Object Workers (7m50s).
- Shared staging was intentionally not deployed or mutated. The final
  integration task retains ownership of staging verification.

## References

- `.github/workflows/deploy-staging.yml`
- `.github/workflows/deploy-reusable.yml`
- `scripts/quality/deploy-reusable-workflow.test.ts`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/05-preflight.md`
- `.claude/rules/14-do-workflow-persistence.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.specify/memory/constitution.md`
