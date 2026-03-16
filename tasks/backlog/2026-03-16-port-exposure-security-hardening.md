# Port Exposure Security Hardening

**Created**: 2026-03-16
**Source**: Cloudflare specialist + Go specialist reviews of PR #419 (workspace port exposure)
**Priority**: HIGH

## Problem

The workspace subdomain proxy (both standard `ws-{id}` and port-specific `ws-{id}--{port}`) does not validate that the requesting user owns the workspace. Any client that can guess a workspace ID can access the workspace's ports. Additionally, there is no port allowlist — any port 1-65535 can be proxied, including infrastructure ports (SSH 22, Docker 2375/2376, VM agent 8443).

The auth gap predates the port exposure feature (the standard workspace proxy had the same issue), but port exposure widens the attack surface by giving access to dev servers, databases, and internal tools running inside containers.

## Implementation Checklist

- [ ] Add ownership validation to workspace subdomain proxy in `apps/api/src/index.ts`
  - Fetch `userId` in the D1 query alongside `nodeId` and `status`
  - Compare against authenticated session (cookie-based auth)
  - If intentionally allowing public preview URLs, make it explicit and opt-in
- [ ] Add configurable port range guard at Worker level
  - Add `PORT_EXPOSURE_MIN` (default: 1024) and `PORT_EXPOSURE_MAX` (default: 65535) env vars to `Env` interface
  - Block system ports (1-1023) and known infrastructure ports (8443) by default
  - Return 403 for blocked ports
- [ ] Guard `creating` + `/boot-log/ws` status exemption against port-proxy path
  - Add `&& targetPort === null` to the condition at `index.ts:362`
- [ ] Normalize `url.pathname` before embedding in backend URL template
  - Use `new URL(url.pathname, 'http://x').pathname` to strip path traversal sequences
- [ ] Add KV-based routing cache for D1 workspace lookup (MEDIUM — performance)
  - Cache `{ nodeId, status, userId }` in KV with 30-60s TTL under `ws-route:{workspaceId}`
- [ ] Add missing test cases to `workspace-subdomain.test.ts`
  - Double-dash workspace ID: `ws-abc--def--3000.example.com`
  - Suffix-domain rejection: `ws-abc123.notexample.com` with baseDomain `example.com`
- [ ] Add comment to `split('--', 2)` documenting ULID ID format assumption
- [ ] Add timeout to `readProcNetTCP` via `exec.CommandContext` (Go specialist HIGH)
  - Add `PORT_SCAN_EXEC_TIMEOUT` env var (default: 5s)
  - Prevents goroutine stall on unresponsive Docker daemon
- [ ] VM agent: validate proxied port against detected port set or document unrestricted intent
  - `handleWorkspacePortProxy` allows any port 1-65535 regardless of `ExcludePorts`
  - Either enforce detected-only or explicitly document that exclude list is display-only
- [ ] Add `s.sessionManager.Stop()` to `Server.Stop()` (Go specialist MEDIUM — goroutine leak)
- [ ] Call `stopAllPortScanners()` from `StopAllWorkspacesAndSessions` (Go specialist MEDIUM)
- [ ] Fix CORS wildcard suffix check to use URL parsing (Go specialist MEDIUM — pre-existing)
- [ ] Log warning when multiple containers match discovery label (Go specialist LOW)
- [ ] Fix dual `ml-auto` layout conflict on port rows when `(local)` badge is present (UI specialist)
  - Only first element should have `ml-auto`; ExternalLink should follow naturally
- [ ] Add `minHeight: isMobile ? 44 : undefined` to port `<a>` rows for mobile touch targets (UI specialist)
- [ ] Add `aria-hidden="true"` to Globe and ExternalLink decorative icons in port rows (UI specialist)
- [ ] Remove redundant `mountedRef` initializer effect in `useWorkspacePorts` hook (UI specialist)

## Acceptance Criteria

- [ ] Unauthenticated requests to `ws-{id}--{port}.{domain}` return 401/403
- [ ] Ports below configurable minimum (default 1024) are rejected with 403
- [ ] Port 8443 (VM agent) is not proxiable from the public subdomain
- [ ] Path traversal sequences in the proxied URL are normalized
- [ ] Boot-log exception does not apply to port-proxy requests on creating workspaces
- [ ] `readProcNetTCP` has configurable timeout, doesn't block indefinitely
- [ ] No goroutine leaks in server shutdown path (session manager + port scanners)

## References

- PR #419 cloudflare-specialist review (full findings in agent output)
- `apps/api/src/index.ts:330-416` — workspace subdomain proxy middleware
- `apps/api/src/middleware/workspace-auth.ts` — existing ownership validation pattern
- `.specify/memory/constitution.md` Principle XI — PORT_EXPOSURE_MIN/MAX must be configurable
