# GitLab Repository And Workspace Support

## Status

Completed and deployed to production on 2026-07-14.

## Constraints

- The earlier draft/do-not-merge/no-staging constraints were superseded by the
  user's explicit 2026-07-14 instruction to ship the stack after their live VM
  and instant-container verification.
- Run current CI and staging verification before merge, then merge #1547 into
  #1545 and #1545 into `main` in dependency order.
- Do not commit a task file directly to main. Keep task records/state on this existing feature branch because the stack is intentionally unmerged.
- Avoid force-push unless absolutely unavoidable; preserve linear stacked ancestry with normal branch merges.
- Use the platform-level GitLab OAuth configuration added in the base PR.

## Context

PR #1545 adds the runtime platform configuration foundation for GitLab OAuth:

- GitLab OAuth host/client ID/client secret can be stored in the platform settings/credentials store.
- GitLab sign-in is visible when the provider is configured.
- Environment fallbacks remain available for self-hosters.

This follow-up implements repository/workspace support around that foundation.

The linked SAM idea is `01KV7ZFD6HZS5N7J45VA798KN1`, "GitLab integration using platform-level config". The important security invariant from that idea is that GitLab OAuth tokens are broader than GitHub App installation tokens, so they must not be exported as static workspace environment variables. Git credentials should be minted through the VM credential-helper path, checked against the exact GitLab host/project path, and refreshed on demand.

## Scope

- Allow GitLab-backed projects to be created from the project onboarding flow.
- Verify the signed-in user has GitLab project access at project creation and task start.
- Let VM workspaces clone GitLab projects and push branches using the existing callback-based credential helper.
- Support GitLab project browsing through the existing provider-agnostic repo browser routes.
- Keep GitHub and Artifacts behavior unchanged.

## Implementation Plan

1. Extend shared contracts:
   - Add `gitlab` to `RepoProvider` and `VALID_REPO_PROVIDERS`.
   - Extend create-project request fields with GitLab project metadata.
   - Extend VM agent create-workspace request with optional provider metadata.

2. Add persistence:
   - Add an additive D1 migration for `project_gitlab_repositories`.
   - Store project ID, GitLab host, numeric project ID, path with namespace, web URL, HTTPS clone URL, default branch, and timestamps.
   - Mirror the Drizzle schema.

3. Add GitLab service layer:
   - Resolve host/API base URL from `getGitLabOAuthConfig`.
   - Retrieve user OAuth tokens through BetterAuth, not by reading `accounts` directly.
   - Implement project search/list, branch list, project lookup, access verification, tree/file/raw/compare helpers.

4. Add API routes:
   - Add authenticated GitLab routes for project and branch selection.
   - Extend project creation for `repoProvider: "gitlab"`.
   - Extend task-start access guards to re-verify GitLab repository access.
   - Extend workspace `git-token` to mint GitLab credentials only for the bound project metadata.

5. Add workspace runtime support:
   - Thread GitLab provider metadata through task runner config, workspace creation, and node-agent request payloads.
   - Extend VM repo URL normalization so GitLab clone URLs are preserved.
   - Extend VM credential helper host/path checks and configure `credential.useHttpPath` for GitLab.
   - Keep `GH_TOKEN` injection and `gh` wrapper behavior GitHub-only.

6. Add UI support:
   - Add GitLab as a project onboarding provider.
   - Add a GitLab project selector backed by the new API routes.
   - Preserve current GitHub and Artifacts flows.

7. Validate:
   - Add focused API tests around GitLab project creation/access and git-token behavior.
   - Add Go tests for VM credential-helper and create-workspace contract.
   - Run local typecheck/test/build checks.
   - Run local specialist review skills relevant to API/env/security/Go/UI.
   - Deploy the final stack to staging and verify both VM and instant-container
     GitLab push flows before production merge.

## Acceptance Criteria

