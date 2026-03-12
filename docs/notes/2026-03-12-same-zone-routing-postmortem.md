# Post-Mortem: Cloudflare Same-Zone Routing Breaks VM Agent Health Checks

**Date**: 2026-03-12
**Severity**: P0 — All task execution broken in production
**Duration**: Until fix deployed
**Root cause**: Task runner health check used direct `fetch()` to VM agent, which Cloudflare same-zone routing intercepts

## What Broke

Task submission via project chat fails with "Node agent not ready within 600000ms". The task runner provisions a VM successfully, but the health check poll never succeeds — the task times out after 10 minutes.

## Root Cause

Cloudflare **same-zone subrequest routing**: when a Worker makes a `fetch()` to a hostname that matches one of its own routes within the same zone, Cloudflare intercepts the request and routes it back to the Worker instead of the origin.

The deploy script generates a wildcard Worker route `*.domain/*` which matches ALL subdomains, including `vm-{nodeId}.domain`. When the task runner DO calls `fetch(vm-{nodeId}.domain:8443/health)`, the request goes back to the API Worker's own `/health` endpoint instead of the VM agent.

The task runner had identity verification (`body.nodeId === state.stepResults.nodeId`) which correctly rejected the API Worker's response (it lacks `nodeId`), but this meant the health check simply never succeeded.

**Why we can't use explicit routes to fix this**: Cloudflare route patterns only support wildcards at the BEGINNING of the hostname (e.g., `*.domain/*`). Patterns like `ws-*.domain/*` are rejected with error 10022. Since the Worker needs to handle `ws-*` subdomains for workspace proxying, we must use the wildcard `*.domain/*`, which inherently catches `vm-*` too.

## Timeline

1. **Unknown date**: Wildcard route `*.domain/*` deployed (was present before TLS change)
2. **2026-03-12**: User submits task in production → VM provisions successfully → health check loops for 10 minutes → task fails
3. **2026-03-12**: Investigation via CF observability reveals the same-zone routing issue
4. **2026-03-12**: Fix implemented: D1-based health check replaces direct VM fetch

## Why It Wasn't Caught

1. **The wildcard route worked for the web UI** — `app.*`, `api.*`, `ws-*.*` all function correctly via external browser requests. Same-zone routing only affects Worker subrequests (internal `fetch()` calls).
2. **No automated test exercises the CF routing layer** — Tests use Miniflare which doesn't simulate same-zone routing behavior.
3. **Staging verification gaps** — The process gates didn't enforce actual task execution through the full pipeline including VM provisioning and health checks.

## Fix: D1-Based Health Check

Replaced direct `fetch()` to `vm-{nodeId}.domain/health` with D1 heartbeat query in both `handleNodeAgentReady` and `verifyNodeAgentHealthy`. The VM agent already sends `POST /api/nodes/:id/ready` on startup and `POST /api/nodes/:id/heartbeat` periodically — these update `health_status` and `last_heartbeat_at` in D1. The task runner now reads these D1 records instead of fetching the VM directly.

This completely sidesteps the same-zone routing issue because D1 queries don't use `fetch()` to VM hostnames.

**Note on route patterns**: We cannot split the wildcard into explicit subdomain routes because Cloudflare rejects mid-hostname wildcards (`ws-*.domain/*` → error 10022). The wildcard route `*.domain/*` remains, but all health check code paths now use D1 instead of direct fetch, making the route configuration irrelevant for health checks.

## Class of Bug

**Platform routing interaction**: Infrastructure behavior (CF same-zone routing) that is invisible in local dev, invisible in most tests, and only manifests when a Worker makes subrequests to hostnames within its own zone that match its route patterns. This is a class of bug that requires:
- Avoiding direct `fetch()` to VM hostnames from within the Worker
- Using indirect communication (D1, KV, DO) for Worker-to-VM status checks
- Any remaining direct VM fetches (workspace creation, agent sessions) must be tested against same-zone routing behavior

## Process Fix

1. Added detailed comments in `sync-wrangler-config.ts` explaining the wildcard route constraint and D1 workaround
2. D1-based health check is now the primary mechanism — eliminates the most critical same-zone routing failure
3. Infrastructure verification gate (from TLS post-mortem) would catch this if enforced — requires actual VM provisioning test before merge

## Known Remaining Risk

Other VM agent subrequests (`createWorkspaceOnNode`, `startAgentSessionOnNode`) still use direct `fetch()` to VM hostnames. These may also be affected by same-zone routing. If task execution fails at the workspace creation step after this fix, these subrequests will need similar D1-based or indirect communication patterns.
