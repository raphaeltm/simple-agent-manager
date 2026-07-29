# Fix Duplicate Platform Feedback Environment Declaration

## Problem

Main CI run `30500120567` fails API type checking after PRs #1698 and #1699
merged parallel definitions of `PLATFORM_FEEDBACK_PROJECT_ID` into
`apps/api/src/env.ts`. TypeScript reports duplicate identifier errors at lines
101 and 847, blocking the Report an Issue production deployment.

## Research Findings

- Commit `14ac2a2b` added the shared project ID beside the other
  `PLATFORM_FEEDBACK_TRIAGE_*` environment fields near the top of `Env`.
- Commit `7b63b16e` independently added the same optional string in the later
  Report Issue block beside report-specific size limits.
- Both consumers intentionally share one public environment contract. The
  canonical declaration is the earlier platform-feedback configuration group;
  the later declaration is redundant.
- Deployment propagation, wrangler sync, `.env.example`, and service tests
  already reference the unchanged variable name. No public contract or runtime
  behavior should change.
- This is a containment hotfix. Loop B and unrelated environment cleanup are
  explicitly out of scope.
- Relevant retained lesson: parallel feature branches that share an interface
  require integration validation on their merged result; exact CI evidence and
  a minimal fix should be recorded in the hotfix PR.

## Implementation Checklist

- [x] Remove only the redundant Report Issue block declaration from
      `apps/api/src/env.ts`, retaining the canonical platform-feedback field.
- [x] Confirm all deployment, documentation, and test references still use
      `PLATFORM_FEEDBACK_PROJECT_ID`.
- [x] Run API typecheck/build and relevant report/triage/env configuration tests.
- [ ] Run required task-completion, Cloudflare, env, documentation, and
      constitution reviews.
- [ ] Deploy the hotfix branch to staging and verify the API/app remain healthy.
- [ ] Open a hotfix PR with CI failure and fix evidence; merge only after green
      CI, then monitor the matching production deployment.
- [ ] After merge, redeploy fixed `main` to staging and coordinate enabled-mode
      Report Issue verification with task `01KYQZZCMRTQ9F8W0FQSXBN6J4`.

## Acceptance Criteria

- `apps/api/src/env.ts` contains exactly one optional
  `PLATFORM_FEEDBACK_PROJECT_ID` declaration.
- The environment variable name, optional type, deployment mapping, and staging
  value contract remain unchanged.
- API typecheck/build and focused report/triage/env tests pass.
- Hotfix PR CI is green and the merged commit's production deployment succeeds.
- Fixed-main staging verification confirms enabled configuration, visible UI,
  successful submissions with and without refs, Idea create/update behavior in
  project `01KHRJGANBBWGDY1NZ0KVF0D4J`, and PII/secret-safe generated content.

## References

- Main CI run `30500120567`
- Pre-fix staging run `30500228487`
- PR #1698 / commit `14ac2a2b`
- PR #1699 / commit `7b63b16e`
- Frontend coordination task `01KYQZZCMRTQ9F8W0FQSXBN6J4`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/14-do-workflow-persistence.md`
- `.claude/rules/25-review-merge-gate.md`
