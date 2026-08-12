# Isolate Preview Apps from VM-Agent Sessions

## Problem

Runtime audit task `01KZT1EVZTHTWK7QMVCKBB29TK` (session `320ed0c0-5c4f-4e8f-a638-ec12df0f1b1b`) found H2: user-controlled port-preview applications can receive reusable VM-agent session cookies and can originate credentialed requests toward privileged workspace endpoints. The finding is High severity, 99% confidence, and a P0 release blocker.

This remediation must preserve every valid authenticated terminal, ACP, boot-log, preview, application-cookie, port WebSocket, and reconnect flow. It must fail closed only for reserved SAM cookies and untrusted origins, remain compatible with existing deployments, and stay limited to H2.

## Research Findings

- `origin/main` still equals the audited SHA `fc1e394217248c3bd004b2e6619cf2344eade7e3`; no open PR or active SAM task duplicates H2.
- The Cloudflare workspace proxy lives in `apps/api/src/index.ts` (the report's older `services/workspace-proxy.ts` reference no longer exists). It consumes `sam_port_access`, then forwards the original Cookie header to the VM agent and only deletes response `Set-Cookie` headers.
- `packages/vm-agent/internal/server/server.go` derives `.BASE_DOMAIN` as `CookieDomain`, so VM-agent cookies set on trusted `ws-ID` hosts are sent to all `ws-ID--PORT` preview hosts.
- `packages/vm-agent/internal/server/ports_proxy.go` removes the query token but forwards browser cookies into the user-controlled application.
- `packages/vm-agent/internal/config/env_fallback.go` derives `https://*.BASE_DOMAIN`; `createUpgrader` accepts wildcard origins; boot-log and log-stream WebSockets bypass origin checks entirely.
- The control-plane UI connects from the exact `app.BASE_DOMAIN` origin to terminal, ACP, and boot-log WebSockets. Preview application HTTP/WebSocket traffic must remain usable on its own port host.
- Existing port-access tests cover token/cookie authorization and blanket response `Set-Cookie` deletion, but not inbound reserved-cookie stripping, sibling-origin WebSocket abuse, or defense at the Go proxy boundary.
- Historical port-access work (`tasks/archive/2026-05-08-port-access-tokens.md`) requires the per-port `sam_port_access` handshake and old terminal/session paths to remain valid. Host preservation (`tasks/archive/2026-03-17-fix-port-forwarding-host-header.md`) must also remain intact.

## Implementation Checklist

- [ ] Add adversarial Worker tests that capture the proxied request and prove SAM-reserved cookies are consumed/removed while intentionally supported ordinary preview cookies remain isolated to the preview path.
- [ ] Add Go proxy tests proving reserved inbound Cookie values and reserved upstream `Set-Cookie` values cannot cross into/out of preview applications, while ordinary host-only application cookies and WebSocket upgrades remain functional.
- [ ] Add exact-origin tests for terminal, ACP, boot-log, and reconnect success plus malicious preview, wildcard, malformed, and unrelated origin rejection.
- [ ] Make VM-agent session cookies host-only for new sessions while safely expiring legacy parent-domain cookies.
- [ ] Apply shared reserved-cookie filtering at both Cloudflare and VM-agent proxy boundaries.
- [ ] Replace wildcard privileged CORS/WebSocket trust with explicit trusted control-plane origins, without restricting port-preview application traffic.
- [ ] Update the public security architecture with the port-preview trust boundary, reserved-cookie behavior, and exact-origin policy.
- [ ] Run focused tests, Go race/coverage/static checks, API checks, repository fast/full gates, specialist review, and a fresh adversarial review.
- [ ] Open exactly one non-draft PR, skip staging by explicit instruction, do not merge, and monitor/fix all applicable CI to green.

## Acceptance Criteria

- [ ] A preview app never receives `sam_port_access`, BetterAuth, VM-agent base, or workspace-scoped session cookies through either proxy layer.
- [ ] A preview app cannot set or overwrite a SAM-reserved cookie; any supported ordinary application cookie is host-only and cannot escape its exact preview host.
- [ ] Existing parent-domain VM cookies cannot authorize or leak through previews during upgrade rollout; new terminal/ACP sessions use host-only cookies.
- [ ] Privileged workspace WebSockets accept intended exact control-plane origins and no-origin non-browser token clients, but reject port-preview, wildcard-only, null/malformed browser, and unrelated origins.
- [ ] Terminal and ACP initial connection/reconnection, boot-log streaming, port HTTP/WebSocket proxying, port-access token/cookie handshakes, Host preservation, and public ports keep their current contracts.
- [ ] Public security documentation cites the enforcing Worker and VM-agent functions.
- [ ] All local specialist/adversarial findings are passed or addressed, all applicable CI checks are green, and the single PR remains open and unmerged without staging mutation.

## References

- Runtime audit H2: task `01KZT1EVZTHTWK7QMVCKBB29TK`, session `320ed0c0-5c4f-4e8f-a638-ec12df0f1b1b`
- `apps/api/src/index.ts`
- `apps/api/tests/unit/workspace-proxy-port-access.test.ts`
- `packages/vm-agent/internal/auth/session.go`
- `packages/vm-agent/internal/server/ports_proxy.go`
- `packages/vm-agent/internal/server/websocket.go`
- `.claude/rules/20-cross-origin-cors.md`
- `.claude/rules/34-vm-agent-callback-auth.md`
- `apps/www/src/content/docs/docs/architecture/security.md`
