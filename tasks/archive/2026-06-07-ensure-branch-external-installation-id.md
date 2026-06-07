# Ensure Branch Uses External GitHub Installation ID

## Problem

`ensureBranchExistsOnRemote()` passes `state.config.installationId` directly into `ensureBranchExists()`. The state value is the internal `github_installations.id` DB row id, while `ensureBranchExists()` mints a token through `getInstallationToken()` and expects the external GitHub installation id. Non-default branch setup can therefore fail before workspace provisioning.

## Research Findings

- Idea: `01KTFA47T6PJM342NA5C88S2F1`.
- Caller: `apps/api/src/durable-objects/task-runner/workspace-steps.ts`.
- Token boundary: `apps/api/src/services/github-app.ts`.
- Existing pattern: routes such as `apps/api/src/routes/workspaces/runtime.ts` and `apps/api/src/routes/projects/devcontainer-configs.ts` load the installation row, then call `getExternalInstallationId(installation)` before `getInstallationToken()`.
- Existing tests: `apps/api/tests/unit/durable-objects/task-runner/ensure-branch-on-remote.test.ts` already covers the TaskRunner wrapper and is the right place for the regression.
- Relevant rule: `.claude/rules/35-vertical-slice-testing.md` requires realistic state at boundaries; this test should mock D1 with a realistic installation row and assert the payload sent to the GitHub service boundary.

## Checklist

- [x] Load the GitHub installation row in `ensureBranchExistsOnRemote()` using the DB row id from `state.config.installationId` and `state.userId`.
- [x] Pass `getExternalInstallationId(installation)` to `ensureBranchExists()`.
- [x] Keep missing/invalid installation lookup best-effort and logged so workspace creation behavior remains non-blocking.
- [x] Update `ensure-branch-on-remote.test.ts` to provide a realistic D1 mock.
- [x] Add a regression assertion that a DB ULID in config results in the external numeric GitHub installation id being passed to `ensureBranchExists()`.
- [x] Run focused tests and API validation.

## Acceptance Criteria

- Non-default branch setup resolves the stored installation row before token minting.
- The value passed toward token minting is the external GitHub installation id, not the internal DB row id.
- Default branch and invalid repository short-circuits still avoid DB/GitHub work.
- Regression coverage would fail against the old implementation.
