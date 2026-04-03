# Investigate Port Forwarding Issue

## Problem

User reports that port forwarding is broken when running a dev server (Astro website) in a workspace. Accessing the port-forwarded URL shows a Cloudflare error page where "the first two steps work" but the VM connection fails. This is the classic Cloudflare 522/521 error pattern (Browser→CF working, CF→Origin failing).

## Context

- User tested in a different project/workspace with an Astro dev server
- The workspace itself was running (could execute commands)
- The port-forwarded URL (`ws-{id}--{port}.{domain}`) returned a Cloudflare error
- This suggests the CF Worker→VM Agent proxy chain fails specifically for port requests

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

- [ ] Deploy main to staging to ensure up-to-date
- [ ] Use Playwright to log into staging (`app.sammy.party`)
- [ ] Navigate to a project with a running workspace or create one
- [ ] Have the agent create and run a dev server (e.g., simple HTTP server on a port)
- [ ] Verify ports appear in the project chat UI
- [ ] Click the port-forwarded URL and verify it loads the dev server content
- [ ] If port forwarding fails, diagnose the specific error (check CF error code, VM agent logs)
- [ ] Fix any identified issues
- [ ] Re-test to confirm the fix works

## Acceptance Criteria

- [ ] Port forwarding works end-to-end on staging: dev server → port detected → URL shown in chat → clicking URL shows dev server content
- [ ] Root cause of the Cloudflare error is identified and documented
- [ ] If a code fix is needed, it passes all quality gates
