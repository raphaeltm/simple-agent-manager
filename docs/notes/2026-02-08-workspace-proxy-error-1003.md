# Workspace Access Incident: Cloudflare Error 1003 ("Direct IP access not allowed")

Date: 2026-02-08

## Summary

Workspace subdomain access (`https://ws-{id}.${BASE_DOMAIN}`) was failing with Cloudflare **Error 1003** while attempting to proxy traffic from a Cloudflare Worker to a VM agent running on `:8080`.

The critical root cause was a Cloudflare Workers platform limitation: **Workers cannot `fetch()` a raw IP address** (for example `http://91.99.197.199:8080/health`). Those subrequests return **Error 1003** regardless of header tweaks.

The fix was to proxy Worker subrequests via a **DNS-only (grey-clouded) A record** (`vm-{id}.${BASE_DOMAIN}`) that resolves directly to the VM IP, and to have the Worker fetch `http://vm-{id}.${BASE_DOMAIN}:8080/...` instead of `http://{ip}:8080/...`.

## Symptoms

- Client requests to a workspace subdomain returned HTTP 403 with a Cloudflare error page:
  - `error code: 1003`
  - `"Direct IP access not allowed"`
- The VM agent was reachable directly by IP from outside Cloudflare:
  - `curl http://{vmIp}:8080/health` returned JSON health data
- The Worker itself was running (proved by hitting a non-existent workspace and seeing the Worker's JSON error response), but once the code path hit the subrequest to `http://{vmIp}:8080/...`, the response was the Cloudflare 1003 page.

## Timeline And Commits

These are the commits involved, in order, with their intent:

| Commit | Message | Purpose |
| --- | --- | --- |
| `81f1dfc` | `fix: add Worker proxy for workspace subdomains and fix WebSocket path` | Introduced the workspace subdomain proxy and WebSocket path handling. |
| `a21aa4f` | `fix: uppercase workspace ID extracted from DNS hostname` | Fixed ULID case mismatch (DNS is lowercased; workspace IDs are uppercase). |
| `6c74da3` | `fix: add DNS record cleanup by name for stale workspace records` | Hardened DNS cleanup if record IDs are lost. |
| `3779943` | `fix: override Host header in workspace proxy to prevent Cloudflare Error 1003` | Attempted to fix by setting `Host` for subrequest to `{vmIp}:8080`. |
| `d31924a` | `fix: build clean proxy headers to avoid CF Error 1003 on subrequests` | Attempted to fix by stripping CF headers on subrequests. |
| `e9a2201` | `fix: use DNS hostname instead of raw IP for Worker proxy subrequests` | Final fix: DNS-only backend hostname (`vm-{id}`) and Worker fetch via hostname. |

Only `e9a2201` addressed the actual root cause. The earlier header-based fixes were reasonable hypotheses but could not work against a hard platform restriction.

## Root Cause

### What We Were Doing

1. User accesses `https://ws-{id}.${BASE_DOMAIN}/...`
2. Cloudflare routes the request to the API Worker (wildcard Worker route).
3. Worker looks up `workspaces.vm_ip` in D1.
4. Worker attempts to proxy by fetching the VM agent directly:

```txt
fetch("http://{vmIp}:8080/health")
```

### Why It Fails

Cloudflare Workers **cannot fetch raw IP addresses**. The Workers runtime returns a Cloudflare edge response that surfaces as **Error 1003**.

Because the failure is at the platform routing layer, tweaking request headers (overriding `Host`, stripping CF headers) does not change the outcome.

## Fix

### Design

- Keep user-facing workspace access as:
  - `https://ws-{id}.${BASE_DOMAIN}` (proxied through Cloudflare, Worker receives the request)
- Add an internal, Worker-only backend hostname per workspace:
  - `vm-{id}.${BASE_DOMAIN}` as a **DNS-only A record** (`proxied: false`) pointing to the VM's public IP
- Change the Worker proxy subrequest target from IP to hostname:
  - from `http://{vmIp}:8080/...`
  - to `http://vm-{id}.${BASE_DOMAIN}:8080/...`

The key property is that `vm-{id}` is **DNS-only** (grey cloud). This ensures the subrequest goes directly to the VM IP and does not re-enter Cloudflare's proxy, Worker routing, or any "direct IP access" restrictions.

### Implementation Details

Files changed in `e9a2201`:

- `apps/api/src/index.ts`
  - Workspace subdomain proxy now computes:
    - `backendHostname = vm-{workspaceId}.${baseDomain}`
  - Proxies to:
    - `http://{backendHostname}:8080{path}`
- `apps/api/src/services/dns.ts`
  - Added:
    - `createBackendDNSRecord(workspaceId, ip, env)` to create `vm-{id}` with `proxied: false`
    - `getBackendHostname(workspaceId, baseDomain)` helper
  - Updated:
    - `cleanupWorkspaceDNSRecords()` to delete both `ws-{id}` and `vm-{id}` records by name
- `apps/api/src/routes/workspaces.ts`
  - During provisioning (after Hetzner server creation), creates the backend DNS record:
    - `vm-{workspaceId}.${BASE_DOMAIN} -> {vmIp}` (DNS-only)
  - Stores the Cloudflare record ID in `workspaces.dns_record_id` for cleanup.

## Verification

After `e9a2201` deployed and a new workspace was created:

1. Backend record exists and resolves directly to the VM IP (not Cloudflare edge IPs):

```bash
dig +short vm-{id}.${BASE_DOMAIN} A
```

2. VM agent health works via the proxied workspace hostname:

```bash
curl -s https://ws-{id}.${BASE_DOMAIN}/health
```

3. WebSocket terminal traffic works through the Worker proxy (browser confirms Connected and output streaming).

If a workspace was created before this fix deployed, it may not have a `vm-{id}` backend record. Create a new workspace (or backfill the record) to validate.

## Operational Notes

- Port `8080` must be reachable from Cloudflare Workers for the VM's public IP.
- The `vm-{id}` records increase DNS record count in the zone. Cleanup is handled on stop/delete:
  - `workspaces.dns_record_id` deletion by ID when available
  - `cleanupWorkspaceDNSRecords()` deletion by name as a fallback
- TTL is configurable via `DNS_TTL_SECONDS` (default: 60 seconds) in `apps/api/src/services/dns.ts`.

## What To Do If This Reappears

Check these in order:

1. Workspace is `running` and has `vm_ip` in D1.
2. `dig vm-{id}.${BASE_DOMAIN} A` returns the VM's public IP.
3. Confirm the backend record is DNS-only (grey cloud) in Cloudflare.
4. Confirm `https://ws-{id}.${BASE_DOMAIN}/health` reaches the VM agent.

