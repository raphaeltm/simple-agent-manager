# Staging named-tunnel proof — 2026-11-10

The outbound-only transport model works. The first live proof completed at
[`1c084a124`](https://github.com/raphaeltm/simple-agent-manager/commit/1c084a124)
in [staging run 42774732470](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42774732470).
The origin was a GitHub runner with loopback-only listeners, not a managed Hetzner
node. No staging application deployment, user data, or production resources changed.

| Check | Observed result |
| --- | --- |
| Updated staging token | Named tunnel create, configure, and delete succeeded |
| Same-zone Worker → nested `.vm` tunnel CNAME | HTTP 200 at both 443 and 8443 |
| Same-zone Worker → flat tunnel CNAME | HTTP 200 at both 443 and 8443 |
| Direct client TLS on nested `.vm` hostname | Rejected: `ClientConnectorSSLError` |
| Direct client TLS on flat hostname | Verified successfully at 443 and 8443 |
| Two local HTTP ports | Both reachable through one named tunnel |
| Streaming | First event at 23 ms; final event around 2 seconds |
| WebSocket | Text and binary round trips; survived 35 seconds without heartbeat |
| Stop connector | HTTP 530; no public-IP fallback |
| Restart connector | Same tunnel and DNS resumed service |
| Missing fixture authorization | Worker and direct origin both returned 401 |
| Cleanup | All created DNS records, routes, Worker, and tunnel deleted; empty journal |

The existing `*.vm.sammy.party/*` scriptless route exclusion was already present
and remained unchanged. The flat fallback had its own temporary exact exclusion.
Worker subrequest success does **not** establish browser TLS support for nested
hostnames. Keep node-backend addresses internal to Worker fetches unless certificate
coverage is explicitly configured. Public workspace preview hostnames remain separate.

## Credential-boundary finding

A direct tunnel request reached loopback with neither `X-SAM-Proxied-Request` nor
`X-Forwarded-Host`. The existing Git credential handler trusts a known workspace's
bearerless private/loopback peer unless marked as relayed. Therefore a tunnel must
not point at that listener unchanged. This was observed with synthetic request
metadata; no real credential endpoint was publicly exposed.

The smallest candidate tested is a separate loopback tunnel listener that
classifies every incoming request as relayed before invoking the existing handlers.
Keep the private Docker Git helper listener, with public inbound traffic blocked.
Reusing the existing JWT and relay checks avoids adding another shared secret to
normal SAM traffic. The probe's keys protect only its synthetic fixtures.

The real-handler pass succeeded in
[run 42775358378](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42775358378)
at [`e5b416dfa`](https://github.com/raphaeltm/simple-agent-manager/commit/e5b416dfa).
It compiled the actual `internal/server` package and supplied synthetic JWKS,
workspace identifiers, local web servers, and a fake Git token service. Results:

| Real handler / proposed listener check | Result |
| --- | --- |
| JWT-authorized port 3000 and 5173 requests | 200; query token and Authorization absent at apps |
| Missing, invalid, expired, wrong-workspace, wrong-node JWT | All 401 |
| Direct tunnel request to port proxy without JWT | 401 |
| Port proxy targeting its own listener | 403 |
| Direct bearerless Git credential request via tunnel listener | 401 |
| Private loopback Git helper | 200 with synthetic credential only |
| Preview proxy relaying to private Git helper listener | 401 |
| Actual preview reverse proxy WebSocket upgrade and echo | Passed |
| Transport checks, connector restart, full cleanup | Passed again |

The listener wrapper exists only in the experiment fixture. These results do
not mean that the production VM agent has acquired a tunnel listener. The two
nested-host direct-TLS failures remain explicit measured limitations in both
reports; the workflow's success does not suppress them.

## Remaining managed-node integration

The proof does not implement cloud-init installation, automatic tunnel creation,
Docker bridge discovery, real login/session issuance, or node deletion:

1. Add opt-in tunnel transport to managed staging nodes, preserving direct-IP
   behavior for existing nodes. Provision one named tunnel per node incarnation.
2. Journal tunnel identity before VM creation. Scope retries and deletion to the
   exact incarnation, including failures before the provider VM exists.
3. Bootstrap `cloudflared` with a per-tunnel credential; never put account API
   tokens on nodes. Keep origin listeners private and block inbound IPv4/IPv6.
4. Centralize transport URL selection across readiness, management, WebSocket,
   preview, diagnostics, file-transfer, and local-forward callers.
5. Retain existing Worker authorization and workspace JWT checks; independently
   test direct-tunnel and preview-relayed attempts against Git credentials.
6. Wire installation permissions for clean installs and upgrades.
7. On one small managed staging VM, verify browser terminal/reconnect, real
   devcontainer previews, Git refresh, file transfer, restart, failure cleanup,
   and deletion. Remove the staging VM immediately afterward.

Canonical follow-up: SAM BYO idea `01KY7M8N1RBC4ZV6ZKSNG878B3`. These are required
integration work, not completed claims. The branch-only workflow is a research
vehicle and should not be merged as the production feature.
