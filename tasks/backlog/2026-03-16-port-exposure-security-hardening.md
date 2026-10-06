# Port Exposure Security Hardening

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - Ownership check on the workspace subdomain proxy: the D1 lookup is scoped to the user
>     (`apps/api/src/index.ts:386-394`, PR #928); per-port access tokens (PR #936); public ports
>     only by explicit opt-in (`portsPublicEnabled`, `index.ts:306-320`); unauthenticated port
>     requests get a 401 (`index.ts:324-344`).
>   - `sessionManager.Stop()` and `stopAllPortScanners()` run in `Server.Stop()`
>     (`packages/vm-agent/internal/server/server_shutdown.go:18,21`), which `main.go:88-93` calls
>     after `StopAllWorkspacesAndSessions`.
>   - The ULID format is enforced and commented in the parser
>     (`apps/api/src/lib/workspace-subdomain.ts:53-56`).
>   - Discovery logs the match count and picks a container deterministically
>     (`packages/vm-agent/internal/container/discovery.go:190-198`; Info level, not Warn).
>   - `useWorkspacePorts` was rewritten on TanStack Query; `mountedRef` is gone (PRs #1872, #1918).
> - **Still open:**
>   - Port guard (`PORT_EXPOSURE_MIN/MAX`, block 8443 and system ports). The parser accepts 1-65535
>     (`workspace-subdomain.ts:36-41`), and the VM proxy falls back to `127.0.0.1` when there is no
>     container discovery (`packages/vm-agent/internal/server/ports_proxy.go:57-58`).
>   - Add `&& targetPort === null` to the boot-log exemption (`apps/api/src/index.ts:417`).
>   - Explicit pathname normalization (`index.ts:462,591`); low value, since URL parsing already
>     resolves dot segments.
>   - KV routing cache; D1 is queried on every request (`index.ts:386-410`).
>   - Tests for the double-dash ID and `notexample.com` suffix cases.
>   - A timeout on `readProcNetTCP` (`packages/vm-agent/internal/ports/scanner.go:455-475`).
>   - VM proxy: enforce detected ports only, or document that it is unrestricted.
>   - Parse URLs in the Go CORS wildcard check
>     (`packages/vm-agent/internal/server/server.go:1216-1226`).
>   - Port rows in `apps/web/src/components/WorkspaceSidebar.tsx:406-412`: the dual `ml-auto`, and
>     `aria-hidden` on the Globe/ExternalLink icons.
>   - Items carried over from the port-proxy ownership file (end of this file).
> - **Moot/dropped:**
>   - The `minHeight: 44` port-row item conflicts with `apps/web` rule 17, which no longer asks
>     for enlarged touch targets.
>   - The `split('--', 2)` comment item is covered by the ULID check above.

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

## Carried over 2026-09-30

From `2026-03-17-port-proxy-ownership-verification` (removed from the backlog 2026-09-30; see git history), merged into this file in the
2026-09-30 weekly queue audit. Its session, ownership and 401 items shipped in PRs #928 and #936.

- [ ] Put the real user id in the Worker→VM port-proxy JWT instead of the literal `'port-proxy'`
      subject (`apps/api/src/index.ts:466,602`), and give that token a `type` claim or a shorter
      TTL.
- [ ] Validate workspace ID characters in the Go port-proxy Director
      (`packages/vm-agent/internal/server/ports_proxy.go`).
- [ ] Add a comment explaining the `SameSite=Lax` downgrade for cross-subdomain cookies
      (`packages/vm-agent/internal/auth/session.go:184-187`).
