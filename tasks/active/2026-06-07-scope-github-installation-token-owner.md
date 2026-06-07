# Scope GitHub Installation Token Owner

## Problem Statement

`POST /api/workspaces/:id/git-token` can mint a GitHub App installation token after loading a `github_installations` row by row id only. If a workspace points at another user's installation row, the callback path can mint a token for the wrong owner. This is the same bug class as PR #1236 and must fail closed at the token-minting boundary.

## Research Findings

- SAM idea `01KTFA36XHHPXAC4EE03SG4FHT` identifies `apps/api/src/routes/workspaces/runtime.ts` as the primary affected path.
- The workspace callback route already loads `workspace.userId`; that owner must be used to scope the installation row lookup.
- `apps/api/src/routes/projects/_helpers.ts` has the correct session-path pattern in `requireOwnedInstallation(db, installationRowId, userId)`.
- `apps/api/tests/unit/routes/workspace-git-token.test.ts` already exercises the runtime callback route and can host realistic owner-match and owner-mismatch behavioral tests.
- PR #1236 archived task `tasks/archive/2026-06-06-fix-github-personal-installation-leak.md` documents the original leak and the need to keep GitHub token paths scoped to verified user context.
- Current `getInstallationToken` callers:
  - `projects/devcontainer-configs.ts` derives the row through `requireOwnedInstallation`, already owner-scoped.
  - `projects/crud.ts` derives rows through `requireOwnedInstallation` and verifies repository access with user context.
  - `github.ts` repository/branch paths query rows by authenticated user id and use user-context repository APIs.
  - `workspaces/runtime.ts` is the missing callback-context owner scope.
  - Internal `services/github-app.ts` calls operate from external installation ids already passed to service helpers; they do not load `github_installations` rows.
  - `github-repo-id-backfill.ts` has a batch helper that resolves installation ids by row id for legacy backfill; this task is focused on runtime token minting, but the audit result should be documented in the PR.

## Implementation Checklist

- [x] Add owner scoping to the runtime `git-token` installation lookup using `workspace.userId`.
- [x] Log owner-scope validation failures with workspace id, project id, installation row id, and expected user id before rejecting.
- [x] Add behavioral test: owner-matching installation row mints a token.
- [x] Add behavioral test: mismatched/absent owner-scoped row returns 404 and does not call `getInstallationToken`.
- [x] Ensure the test stub proves the query includes both installation row id and owner user id rather than relying on source-text assertions.
- [x] Re-run focused API tests and relevant quality checks.
- [x] Run security-focused review against rules 28 and 11.

## Acceptance Criteria

- A workspace whose installation row belongs to the workspace owner can mint the GitHub token as before.
- A workspace whose installation row belongs to another user is rejected before token minting.
- The rejected path does not call `getInstallationToken`.
- Validation failures emit structured diagnostic context and fail fast.
- Other GitHub App token callers are audited and are either already owner-scoped or explicitly out of scope with rationale.

## References

- SAM idea `01KTFA36XHHPXAC4EE03SG4FHT`
- PR #1236 commit `5be1ea96`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/11-fail-fast-patterns.md`
- `tasks/archive/2026-06-06-fix-github-personal-installation-leak.md`
