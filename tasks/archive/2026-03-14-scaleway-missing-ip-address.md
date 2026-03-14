# Scaleway Nodes: Missing IP Address Breaks Workspace Operations

**Created**: 2026-03-14
**Status**: Backlog
**Priority**: Critical
**Estimated Effort**: Medium

## Problem

Scaleway nodes provision successfully and heartbeats work, but workspaces cannot be created on them. The root cause: the node's IP address is stored as an empty string (`""`), so the API cannot construct a URL to communicate with the VM agent for workspace operations. DNS records are created pointing to an empty IP. Logs, system info, and WebSocket connections all fail.

Verified on staging: node `01KKNVJR3N5AXRYT984NZ6ERPC` was Running + Healthy with heartbeats every 30s, but `ipAddress: ""` in the API response. Workspace `01KKNVQZ3A296B48Z38NJG9KN0` was stuck in "Creating" with `vmIp: null`.

## Research Findings

### Root Cause: Scaleway 3-Step Creation Returns IP Before It Exists

| Component | File | Finding |
|-----------|------|---------|
| Scaleway createVM | `packages/providers/src/scaleway.ts:103-154` | Creates server in stopped state (Step 1), sets user_data (Step 2), powers on (Step 3), but returns `mapServerToVMInstance(createData.server)` using the response from Step 1 — before the server has a public IP |
| mapServerToVMInstance | `packages/providers/src/scaleway.ts:301-315` | Falls back to empty string `''` when `public_ip` is null and `public_ips` is empty — which is the case at creation time |
| provisionNode | `apps/api/src/services/nodes.ts:137-156` | Stores `vm.ip` directly from createVM result, creates DNS record with empty IP, then marks node as running |
| Hetzner (comparison) | `packages/providers/src/hetzner.ts:92-141` | Uses `start_after_create: true` — server is created and started in one call, IP is in the response immediately |

### Scaleway IP Allocation Lifecycle

Scaleway allocates IPs when the server starts, not when it's created. The `dynamic_ip_required: true` parameter (`scaleway.ts:128`) requests an IP, but it's only assigned once the server is in `running` state. The 3-step creation flow returns the server state from Step 1 (stopped, no IP).

### DNS Record Created with Empty IP

`createNodeBackendDNSRecord(node.id, vm.ip, env)` at `nodes.ts:141` creates a Cloudflare DNS A record pointing to `""`. Cloudflare may accept this silently or reject it. Either way, the DNS record is useless — the VM agent cannot be reached.

### Heartbeat Doesn't Backfill IP

The heartbeat handler (`apps/api/src/routes/nodes.ts:510-580`) updates `lastHeartbeatAt`, `healthStatus`, and `metrics`, but never updates `ipAddress`. The VM agent knows its own IP (it sends the heartbeat from it), but the control plane never extracts it.

### Affected Operations

Everything that communicates with the VM agent fails:
- Workspace creation (API → VM agent `POST /workspaces`)
- Log streaming (WebSocket to VM agent)
- System info (`GET /api/nodes/:id/system-info`)
- Docker info
- Software info

Heartbeats work because the VM agent initiates the connection outbound to the control plane API.

## Implementation Checklist

### Fix 1: Poll for IP After Scaleway Poweron (Primary Fix)

- [x] In `ScalewayProvider.createVM()`, after `performAction(location, serverId, 'poweron')`, poll `GET /servers/{id}` until the server has a non-empty `public_ip.address` or `public_ips[0].address`
- [x] Add configurable timeout for IP polling (e.g., `SCALEWAY_IP_POLL_TIMEOUT_MS`, default 60s) and poll interval (e.g., 3s)
- [x] Return the updated server state with IP from the poll, not from the initial create response
- [x] Add error handling: if timeout is reached without an IP, throw a `ProviderError` with a clear message

### Fix 2: Heartbeat IP Backfill (Defense in Depth)

- [x] Modify the heartbeat handler (`apps/api/src/routes/nodes.ts:510+`) to check if `node.ipAddress` is empty/null
- [x] If empty, extract the IP from the heartbeat request (e.g., `c.req.header('CF-Connecting-IP')` or similar)
- [x] Update the node's `ipAddress` in the DB and update/create the DNS record
- [x] This ensures that even if the primary fix fails or the IP changes, the control plane self-heals

### Fix 3: Fail-Fast on Empty IP (Guard)

- [x] In `provisionNode()` (`apps/api/src/services/nodes.ts`), after `createVM()`, validate that `vm.ip` is a non-empty string before creating DNS records or marking the node as running
- [x] If IP is empty, set node status to `error` with message `"Provider returned no IP address — server may still be starting"`
- [x] Do not create DNS records with empty IP

### Tests

- [x] Unit test: `ScalewayProvider.createVM()` returns a non-empty IP after polling
- [x] Unit test: IP poll timeout throws ProviderError
- [x] Unit test: delayed IP allocation (multiple poll attempts) works correctly
- [ ] Integration test: heartbeat handler backfills IP when node has empty ipAddress
- [ ] Integration test: `provisionNode()` rejects empty IP from provider

### Documentation

- [ ] Update `tasks/backlog/2026-03-13-scaleway-provider-improvements.md` if it overlaps

## Acceptance Criteria

- [ ] Scaleway node creation stores a real IP address in the DB
- [ ] DNS record for the node points to the actual IP
- [ ] Workspace creation works on a Scaleway node (verified on staging)
- [ ] Logs, system info, and WebSocket connections work on a Scaleway node
- [ ] If Scaleway fails to allocate an IP within the timeout, the error is clear and the node is not marked as running
- [ ] Heartbeat updates IP if it was missing (self-healing)
- [ ] All existing Hetzner tests continue to pass

## References

- Scaleway Instance API: server state includes `public_ip` only after boot
- Postmortem: `docs/notes/2026-03-14-scaleway-node-creation-failure-postmortem.md`
- Provider implementation: `packages/providers/src/scaleway.ts`
- Node provisioning: `apps/api/src/services/nodes.ts`
- DNS service: `apps/api/src/services/dns.ts`
- Heartbeat handler: `apps/api/src/routes/nodes.ts:510`
