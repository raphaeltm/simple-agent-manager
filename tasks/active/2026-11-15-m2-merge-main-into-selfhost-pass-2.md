# M2: merge main into sam/selfhost-pass-2 (draft PR, do not merge)

Task `01M7FSE836S5NQ37DJRR2PR59Z`, coordinator task `01M7FB384QHQ1TQCK95D0SX0TX`.
Branch `sam/task-m2-merge-latest-2pr59z`, base `sam/selfhost-pass-2`. Model: M1 (#2736).

## Problem

Main gained L7 (#2749), L4 (#2746) and seven unrelated commits since the M1 merge (`84d77aa0f`).
Merge them into the integration branch so landed code resolves to main's version.

## Research findings

- Merge parents: `c02f82651af78c0366d74daf27c49c695a6d8c04` (integration) and
  `c616e356ce1b6b17bcfa66afc801c5c39e3d853c` (main). Merge commit `17a464e51`.
- Diff before (`origin/main...c02f82651`): 872 files, +86,752 / -2,827.
- 18 files conflicted (see PR table). Silent breakage found during resolution: the admin
  settings registry auto-merged with `operations.nodeProvisioningAttemptDeadlineMs` defined
  twice (main 60 s / 5-180 s; branch 45 s / 1-600 s), and admin-settings.md documented both.
- #2748 GitLab trust (untrusted runtime-saved host: host-scoped ids, emails unverified, no
  override, not in trustedProviders) and the branch's guarded GitLab provider are combined in
  `gitlab-login-provider.ts`; main's `untrustedGitLabUserInfo` (unguarded fetch) removed.
- Branch's `closeSetupWithoutToken` is now subsumed by main's `isSetupCompleted` owner check
  (kept, listed as noticed redundancy, not refactored).

## Checklist

- [x] Merge origin/main with a real merge commit; resolve 18 conflicts
- [x] Remove duplicate registry entry and doc row; delete branch-only deadline module
- [ ] Audit: admin settings registry, wrangler.toml DO bindings/migrations vs main, D1 numbering,
      index.ts hosted-git import, celld-project.ts / celld-config.ts, ci.yml hosted-git job
- [ ] Checks: build, typecheck, lint (check:fast), full tests, selfhost:test, hosted-git
      conformance, quality:wrangler-bindings, DO migration compatibility tests, quality gates
- [ ] Draft PR (base sam/selfhost-pass-2), CI by hand, SonarCloud
- [ ] Reviews: cloudflare-specialist, task-completion-validator
- [ ] Diff measure after; box-round checklist; PR #2750 conflict check

## Acceptance criteria

- Landed code (L7, L4) equals main's; branch keeps only unlanded behaviour.
- wrangler.toml DO bindings and migrations byte-identical to origin/main.
- No duplicate D1 migration numbers introduced by the merge; no duplicate settings.
- All checks and CI green; draft PR not merged.
