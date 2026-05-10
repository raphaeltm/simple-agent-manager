# Git Credential Refresh Workaround for Long-Running Agent Sessions

**Date:** 2026-05-10
**Context:** Discovered during harness orchestration eval session that ran ~4 hours

## Problem

Agents in SAM workspaces lose git push access when the initial `GH_TOKEN` (GitHub installation token) expires. The token has a ~1 hour TTL and is baked into the git remote URL at workspace creation time. Long-running sessions outlive the token.

The credential helper (`git-credential-sam` at `/usr/local/bin/git-credential-sam`) tries to fetch a fresh token from the VM agent at `https://<gateway>:8443/git-credential`, but this fails with 401 — the VM agent's `isValidCallbackAuth` rejects the request even though the callback JWT hasn't expired.

## Workaround

Call the **control plane directly** to get a fresh GitHub installation token:

```bash
# 1. Extract the callback JWT from the credential helper script
CALLBACK_JWT=$(grep -oP '(?<=Bearer )[^"]+' /usr/local/bin/git-credential-sam)

# 2. Request a fresh git token from the control plane
FRESH_TOKEN=$(curl -sS --max-time 10 -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CALLBACK_JWT" \
  -d '{}' \
  "https://api.simple-agent-manager.org/api/workspaces/$SAM_WORKSPACE_ID/git-token" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# 3. Update the git remote URL
git remote set-url origin "https://x-access-token:${FRESH_TOKEN}@github.com/<owner>/<repo>.git"

# 4. Push
git push origin <branch>
```

### Why the VM agent path fails

The credential helper calls `https://<docker-gateway>:8443/git-credential?workspaceId=<id>` with the callback JWT as a Bearer token. The VM agent's `isValidCallbackAuth()` (`packages/vm-agent/internal/server/git_credential.go:138`) does a constant-time byte comparison of the presented token against `s.config.CallbackToken`. If the VM agent's stored token differs from what's in the credential helper script (e.g., due to token rotation or agent restart), the comparison fails.

The control plane's `/api/workspaces/:id/git-token` endpoint performs JWT verification (signature + expiry), which succeeds as long as the JWT hasn't expired.

## Root Cause Investigation Needed

1. **Why does the VM agent reject the credential helper's JWT?** The JWT is valid (not expired), but the VM agent does literal byte comparison, not JWT verification. If `s.config.CallbackToken` was set from a different token (e.g., after VM agent restart), the comparison fails.

2. **Why is the token hardcoded in the remote URL?** The git credential helper should be the primary mechanism. Hardcoding the token in the URL means the credential helper is never consulted until the URL token is removed.

## Proposed Fix

See SAM idea: "MCP tool for agent git credential refresh"

- Add an MCP tool `refresh_git_credentials` that agents can call when git push fails
- Fix `git-credential-sam` so it reliably works (either fix VM agent auth or call control plane directly)
- Remove hardcoded token from remote URL at workspace creation so the credential helper is always used