- GitLab provider can be selected during project creation when platform GitLab OAuth is configured.
- A GitLab project stores durable repository metadata and is returned as `repoProvider: "gitlab"`.
- Task starts against GitLab projects re-check current GitLab access.
- Workspaces for GitLab projects receive enough metadata to clone with HTTPS and authenticate through the credential helper.
- The VM agent does not persist or export static GitLab OAuth tokens.
- GitLab repo browsing supports branch/tree/file/raw/compare paths through the existing project repo routes.
- The stacked PRs pass current CI and staging verification, then merge in
  dependency order and deploy successfully to production.

## Validation Notes

- Local API/web/shared typechecks pass.
- Focused API tests pass for GitLab metadata normalization and GitLab/GitHub repo browsing.
- Focused web unit tests pass for GitLab onboarding state and payload propagation.
- Focused VM Go tests pass for bootstrap credential helper behavior, persistence, workspace metadata, git credential host/path checks, and GitLab MR creation.
- Project onboarding Playwright audit passes on iPhone SE and desktop viewports.
- Full `packages/vm-agent/internal/server` Go package test passes after installing Docker locally and running `dockerd` on `/tmp/sam-docker.sock`.
- Historical note: staging validation was initially skipped under the earlier
  draft-only constraint; that constraint was superseded on 2026-07-14 and a
  current-commit staging pass is required before merge.
- Refreshed onto foundation SHA `570f4a5090fe05e5b382b585cd2ea8be5ec0d2be` with merge commit `e06e820b2`.
- Renumbered the GitLab sidecar migration from stale slot `0088` to additive slot `0091`.
- Added route-level tests for GitLab workspace token exchange, exact identity drift rejection, and task/project access re-verification.
- Full repository typecheck passed. The exhaustive test run passed 402/403 API files and 5,905/5,906 API tests before exposing one stale provider-count assertion; the repaired provider contract and all focused GitLab boundary tests pass.
- Full repository build passed.
- Full VM-agent `go test -race ./...`, touched-package coverage, and `go vet ./...` passed on Go 1.25.0.
- Local mocked Playwright audit passed 10/10 across iPhone SE (375x667) and desktop (1280x800).

## Review Notes

- GitLab OAuth tokens are only returned through the workspace callback `git-token` flow and are not persisted/exported as static workspace env vars.
- VM credential responses are constrained by host and GitLab repository path, with `credential.useHttpPath=true` configured.
- GitLab repository metadata now stores the bare host required by Git/VM paths while continuing to use the platform config origin for OAuth/API calls.
- Known WIP deferrals: GitLab-specific member/invite repository access routes and GitLab webhook/task trigger support are not included in this stacked PR.

## Phase 5 Specialist Review (2026-07-11 continuation)

All 8 required local reviewers were re-run successfully (prior session could not launch them due to a `bwrap` sandbox failure). In-scope findings fixed in this continuation:

- **task-completion-validator / test-engineer (CRITICAL/HIGH):** `POST /api/projects` GitLab branch had no direct route-level behavioral test. Added `apps/api/tests/unit/routes/project-gitlab-creation.test.ts` (9 scenarios: happy path + sidecar persistence, missing id 400, no-token 401, insufficient-access 403, not-found 404, non-default branch exists/absent, duplicate 409, sidecar-insert rollback).
- **constitution-validator / cloudflare-specialist (HIGH/MED, Principle XI):** `gitlabFetch` had no timeout. Added `GITLAB_API_TIMEOUT_MS` env (default `DEFAULT_GITLAB_API_TIMEOUT_MS=30_000`) via shared `fetchWithTimeout`; documented in `env.ts` and `.env.example`.
- **security-auditor / go-specialist (HIGH):** `isAllowedCredentialPathForWorkspace` failed open (`return true`) for unregistered workspaces. Now falls back to `s.config` RepoProvider/RepositoryPath, mirroring `isAllowedCredentialHostForWorkspace` (preserves standalone mode, does not fail open). Added `TestIsAllowedCredentialPathForWorkspaceFallsBackToConfig`.
- **test-engineer (H1):** Added `verifyGitLabProjectAccess` error-branch tests (<Developer → 403, 404 → not-found, group-access inheritance).
- **ui-ux-specialist (H2):** Playwright audit `/api/gitlab/branches` mock returned an object wrapper; real route returns a bare array. Fixed the mock so screenshot evidence reflects real branch population.
- **doc-sync-validator (HIGH/MED):** Removed stale "future" qualifier from `security.md` GitLab row; documented required `read_user`+`api` GitLab OAuth scopes in `self-hosting.mdx`.

