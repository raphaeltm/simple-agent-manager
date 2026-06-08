# Harden GitHub Token Injection

## Problem

Idea `01KTHTZSJDHSJ7EG6SHS3PW6GQ` requires hardening every GitHub token that reaches a workspace so the final mint boundary enforces the intersection of workspace callback auth, workspace owner, installation owner, current user GitHub OAuth access, exact repository identity, single-repo token scope, and SAM platform profile policy.

This is security-sensitive credential work. The PR must be draft or clearly marked **DO NOT MERGE**, must not be marked ready, and must not be merged without later explicit human authorization.

## Research Findings

- `apps/api/src/routes/workspaces/runtime.ts` already scopes `/api/workspaces/:id/git-token` to workspace callback auth, workspace owner installation rows, single repository token options, and `githubCliPolicy`, but it does not live-check the workspace owner's current user OAuth repo access before minting.
- `apps/api/src/routes/projects/_helpers.ts` has the session-context `requireRepositoryUserAccess()` pattern using `assertRepositoryAccess()` and `/user/installations/{id}/repositories`.
- `apps/api/src/services/github-user-access-token.ts` currently depends on Hono request headers, so the callback route needs a server-side owner token lookup helper or equivalent fail-closed verifier.
- `packages/vm-agent/internal/bootstrap/bootstrap.go` renders `git-credential-sam` with the durable workspace callback token literal and writes static `GH_TOKEN` into profile/static env files when a token is available.
- `packages/vm-agent/internal/acp/session_host_startup.go` only fetches a fresh GitHub token when `GH_TOKEN` is absent, so stale static env tokens can win.
- Existing tests include `apps/api/tests/unit/routes/workspace-git-token.test.ts`, `packages/vm-agent/internal/server/git_credential_test.go`, and `packages/vm-agent/internal/bootstrap/bootstrap_test.go`.
- Prior ideas `01KTFG04QBD8N34A7V00PGKYJZ` and `01KTFA36XHHPXAC4EE03SG4FHT` establish that owner-row scoping is necessary but insufficient; runtime token minting must verify current user and app installation access.
- Architecture preference: GitHub hardening must preserve same-org submodule clone/fetch/update workflows where possible.

## Implementation Checklist

- [ ] Add a callback-safe final GitHub access verifier for `/git-token` that fails closed when the owner OAuth token is missing/revoked, repo is not visible, installation is inaccessible, or repo ID drift is detected.
- [ ] Ensure `/git-token` calls the verifier before `backfillProjectGithubRepoId()`, `resolveWorkspaceGitHubTokenOptions()`, or `getInstallationToken()`.
- [ ] Preserve Artifacts/non-GitHub behavior explicitly.
- [ ] Add safe structured logs for denied token mint attempts without raw tokens.
- [ ] Stop embedding durable workspace callback token literals in generated git credential helper scripts.
- [ ] Reduce static `GH_TOKEN` persistence and make ACP startup prefer a fresh scoped token over any stale env-file value.
- [ ] Add defense-in-depth preflight checks for restart/rebuild, MCP dispatch, SAM-session dispatch, triggers, webhooks, and direct agent-session start where current code still lacks them.
- [ ] Fix profile policy propagation gaps in retry, MCP orchestration replacement, project orchestrator scheduling, and task run paths.
- [ ] Add/extend required API and VM-agent tests, including negative tests that assert `getInstallationToken()` is not called.
- [ ] Run local quality gates and security-focused review.
- [ ] Deploy through GitHub Actions staging only and verify workspace clone/git/gh flows plus denied behavior; document exact evidence in the draft PR.

## Acceptance Criteria

- [ ] No GitHub installation token is minted for a workspace unless the workspace owner currently has user∩app access to the exact repository.
- [ ] Minted GitHub tokens are single-repository scoped for GitHub-backed projects and permission-narrowed by custom `githubCliPolicy`.
- [ ] Malformed stored profile policy fails closed.
- [ ] Spawn/restart/dispatch/trigger/session paths fail before provisioning when repo access is revoked where applicable.
- [ ] Generated credential helper scripts do not contain durable workspace callback token literals.
- [ ] ACP, git, and `gh` paths use fresh scoped credentials and do not prefer stale static `GH_TOKEN`.
- [ ] Existing clone, `git fetch`, safe `git push`, and `gh repo view` flows work on staging.
- [ ] Draft/DO NOT MERGE PR includes tests, staging evidence, and residual risks, with no raw token values.

## References

- Idea `01KTHTZSJDHSJ7EG6SHS3PW6GQ`
- Prior ideas `01KTFG04QBD8N34A7V00PGKYJZ`, `01KTFA36XHHPXAC4EE03SG4FHT`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/27-vm-agent-staging-refresh.md`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/34-vm-agent-callback-auth.md`
- `.claude/rules/35-vertical-slice-testing.md`
