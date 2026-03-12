# Post-Mortem: Cloudflare Same-Zone Routing Breaks VM Agent Communication

**Date**: 2026-03-12
**Severity**: P0 — All task execution broken in production
**Duration**: Until fix deployed
**Root cause**: Wildcard Worker route `*.domain/*` intercepts CF Worker subrequests to `vm-*` hostnames

## What Broke

Task submission via project chat fails with "Node agent not ready within 600000ms". The task runner provisions a VM successfully, but the health check poll never succeeds — the task times out after 10 minutes.

Additionally, even if health checks were to somehow pass, all subsequent VM agent communication (workspace creation, agent sessions) would also fail for the same reason.

## Root Cause

Cloudflare **same-zone subrequest routing**: when a Worker makes a `fetch()` to a hostname that matches one of its own routes within the same zone, Cloudflare intercepts the request and routes it back to the Worker instead of the origin.

The deploy script (`sync-wrangler-config.ts`) generated a wildcard Worker route:
```
*.simple-agent-manager.org/*
```

This matches ALL subdomains, including `vm-{nodeId}.simple-agent-manager.org`. When the task runner DO calls `fetch(vm-{nodeId}.domain:8443/health)`, the request goes back to the API Worker's own `/health` endpoint instead of the VM agent.

The task runner had identity verification (`body.nodeId === state.stepResults.nodeId`) which correctly rejected the API Worker's response (it lacks `nodeId`), but this meant the health check simply never succeeded.

## Timeline

1. **Unknown date**: Wildcard route `*.domain/*` deployed (was present before TLS change)
2. **2026-03-12**: User submits task in production → VM provisions successfully → health check loops for 10 minutes → task fails
3. **2026-03-12**: Investigation via CF observability reveals the same-zone routing issue
4. **2026-03-12**: Fix implemented: D1-based health check + explicit route patterns

## Why It Wasn't Caught

1. **The wildcard route worked for the web UI** — `app.*`, `api.*`, `ws-*.*` all function correctly. The only victim is `vm-*.*` which is only used for Worker-to-VM subrequests.
2. **No automated test exercises the CF routing layer** — Tests use Miniflare which doesn't simulate same-zone routing behavior.
3. **Staging verification gaps** — The process gates didn't enforce actual task execution through the full pipeline including VM provisioning and health checks.

## Fix (Two Parts)

### 1. D1-Based Health Check (Defense in Depth)

Replaced direct `fetch()` to `vm-{nodeId}.domain/health` with D1 heartbeat query in both `handleNodeAgentReady` and `verifyNodeAgentHealthy`. The VM agent already sends `POST /api/nodes/:id/ready` on startup and `POST /api/nodes/:id/heartbeat` periodically — these update `health_status` and `last_heartbeat_at` in D1. The task runner now reads these D1 records instead of fetching the VM directly.

### 2. Explicit Route Patterns (Root Cause Fix)

Replaced the wildcard route `*.domain/*` with explicit patterns for only the subdomains the Worker should handle:
- `api.domain/*`
- `app.domain/*`
- `www.domain/*`
- `domain/*` (bare domain)
- `ws-*.domain/*` (workspace proxy)

This ensures `vm-*.domain` requests are NOT intercepted, allowing all direct Worker-to-VM communication to work correctly (health checks, workspace creation, agent sessions, etc.).

## Class of Bug

**Platform routing interaction**: Infrastructure behavior (CF same-zone routing) that is invisible in local dev, invisible in most tests, and only manifests when a Worker makes subrequests to hostnames within its own zone that match its route patterns. This is a class of bug that requires either:
- Integration tests that simulate the platform behavior, or
- Explicit documentation of which hostnames the Worker route MUST NOT catch

## Process Fix

1. Added detailed comments in `sync-wrangler-config.ts` explaining the explicit route pattern requirement
2. Updated `CLAUDE.md` with the explicit route pattern rationale
3. The D1-based health check provides defense-in-depth even if routes are misconfigured in the future
4. Infrastructure verification gate (from TLS post-mortem) would catch this if enforced — requires actual VM provisioning test before merge
