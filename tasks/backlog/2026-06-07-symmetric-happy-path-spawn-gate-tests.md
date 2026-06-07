# Add symmetric happy-path provisioning assertions for task submit/run spawn gate

**Severity:** LOW (test-symmetry advisory from task-completion-validator on the
user∩app repo-access-intersection PR — branch
`sam/implement-sam-idea-01ktfg04qbd8n34a7v00pgkyjz-01ktgk`)

## Problem Statement

`apps/api/tests/unit/routes/spawn-repo-access-gate.test.ts` has a positive
route-level assertion only for the **workspace create** path
(`expect(mocks.createNodeRecord).toHaveBeenCalled()` when access is intact).
The **task submit** and **task run** paths have only the negative fail-fast
(access-revoked → 403, `startTaskRunnerDO` NOT called) assertions. There is no
analogous "gate passes → `startTaskRunnerDO` reached" positive assertion for
those two paths at the route level.

Acceptance criterion 2 ("Happy path unaffected — user with access spawns as
before") is therefore satisfied for task submit/run only at the **helper** level
(`require-repository-user-access.test.ts` happy-path test), not at the route
level.

## Why deferred (not fixed in the originating PR)

- **LOW severity, explicitly non-blocking.** The validator's verdict was "PASS
  (with one LOW advisory)" and "No blockers to merge."
- **The gate is already proven wired and blocking** on both task paths by the
  existing fail-fast tests — if the gate call were removed from `submit.ts` or
  `run.ts`, those access-revoked tests would return 2xx instead of 403 and fail.
- **The pass-through-to-provision linkage is already proven** at the route level
  for workspace create and at the helper level for the gate logic itself.
- **High mocking cost for the task paths.** A submit happy-path test must mock
  the entire downstream task-submission pipeline unrelated to the access gate:
  `resolveCredentialSource` (dynamic import of `provider-credentials`),
  `generateTaskTitle` (AI call), `enrichMessageWithMentions`, `generateBranchName`,
  `resolveSkillProfile`, `resolveProjectAgentDefault`, and
  `projectDataService.createSession`/`persistMessage`. The run happy-path test
  additionally needs `env.DATABASE.prepare().bind().run()` returning
  `{ meta: { changes: 1 } }` plus `createSession`. Coupling this focused
  access-gate test file to those subsystems makes it brittle.

## Acceptance Criteria

- [ ] `spawn-repo-access-gate.test.ts` adds a task-submit happy-path test that
      asserts `mocks.startTaskRunnerDO` was called when the user retains access
      (mocking the downstream submission pipeline at its boundaries).
- [ ] Same for task run (`startTaskRunnerDO` called when access intact).
- [ ] Both new tests also assert `getUserInstallationRepositories` was consulted
      with the user OAuth token + external installation id (gate ran before
      provisioning).

## References

- Originating PR: user∩app repo-access intersection (SAM idea
  `01KTFG04QBD8N34A7V00PGKYJZ`)
- `.claude/rules/35-vertical-slice-testing.md`
- task-completion-validator LOW finding, 2026-06-07
