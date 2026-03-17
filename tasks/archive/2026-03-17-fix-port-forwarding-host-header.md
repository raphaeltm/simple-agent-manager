# Fix Port Forwarding Host/Origin Header Preservation

## Problem

When accessing a port-forwarded service through SAM (e.g., `https://ws-01kkz01fsn92q3rz03p349zrtn--5173.simple-agent-manager.org/`), the proxied request arrives at the container service with the raw VM hostname as the Host header (e.g., `01kkyjdny237cxgcfj33kwkxtz.vm.simple-agent-manager.org`) instead of the original workspace port-forwarding hostname.

This causes issues with services like Vite that validate the Host header — they see an unexpected hostname and block the request.

## Root Cause

The proxy chain loses the original Host header at two points:

1. **API Worker** (`apps/api/src/index.ts:424-437`): The `fetch()` call to the VM agent goes through Cloudflare's edge, which requires the Host header to match the VM URL's hostname for routing. The original client-facing Host (`ws-{id}--{port}.{domain}`) is not forwarded as a separate header.

2. **VM Agent** (`packages/vm-agent/internal/server/ports_proxy.go:114-121`): The reverse proxy Director derives the public Host from `config.DeriveBaseDomain(ControlPlaneURL)` rather than using the actual original Host from the client request. While this derivation usually produces the right value, it's fragile and doesn't account for cases where the API Worker doesn't forward the original Host.

## Research Findings

- **API Worker proxy**: `apps/api/src/index.ts:424-437` — copies request headers but doesn't set `X-Forwarded-Host`
- **VM Agent port proxy**: `packages/vm-agent/internal/server/ports_proxy.go:109-137` — creates `httputil.ReverseProxy`, Director sets `req.Host` from derived config value
- **DeriveBaseDomain**: `packages/vm-agent/internal/config/config.go:488-503` — strips `api.` prefix from ControlPlaneURL hostname
- **Existing tests**: `apps/api/tests/unit/ws-proxy.test.ts` — tests proxy routing but not header preservation
- **Subdomain parsing**: `apps/api/src/lib/workspace-subdomain.ts` — correctly parses `ws-{id}--{port}.{domain}` patterns

## Implementation Checklist

- [ ] **API Worker**: Set `X-Forwarded-Host` header to original request hostname before proxying to VM agent (`apps/api/src/index.ts`)
- [ ] **VM Agent**: Update port proxy Director to read `X-Forwarded-Host` header and use it as `req.Host`, falling back to current derived value (`packages/vm-agent/internal/server/ports_proxy.go`)
- [ ] **API Worker test**: Add test verifying `X-Forwarded-Host` is set on proxied requests (`apps/api/tests/unit/ws-proxy.test.ts`)
- [ ] **VM Agent test**: Add test verifying port proxy uses `X-Forwarded-Host` when present and falls back when absent (`packages/vm-agent/internal/server/ports_proxy_test.go`)
- [ ] **Typecheck and lint**: Verify no regressions

## Acceptance Criteria

- [ ] Port-forwarded requests to services like Vite receive the original `ws-{id}--{port}.{domain}` hostname as the Host header
- [ ] When `X-Forwarded-Host` is absent (e.g., direct VM agent requests), the current derived Host behavior is preserved as a fallback
- [ ] Tests verify header preservation end-to-end through the proxy chain
- [ ] No regressions in existing proxy routing tests
