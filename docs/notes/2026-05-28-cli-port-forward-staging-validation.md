# CLI Port Forward Staging Validation Report

**Date:** 2026-05-28
**Scope:** Independent staging validation of `sam workspace forward` and `sam workspace ports` (PR #1133, commit `9541955d`)
**Environment:** Staging (`api.sammy.party` / `app.sammy.party`)
**Task ID:** `01KSP6X4RVHYYTRFMV9830HG2J`

## Executive Summary

**Overall result: FAIL** — The `sam workspace forward` command is non-functional due to an architectural mismatch between the CLI's authentication mechanism (query-param `port_token` on every request) and the Cloudflare Worker's cookie-exchange auth flow (always 302 redirects when `port_token` is present). The `sam workspace ports` command also fails with INTERNAL_ERROR.

## Dependency Chain Validation

### Step 1: CLI Builds and Runs — PASS

Go 1.24.3 installed, CLI binary compiled successfully from `packages/cli/`.

```
$ go build -o /tmp/sam ./cmd/sam
# Success, binary at /tmp/sam
```

### Step 2: CLI Authenticates with Staging API — PASS

Configured via environment variables:
- `SAM_API_URL=https://api.sammy.party`
- `SAM_SESSION_COOKIE=<BetterAuth session cookie>`

Verified: `sam status` returns authenticated user info.

### Step 3: Node Provisioned and Healthy — PASS

Created node `01KSP7A4K6E3HQTGQ86CB1A8G7` (Hetzner, IP `178.105.154.19`).
Also found pre-existing healthy node `01KSP75VF7CJSQAWHVCPCQMEJD`.
Both nodes reported healthy via API.

### Step 4: Workspace Running — PARTIAL PASS

- Workspace `01KSP75VWY0JGT6H3XNGVKWRKV` — status `running` (pre-existing)
- Workspace `01KSP7DWVXX3NNZE3J6ZK2PE0X` — status `recovery`

At least one workspace was running and accessible.

### Step 5: Port-Access Token Endpoint — PASS

```
GET /api/workspaces/{id}/port-access?port=3000
```

Returns valid RS256 JWT with correct claims (`workspace`, `port`, `subject`, `exp`). Token refresh and caching logic in Go code is sound.

### Step 6: `sam workspace ports` — FAIL

```
GET /api/workspaces/{id}/ports
→ HTTP 500: {"error":"INTERNAL_ERROR","message":"Internal server error"}
```

Consistently returns INTERNAL_ERROR for both workspaces. Root cause: Worker-to-VM-agent communication failure when querying the container's `/proc/net/tcp` port scanner. Likely the container is not fully initialized or the VM agent proxy path has issues.

**Impact:** Without working port detection, the `forward` command's auto-detect mode (`forward` with no `--port` flag) cannot work. Users must always specify `--port` manually.

### Step 7: `sam workspace forward --port 3000` — FAIL (CRITICAL)

The forward command binds the local listener and constructs the reverse proxy correctly. However, **every proxied request receives an HTTP 302 redirect instead of proxied content.**

#### Root Cause

Architecture mismatch between CLI and Cloudflare Worker port-access auth:

1. **CLI behavior** (`workspace.go:227-240`): The `ReverseProxy.Director` injects `?port_token=<jwt>` on **every** request to the remote URL.

2. **Worker behavior** (`index.ts:~190-300`): The Worker's port-access flow has two auth paths:
   - **Step 5a — Cookie check:** If a valid `sam_port_access` cookie is present, authenticate silently and proxy the request through. No redirect.
   - **Step 5b — Token check:** If `?port_token=` is present (and no valid cookie), **always** respond with HTTP 302 redirect + `Set-Cookie: sam_port_access=<token>`. The redirect strips the token from the URL.

3. **The conflict:** The CLI sends `port_token` on every request. The Worker always 302-redirects when it sees `port_token`. The CLI's `httputil.ReverseProxy` passes the 302 through to the downstream client. The redirect `Location` points to the remote server (not localhost), so following it bypasses the proxy entirely.

#### Verification

Manual testing confirmed the two auth paths work correctly in isolation:

```
# port_token in query → always 302 (sets cookie)
curl -s -o /dev/null -w "%{http_code}" "https://ws-{id}--3000.sammy.party/?port_token=<jwt>"
→ 302

# sam_port_access cookie (no port_token) → 200 (proxied through)
curl -s -o /dev/null -w "%{http_code}" -H "Cookie: sam_port_access=<jwt>" "https://ws-{id}--3000.sammy.party/"
→ 200
```

The cookie path works. The CLI never uses it.

#### Why This Wasn't Caught

- Unit tests for the CLI test the proxy setup, listener binding, and token refresh — but don't test against a real Worker that implements the cookie-exchange flow.
- The Worker's port-access auth was designed for browsers (which follow redirects and store cookies automatically), not for programmatic reverse proxies.
- No integration test exercises the full chain: CLI proxy → Worker cookie-exchange → VM agent → container.

## Suggested Fixes

**Option A (Server-side, preferred):** Add a header-based auth path to the Worker. When the request includes a header like `X-Port-Forward: cli` (or `Authorization: Bearer <port_token>`), authenticate directly without the 302 redirect/cookie-exchange flow. This keeps browser behavior unchanged.

**Option B (Client-side):** Implement a cookie-jar in the CLI's reverse proxy. On the first request, follow the 302 redirect, capture the `sam_port_access` cookie, and inject it (instead of `port_token`) on all subsequent requests. More complex and fragile.

**Option C (Hybrid):** Have the CLI make one initial request to exchange the `port_token` for a `sam_port_access` cookie value, then use that cookie on all proxied requests. Similar to Option B but with an explicit exchange step.

## Test Resources Created

| Resource | ID | Status | Action Needed |
|----------|----|--------|---------------|
| Node | `01KSP7A4K6E3HQTGQ86CB1A8G7` | healthy | Delete after validation |
| Workspace | `01KSP7DWVXX3NNZE3J6ZK2PE0X` | recovery | Delete after validation |
| Pre-existing Node | `01KSP75VF7CJSQAWHVCPCQMEJD` | healthy | Was pre-existing |
| Pre-existing Workspace | `01KSP75VWY0JGT6H3XNGVKWRKV` | running | Was pre-existing |

## Summary Table

| Step | Description | Result |
|------|-------------|--------|
| 1 | CLI builds and runs | PASS |
| 2 | CLI authenticates with staging | PASS |
| 3 | Node provisioned and healthy | PASS |
| 4 | Workspace running | PARTIAL PASS |
| 5 | Port-access token endpoint | PASS |
| 6 | `sam workspace ports` | FAIL — INTERNAL_ERROR |
| 7 | `sam workspace forward` | FAIL — 302 redirect loop (CRITICAL) |

**Verdict:** The port forwarding feature (PR #1133) is non-functional on staging. The critical bug is an architectural mismatch between the CLI's per-request `port_token` injection and the Worker's cookie-exchange auth flow. This must be fixed before the feature can be used.