Verified-correct (no fix needed): the VM-agent create-workspace cross-boundary field mapping is consistent camelCase across `node-agent.ts` → Go `createWorkspaceRequest` json tags → shared `CreateWorkspaceAgentRequestSchema` (no snake/camel mismatch).

Deferred to explicit later stack layers (documented, not blocking this draft):

- MR-layer hardening (go-specialist HIGH): `RepositoryHost` URL validation + a dedicated external HTTP client for GitLab MR API calls. `RepositoryHost` is trusted platform config (not user input) and comprehensive MR/change-request handling is the later MR/control-plane layer.
- Hardcoded GitLab OAuth scopes (constitution/security MED): kept at parity with the existing hardcoded GitHub scopes; scope narrowing can follow.
- GitLabProjectSelector keyboard/ARIA combobox + no-results/provider-reset polish (ui H1/M2): later discovery/UX layer; matches existing BranchSelector/RepoSelector pattern.
- Per-request config/D1 lookup de-duplication in the GitLab path (cloudflare MED): later optimization.
- Per-user OAuth refresh serialization; stale-host/account token lifecycle: later security layer.

## 2026-07-12 Hardening Session (staging-readiness)

- **CLOSED (was deferred above): fail-closed VM credential exchange for GitLab.** `handleGitCredential` now has two gates:
  - Request-side: a workspace whose local binding (`credentialPathBinding`) is `gitlab` must supply BOTH non-empty `host` and `path` query params or the exchange returns 204 without contacting the control plane.
  - Response-side: any control-plane response with `provider=gitlab` is withheld (204) unless the caller supplied host+path AND the resolved `repositoryPath` is non-empty, in addition to the existing exact host/path match checks. This also closes the "empty registered path passes" gap.
  - GitHub/Artifacts keep the empty-allow behavior (the gh wrapper sends `host=github.com` with no path; GitHub tokens are repo-scoped installation tokens, unlike GitLab's broad user OAuth token).
  - Tests: `TestHandleGitCredentialGitLabFailClosedWithoutHostOrPath`, `TestHandleGitCredentialGitLabResponseFailClosed`.
- **Architecture note correction:** host/path from the credential helper are NOT forwarded to the control plane. The vm-agent sends an empty `{}` body with the callback token to `POST /api/workspaces/:id/git-token`; all host/path filtering is vm-agent-local against the workspace's registered binding and the control-plane-resolved `repositoryPath`.

## 2026-07-14 Production Readiness Continuation

- The user personally confirmed that GitLab branch pushes work from both a
  staging VM workspace and a staging instant container, then authorized the
  stacked PRs for production shipping.
- Pre-merge review found that the normal TaskRunner VM path and instant-session
  path forwarded GitLab clone metadata, but manual `POST /api/workspaces`
  dispatch and node-ready replay did not.
- Added one shared workspace Git source resolver and routed TaskRunner,
  instant-session, manual workspace creation, and deferred node-ready replay
  through it.
- Added vertical-slice regression tests that exercise the real manual and
  node-ready callers, assert the final VM-agent request, and verify missing
  GitLab sidecar metadata fails closed before the VM-agent call.
- Tightened the same-user standalone helper from mode `0755` to `0700`.
  The container image owns the helper as `node:node`, and both the vm-agent
  and agent process run as `node`, so broader execute permission is not
  required.
- Made the credential-helper callback timeout configurable through
  `GIT_CREDENTIAL_TIMEOUT` (default `5s`) for both VM/devcontainer and
  standalone-container helpers. Focused config/render tests cover the default,
  a fractional `1750ms` override, validation, and owner-only helper install;
  the full touched Go package suites, race-enabled tests, and `go vet ./...`
  pass (excluding only the pre-existing Docker-dependent server test in this
  Docker-less runner).

### Post-Mortem: Omitted GitLab Metadata in Secondary Dispatch Paths

- **Root cause:** GitLab metadata resolution was duplicated inside the two
  initially targeted runtime paths. Two older workspace dispatch callers
  continued constructing partial VM-agent requests.
- **Why tests missed it:** coverage proved the TaskRunner and instant-session
  payloads but did not enumerate all callers of `createWorkspaceOnNode`,
  especially the deferred node-ready replay lifecycle.
- **Class fix:** centralize provider/clone/host/path resolution in
  `workspace-git-source.ts` and make every project-backed dispatch caller use
  it.
- **Process fix:** the cross-boundary contract rule now requires shared request
  metadata resolution or per-caller behavioral coverage, including deferred
  paths and a missing-metadata fail-closed scenario.

## Exact-Commit Staging Evidence (2026-07-14)

- GitHub Actions staging deployment run
  `29319573920` completed successfully for exact runtime commit
  `8231b8fd1f24235438d8109168feb7c3f1652dc7`. The Cloudflare deploy,
  additive D1 migration/integrity checks, UI deploy, VM-agent binary upload,
  health check, and final Playwright smoke job all passed.
- Authenticated live Chromium checks passed for API health, dashboard rendering,
  project navigation, and Settings. The fresh workspace page showed the bound
  GitLab repository on `master`, zero git changes, and no console errors before
  the terminal verification.
- Manual `POST /api/workspaces` created workspace
  `01KXFY05EBZ3HBH4DH7JFV2AB9` without a selected node, provisioning fresh
  Hetzner VM `01KXFY0504EJWKRKYZY6A8PXQ6`. This exercised both the patched
  manual creation caller and node-ready replay. The VM became healthy and the
  workspace reached `running` after the node-ready path cloned
  `https://gitlab.com/serverspresentation2025-group/serverspresentation2025-project.git`.
- VM debug evidence showed the shared dispatch produced a GitLab clone, wrote
  and bind-mounted `/usr/local/bin/git-credential-sam`, configured the helper,
  and marked the workspace ready. In the live devcontainer,
  `credential.helper=/usr/local/bin/git-credential-sam` and
  `credential.useHttpPath=true`.
- A real temporary GitLab branch
  `sam-staging-verify-8231b8fd1-terminal` was created from `master`, committed
  at `0671c4b73bd6d1a668d47cbadc094c42749255ba`, and pushed successfully.
  `git ls-remote` returned that exact SHA and branch. The remote branch was then
  deleted successfully; a second `git ls-remote` returned no matching ref. The
  local branch was deleted and final status was clean on
  `master...origin/master`.
- The validation workspace and its fresh VM were deleted after the remote and
  local branch cleanup.
- Independent Staging Validator task `01KXFXY1XQEX1ANA3VFEMKRF9W` completed a
  second authenticated browser journey. It passed API health, dashboard,
  project, and Settings checks with zero console errors; confirmed the GitLab
  project metadata; provisioned fresh workspace
  `01KXFYQ4EWY9CKFQBPG17430JY` on Hetzner node
  `01KXFYQ40N1RW5APSHF9WF15HT`; observed the node become healthy and the
  workspace reach `running`; and deleted both resources with HTTP 200 followed
  by D1 absence checks.
- The independent validator also captured accepted GitLab push output from the
  completed staging task `01KXFPMSZ704ZP3SG3Z7FN7B0X`. It did not perform the
  requested temporary push/delete cycle from its own freshly created
  workspace, so the exact-current-commit terminal push/delete evidence remains
  the direct validation above rather than an independent duplicate. This is not
  a release blocker because the direct journey exercised the patched manual and
  node-ready paths end to end, while the user separately confirmed pushes from
  both VM and instant-container workspaces.
- The validator could not select an instant workspace for this project because
  its `default_workspace_profile` is null; the independent instant check was
  therefore not applicable to that journey. The user's prior live
  instant-container confirmation is the non-regression evidence for that path.
- `pnpm quality:observability-noise` reported no significant log noise. Its D1
  check was skipped because `OBSERVABILITY_DB_ID` was unavailable and telemetry
  was skipped after a 403, so this is partial observability evidence rather than
  a complete gate.
- One unrelated fresh-node cloud-init warning (`set: Illegal option -o
  pipefail` under `/bin/sh`) did not prevent vm-agent provisioning. It is
  tracked separately as SAM backlog idea `01KXFZPG6M70PJF72CKFZVK99B` and is
  outside this release.

## Task Completion Validation (Pre-Merge, 2026-07-14)

Verdict: **CONDITIONAL PASS**. Checks A through F pass for the implemented
feature:

- Every scope/research finding maps to an implementation-plan item or an
  explicit deferral.
- The shared contracts, D1 sidecar, GitLab service/API/browsing paths, UI
  selector and payload, task-start access guard, workspace token exchange, and
  VM credential-helper behavior all have substantive diff coverage.
- Unit, route, vertical-slice, Go, Playwright, exact-commit staging, and live
  push/delete evidence cover the first six acceptance criteria.
- The onboarding selector propagates `gitlabProjectId` through the shared
  request contract to the project-creation handler and sidecar insert.
- Provider/resource selection is discriminated by `repoProvider`, GitLab
  project ID, user, and host; no new ambiguous first-row selection was found.
- The manual-workspace and deferred node-ready tests exercise real entry-point
  callers through the final VM-agent payload and include realistic GitLab
  sidecar state plus fail-closed missing-metadata coverage.

The task remains active because acceptance criterion seven necessarily cannot
be complete until the stack is merged in dependency order and the production
deployment is healthy. Run the final completion validation and archive only
after that release lifecycle finishes.

## Task Completion Validation (Final, 2026-07-14)

Verdict: **PASS**. Checks A through F pass, and the release-lifecycle condition
from the pre-merge audit is now satisfied:

- PR #1547 merged into foundation PR #1545, and #1545 merged to `main` in
  dependency order as `a2b4a013283bb8f1c8b62314ae9adebcbd7b717c`.
- Refreshed combined-head CI, E2E smoke, exact-head staging deployment, D1
  integrity checks, and staging smoke tests passed before merge.
- Post-merge `main` CI run `29324677845` passed the full coverage suite,
  VM-agent test/integration/E2E suites, and devcontainer volume-mount test.
- Production run `29325059770` deployed
  `33db8ec1c63e1406c2535b64a2802c6f918505a7`, one docs-only commit ahead of
  the feature merge. Infrastructure, Worker/UI deployment, backup, migrations,
  row-count integrity, VM-agent/CLI publication, and workflow health all
  passed.
- Read-only live checks returned HTTP 200 with `status=healthy` from
  `https://api.simple-agent-manager.org/health` and HTTP 200 HTML from
  `https://app.simple-agent-manager.org`.
- The user independently confirmed successful GitLab pushes from both VM and
  instant-container workspaces. The direct exact-commit staging cycle also
  verified a temporary branch at
  `0671c4b73bd6d1a668d47cbadc094c42749255ba`, its exact remote SHA, remote
  deletion, and clean local teardown.

All acceptance criteria are complete. The task is ready for archival.
