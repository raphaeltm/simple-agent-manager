# Fix SonarCloud Quality Gate and Deploy Decoupling

## Problem

SonarCloud is failing the Quality Gate on `main`, and production deploys must remain reliable even when the separate SonarCloud Code Analysis check reports quality issues. The current failing SonarCloud conditions include security hotspots, new-code duplication over the 3% threshold, and C security/reliability ratings on new code.

The PR must not be merged automatically. It should be left ready for human review.

## Research Findings

- `.github/workflows/deploy.yml` triggers production deploys from the `CI` workflow via `workflow_run` and currently requires `github.event.workflow_run.conclusion == 'success'` on `main`.
- `.github/workflows/ci.yml` does not contain an explicit SonarCloud job. SonarCloud is reported as a separate GitHub App check named `SonarCloud Code Analysis`.
- GitHub evidence for main SHA `b95e6a3b15558bdc654f42bc778fb7647ff45cc2`:
  - `CI` workflow run `26326931723` succeeded.
  - `Deploy Production` workflow run `26327081678` succeeded.
  - `SonarCloud Code Analysis` check failed separately with 202 security hotspots, 3.4% duplication on new code, C security rating, and C reliability rating.
- `sonar-project.properties` already excludes test files and workflows from CPD, but the SonarCloud public API still reports new duplicated lines in tests/workflows and source files.
- Top duplicated new-code files from SonarCloud API:
  - `packages/shared/src/constants/ai-services.ts`: 102 duplicated lines.
  - `apps/web/tests/playwright/chat-layout-scroll-audit.spec.ts`: 73 duplicated lines.
  - `apps/api/src/routes/ai-proxy.ts`: 60 duplicated lines.
  - `apps/api/src/routes/chat.ts`: 34 duplicated lines.
- Relevant postmortem: `docs/notes/2026-05-19-cli-sonar-quality-gap-postmortem.md` emphasizes treating Sonar findings as real quality work, wiring package checks correctly, and reducing avoidable duplication.

## Implementation Checklist

- [ ] Preserve the do-not-merge constraint in state, task tracking, and PR wording.
- [ ] Update deploy workflow behavior or documentation so production deploy coupling is explicitly to GitHub Actions CI only, not the separate SonarCloud GitHub App check.
- [ ] Refactor `packages/shared/src/constants/ai-services.ts` to remove repeated model metadata blocks without changing exported model values.
- [ ] Re-query or locally inspect Sonar duplication after the refactor; address the next offender if the margin is still too narrow.
- [ ] Inspect Sonar reliability/security-rating issue evidence and fix any small, clear correctness issue found.
- [ ] Run relevant unit/type/lint/build validation.
- [ ] Run required specialist review skills for config/business-logic/test changes.
- [ ] Check active staging deploy runs, deploy the branch to staging, and verify the workflow/config change.
- [ ] Create a PR and stop without merging.

## Acceptance Criteria

- Production deploys are not blocked by the separate SonarCloud Code Analysis check.
- SonarCloud still runs and reports findings.
- New-code duplication is reduced below the 3% Quality Gate target or the PR documents why the remaining reported duplication is outside the changed code path and what remains.
- No attempt is made to clear all historical security hotspots.
- Validation evidence is recorded in the PR.
- The PR is left unmerged for human review.

## References

- `.github/workflows/ci.yml`
- `.github/workflows/deploy.yml`
- `.github/workflows/deploy-staging.yml`
- `sonar-project.properties`
- `docs/notes/2026-05-19-cli-sonar-quality-gap-postmortem.md`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/14-do-workflow-persistence.md`
