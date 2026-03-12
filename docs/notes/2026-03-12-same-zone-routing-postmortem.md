# Post-Mortem: Cloudflare Same-Zone Routing Breaks All Worker→VM Communication

**Date**: 2026-03-12
**Severity**: P0 — All task execution broken in production
**Duration**: Until fix deployed
**Root cause**: Worker subrequests to `vm-{nodeId}.domain` matched the wildcard route `*.domain/*`, causing Cloudflare same-zone routing to loop requests back to the Worker instead of forwarding to the VM

## What Broke

Task submission via project chat fails completely. Two distinct failure modes were discovered:

1. **Health check failure**: Task stuck at "node_agent_ready" — health check poll to `vm-{nodeId}.domain:8443/health` looped back to the Worker for 10 minutes, then timed out.
2. **Workspace creation failure**: After fixing health checks with D1, task stuck at "workspace_creation" — `createWorkspaceOnNode()` fetch to `vm-{nodeId}.domain` also looped back to the Worker. The workspace was created in D1 but the VM never received the creation command.

All 15 `nodeAgentRequest` functions (workspace CRUD, agent sessions, logs, system-info) were affected.

## Root Cause

Cloudflare **same-zone subrequest routing**: when a Worker makes a `fetch()` to a hostname that matches one of its own routes within the same zone, Cloudflare intercepts the request and routes it back to the Worker instead of the origin.

The deploy script generates a wildcard Worker route `*.domain/*` which matches ALL single-level subdomains, including `vm-{nodeId}.domain`. Any Worker-initiated subrequest (from DO alarms, cron, or internal fetch) to these hostnames gets routed back to the API Worker.

**Critical distinction**: Same-zone routing only affects Worker-INITIATED subrequests. Subrequests made while handling external requests (e.g., workspace proxy from browser → `ws-{id}.domain`) are NOT intercepted. This is why terminals and the web UI worked while task execution (driven by DO alarms) did not.

**Why we can't use explicit routes**: Cloudflare route patterns only support wildcards at the BEGINNING of the hostname (e.g., `*.domain/*`). Patterns like `ws-*.domain/*` are rejected with error 10022.

## Timeline

1. **Unknown date**: Wildcard route `*.domain/*` deployed
2. **2026-03-12**: User submits task → VM provisions → health check times out (10 min)
3. **2026-03-12**: First fix: D1-based health check bypasses same-zone routing for health checks
4. **2026-03-12**: Task gets past health check but stuck at workspace creation — same root cause
5. **2026-03-12**: Root fix: Two-level VM subdomains bypass same-zone routing for ALL communication

## Why It Wasn't Caught

1. **Browser requests worked fine** — Same-zone routing only affects Worker subrequests, not external browser requests
2. **Miniflare doesn't simulate same-zone routing** — All tests passed
3. **No end-to-end task execution test** — Staging verification didn't exercise the full DO alarm → VM communication pipeline

## Fix: Two-Level VM Subdomains + Route Exclusion

Changed VM backend hostnames from single-level to two-level subdomains AND added a Cloudflare route exclusion:

- **Before**: `vm-{nodeId}.domain` (single subdomain → matches `*.domain/*`)
- **After**: `{nodeId}.vm.domain` (two-level subdomain → matches `*.vm.domain/*` exclusion)

### Why Two-Level Subdomains Alone Didn't Work

**CRITICAL CORRECTION**: Cloudflare Worker route wildcards are **greedy** — `*` matches one or more characters INCLUDING dots. This means `*.domain/*` matches `a.b.domain/path` (multi-level). The initial assumption that CF wildcards match exactly one subdomain level (like DNS wildcards) was wrong.

The actual fix requires both:
1. **Two-level subdomains** (`{nodeId}.vm.{domain}`) — provides a distinct hostname pattern
2. **Route exclusion** (`*.vm.{domain}/*` with no script) — explicitly excludes VM hostnames from Worker routing

Cloudflare evaluates `*.vm.domain/*` as more specific than `*.domain/*`, so the exclusion takes precedence. With no `scriptName`, requests pass straight to origin (the VM via proxied DNS) — including Worker/DO subrequests.

### Changes Made

| File | Change |
|------|--------|
| `apps/api/src/services/node-agent.ts` | `getNodeBackendBaseUrl()`: `vm-{id}.{domain}` → `{id}.vm.{domain}` |
| `apps/api/src/services/dns.ts` | `createNodeBackendDNSRecord()`: DNS name `vm-{id}` → `{id}.vm` |
| `apps/api/src/services/dns.ts` | `getNodeBackendHostname()`: hostname construction updated |
| `apps/api/src/services/dns.ts` | `cleanupWorkspaceDNSRecords()`: handles both old and new formats |
| `apps/api/src/index.ts` | Workspace proxy backend hostname updated |
| `apps/api/src/routes/nodes.ts` | Log stream URL and node token response URL updated |
| `infra/resources/origin-ca.ts` | Added `*.vm.{domain}` SAN to Origin CA cert |
| `infra/resources/dns.ts` | Added `*.vm.{domain}/*` route exclusion (Pulumi `WorkerRoute`, no script) |

### SSL/TLS Impact

The VM records are orange-clouded (proxied). Universal SSL covers `*.domain` but NOT `*.vm.domain`. However:
- Worker subrequests to proxied hostnames stay within CF's infrastructure — edge cert validation doesn't apply
- Browsers never access VM hostnames directly (they use `ws-{id}.domain` and `api.domain`)
- The Origin CA cert was updated with `*.vm.{domain}` SAN for the CF edge → VM hop

### D1 Health Checks (Defense-in-Depth)

The D1-based health check from the first fix remains as defense-in-depth. Even though two-level subdomains fix same-zone routing, D1 health checks are more reliable (no network round-trip to VM, no DNS dependency).

## Class of Bug

**Platform routing interaction**: Infrastructure behavior (CF same-zone routing) that is invisible in local dev, invisible in most tests, and only manifests when a Worker makes subrequests to hostnames within its own zone that match its route patterns.

**Key insight**: CF Worker route wildcards are GREEDY (unlike DNS wildcards). `*.domain/*` matches multi-level subdomains. The fix requires BOTH a distinct hostname pattern (two-level subdomains) AND a route exclusion (`*.vm.domain/*` with no script) to prevent Worker interception. The exclusion route takes precedence via CF's "most specific match" rule.

## Migration

- **New VMs**: Get `{nodeId}.vm.{domain}` DNS records immediately
- **Old VMs**: Keep existing `vm-{nodeId}.{domain}` records until destroyed (warm pool timeout or manual cleanup)
- DNS cleanup function handles both formats during transition
- No manual migration needed — old VMs die naturally
