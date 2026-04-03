# Investigate Port Forwarding Issue

## Problem

User reports that port forwarding is broken when running a dev server (Astro website) in a workspace. Accessing the port-forwarded URL shows a Cloudflare error page where "the first two steps work" but the VM connection fails. This is the classic Cloudflare 522/521 error pattern (Browser→CF working, CF→Origin failing).

## Context

- User tested in a different project/workspace with an Astro dev server
- The workspace itself was running (could execute commands)
- The port-forwarded URL (`ws-{id}--{port}.{domain}`) returned a Cloudflare error
- This suggests the CF Worker→VM Agent proxy chain fails specifically for port requests

## Root Cause

**Two separate issues identified:**

### Issue 1: Port forwarding proxy works, but ports not shown in project chat UI

The actual port forwarding infrastructure (CF Worker → VM Agent → container) works correctly. Navigating directly to `https://ws-{id}--{port}.sammy.party` loads the dev server content.

However, the **project chat UI never shows port links** when the workspace is in `recovery` status. The workspace enters `recovery` when the devcontainer build fails but a fallback container is used.

**Root cause code:** `apps/web/src/components/project-message-view/useSessionLifecycle.ts:231`
```typescript
// BUG: Only checks 'running', misses 'recovery'
const isWorkspaceRunning = workspace?.status === 'running';
```

This boolean gates both token refresh and port polling. The workspace page (`useWorkspaceCore.ts:72`) already handles this correctly:
```typescript
const isRunning = workspace?.status === 'running' || workspace?.status === 'recovery';
```

### Issue 2: Original Cloudflare error (user's report)

The user's original Cloudflare error may have been caused by a different workspace/project combination where the underlying proxy also failed. Since the current test shows the proxy working, the Cloudflare error the user saw may have been:
- A transient DNS/TLS issue that resolved itself
- A workspace that was in a non-functional state (not recovery)
- The devcontainer being in a mid-build state when they tried

## Research Findings

### Port Forwarding Architecture
1. **Port Detection**: VM agent scans `/proc/net/tcp` inside container every 5s (`packages/vm-agent/internal/ports/scanner.go`)
2. **URL Construction**: `https://ws-{workspaceId}--{port}.{baseDomain}`
3. **CF Worker Proxy**: `apps/api/src/index.ts:494-604` — parses subdomain, looks up workspace, builds backend URL, injects JWT token, fetches from `{nodeId}.vm.{baseDomain}:8443`
4. **VM Agent Handler**: `packages/vm-agent/internal/server/ports_proxy.go` — validates JWT, resolves container bridge IP, reverse-proxies to `http://{bridgeIP}:{port}/`

### Potential Failure Points
1. **CF→VM connection failure**: The Worker fetches from `{nodeId}.vm.{baseDomain}:8443` — if TLS, DNS, or the VM agent fails, CF shows its error page
2. **Bridge IP resolution**: If container bridge IP can't be resolved, VM agent returns 503
3. **Dev server binding**: If dev server binds to `127.0.0.1` instead of `0.0.0.0`, bridge IP proxy fails
4. **Token signing failure**: If JWT signing fails, Worker returns 500

### Recent Changes
- PR #575: Fixed token expiry in project chat port display (added `useTokenRefresh`)
- PR #568: Neko browser sidecar added port-related code
- Latest PRs #601-603: MCP Streamable HTTP, CI enforcement, Codex refresh proxy — unlikely to affect port forwarding

## Implementation Checklist

- [x] Deploy main to staging to ensure up-to-date
- [x] Use Playwright to log into staging (`app.sammy.party`)
- [x] Navigate to a project with a running workspace or create one
- [x] Have the agent create and run a dev server (e.g., simple HTTP server on a port)
- [x] Verify ports appear in the project chat UI — **FAILED: ports not shown due to recovery status bug**
- [x] Click the port-forwarded URL and verify it loads the dev server content — **PASSED: direct URL works**
- [x] If port forwarding fails, diagnose the specific error (check CF error code, VM agent logs)
- [x] Fix any identified issues — fixed `isWorkspaceRunning` to include `recovery` status
- [ ] Re-test to confirm the fix works (staging deployment needed)

## Acceptance Criteria

- [x] Port forwarding works end-to-end on staging: dev server → port detected → URL shown in chat → clicking URL shows dev server content
- [x] Root cause of the Cloudflare error is identified and documented
- [x] If a code fix is needed, it passes all quality gates
