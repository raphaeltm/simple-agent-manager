# Feature Specification: Git Credential Refresh for Devcontainer Push Access

**Feature Branch**: `008-git-credential-refresh`
**Created**: 2026-02-07
**Status**: Implemented
**Input**: Investigation into GitHub App setup revealed that users cannot `git push` from inside devcontainers.

## Problem Statement

Users working inside devcontainer-based workspaces cannot push commits back to their repository. Three issues prevent this:

### Issue 1: GitHub App Permission Too Restrictive

The GitHub App is currently documented and configured with **Contents: Read-only** permission. Pushing requires **Contents: Read and write**.

**Fix**: Change the GitHub App repository permission from `Contents: Read-only` to `Contents: Read and write`.

### Issue 2: Installation Token Expires After 1 Hour

GitHub App installation tokens are hard-capped by GitHub at **1-hour expiry**. A typical coding session lasts 2-8 hours. After the first hour, any `git push` (or `git pull` of private repos) will fail with an auth error.

The current flow:
1. Workspace creation (`workspaces.ts:622`) calls `getInstallationToken()` — gets a 1-hour token
2. Token is encrypted and stored in bootstrap data in KV
3. VM agent redeems bootstrap token on startup via `POST /api/bootstrap/:token`
4. Token is used for `git clone`
5. **After 1 hour, token is dead — no refresh mechanism exists**

### Issue 3: Git Credential Wiring Is Incomplete

The bootstrap → devcontainer credential path is not fully implemented:

- `packages/vm-agent/internal/config/config.go` reads `CALLBACK_TOKEN` but **does not read `BOOTSTRAP_TOKEN`**
- No Go code redeems the bootstrap token, clones the repo, or configures git credentials
- The cloud-init template (`packages/cloud-init/src/template.ts`) starts the vm-agent but **does not clone the repo**
- The reference `scripts/vm/cloud-init.yaml` has an old `git clone ${REPO_URL}` approach that is not used by the real template
- No git credential helper is configured inside the devcontainer

## Proposed Solution (High-Level)

### Git Credential Helper Architecture

Instead of embedding a static token, use a **git credential helper** inside the devcontainer that requests fresh tokens on demand:

```
git push
  → git credential helper (inside devcontainer)
    → calls vm-agent HTTP endpoint (on host)
      → vm-agent calls control plane API
        → API calls GitHub `POST /app/installations/{id}/access_tokens`
          → returns fresh 1-hour installation token
```

### Required Changes

1. **GitHub App permission**: `Contents: Read and write` (docs + setup guide)

2. **API: New endpoint** — `POST /api/workspaces/:id/git-token`
   - Authenticated (workspace callback token)
   - Generates a fresh GitHub installation token for the workspace's installation
   - Returns token + expiry

3. **VM Agent: Bootstrap redemption** — implement the missing Go code to:
   - Redeem `BOOTSTRAP_TOKEN` via `POST /api/bootstrap/:token` on startup
   - Receive `githubToken`, `callbackToken`, `hetznerToken`, and optional `gitUserName`/`gitUserEmail`
   - Store `callbackToken` for subsequent API calls
   - Use `githubToken` for initial `git clone`

4. **VM Agent: Token refresh endpoint** — `GET /git-credential`
   - Called by the git credential helper inside the devcontainer
   - VM agent uses its `callbackToken` to call the API's git-token endpoint
   - Returns fresh credentials in git-credential-helper format

5. **Devcontainer: Git credential helper setup**
   - Install a small script as `git-credential-sam` inside the devcontainer
   - Configure via `git config --global credential.helper '/path/to/git-credential-sam'`
   - Script calls `http://host.docker.internal:8080/git-credential` (or equivalent)
   - Returns credentials in standard git credential helper protocol format:
     ```
     protocol=https
     host=github.com
     username=x-access-token
     password=<fresh-installation-token>
     ```

6. **Cloud-init template**: Add repo clone step using the bootstrap-provided token

## Key Constraints

- Installation tokens cannot exceed 1-hour expiry (GitHub limit)
- The credential helper must work transparently — `git push` should Just Work
- The vm-agent must be reachable from inside the devcontainer (host networking or `host.docker.internal`)
- Token refresh requires the workspace's `installationId` — stored in the workspace DB record

## References

- Current bootstrap flow: `apps/api/src/routes/bootstrap.ts`
- Installation token generation: `apps/api/src/services/github-app.ts:24-53`
- Cloud-init template: `packages/cloud-init/src/template.ts`
- VM Agent config: `packages/vm-agent/internal/config/config.go`
- GitHub App installation tokens docs: https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
