# Reverse-tunnel (frp) node transport and Caddy-carried node WebSockets

Self-host pass 2, T2. Coordinator task `01M72KTXWD8FJ0Z7TXKN5GF20J`, my task `01M72X0F03A7NVVJP28W9SC03Z`.
Integration branch `sam/selfhost-pass-2`; draft PR only; no merge; no staging; no Cloudflare credentials.
Idea `01M72M9AEB933ZY8269D376DKC` (sections 3, 5). Spike: `origin/sam/self-host-spike-track-2dgkck:experiments/selfhost-spike/tunnel/`.

## Problem

A self-hosted control plane (celld behind Caddy, no Cloudflare) cannot reach managed nodes: every
control-plane call goes to `https://{nodeId}.vm.{BASE_DOMAIN}:8443` (Cloudflare DNS + Origin CA), and
celld cannot hand a WebSocket obtained from an outbound `fetch()` back to the browser. A third transport,
`reverse-tunnel`, lets each node dial the box (frpc over wss on 443) and exposes it to the box on a
leased loopback port; Caddy carries browser WebSockets after the Worker authorizes them.

## Research findings

- `resolveManagedNodeTransport` (`services/node-tunnel-config.ts`) is the single selector; fails closed on unknown values.
- #2615 journal pattern: `node_cloudflare_tunnels` + `LIVE_INCARNATION_SQL` (`services/node-tunnel-journal.ts`), release on
  provisioning failure (`releaseTunnelBeforeVm`, `settleNodeTunnels`), race cleanup (`node-provisioning-race-cleanup.ts`),
  strict deletion (`releaseTerminatedNodeTunnels` in `strict-node-deletion.ts`, two call sites), cron sweep
  (`runNodeTunnelCleanupSweep`, `scheduled/handler.ts`).
- Seam: `fetchNodeAgent` (`services/node-agent.ts`) reads `nodes.runtime` per call. Bypassers: `index.ts` ws-* proxy (raw `fetch`),
  `task-runtime-liveness-node-probe.ts` (raw `fetchWithTimeout`), `session-snapshot-upload-relay.ts` (URL handed to another VM).
- Server-side gates keyed on Cloudflare tunnel: Origin CA refusal (`routes/node-lifecycle.ts` transport check),
  heartbeat IP/A-record backfill (keyed on `tunnelId`), provisioning A record + IP wait (keyed on `tunnel`).
- frp 0.72.0 verified: frps sends `addr` userinfo as `Authorization: Basic`; Login body `content.{user,metas,...}`,
  NewProxy body `content.{user:{user,metas,run_id},proxy_name:"<user>.<name>",proxy_type,remote_port}`.
- ws-* proxy auth lives inline in `index.ts` (1024 lines, over the 800 cap); logs-stream WS in `routes/nodes/diagnostics.ts`.
- Browser WS endpoints on vm-agent: `/terminal/ws`, `/terminal/ws/multi`, `/agent/ws`, `/boot-log/ws`, ports via `ws-{id}--{port}`,
  plus `/logs/stream` via `api.*/api/nodes/:id/logs/stream`.

## Design decisions

- Transport value `reverse-tunnel`, managed VM workspace nodes only (deployment nodes and Instant unchanged).
- Lease table `node_reverse_tunnel_leases`, one row per node incarnation; partial UNIQUE index on `port WHERE status='active'`;
  allocation is ONE `INSERT ... SELECT` (port picked in the same statement, fenced on the live node row).
- Per-node credential: HMAC of the lease identity under a Worker-only derived key, only its SHA-256 stored; re-derivable on durable resume.
- frps plugin route `POST /api/self-host/gateway/frps-plugin` (Basic auth = `REVERSE_TUNNEL_GATEWAY_SECRET`), ops Login/NewProxy/Ping.
- forward_auth route `GET /api/self-host/gateway/node-websocket` (header `X-SAM-Gateway-Secret`): re-dispatches the original
  request through the SAM app with an in-process marker (WeakSet) so the real ws-* / logs-stream auth runs unchanged, and the
  handlers return the upstream decision instead of fetching.
- Plain HTTP (incl. port previews) stays on the Worker path; WebSocket upgrades go through Caddy.

## Implementation checklist

- [x] shared: `NodeTransport` gains `reverse-tunnel`
- [x] cloud-init: frpc pinned+checksummed install, `sam-frpc.service` in the cloudflared slot, credential file, validation, tests (YAML parse + runcmd under sh)
- [x] D1 migration 0232 + schema
- [x] config: transport resolution, port range, gateway secret, credential key
- [x] lease service: allocate (atomic), release (unallocated, non-live), sweep, credential derive/verify
- [x] provisioning integration (no DNS, no IP wait, no Origin CA, resume keeps transport)
- [x] node route resolver at the seam: `fetchNodeAgent`, ws-* proxy, liveness probe; relay disabled for reverse-tunnel
- [x] server-side gates: Origin CA refusal, heartbeat IP backfill
- [x] release on every lifecycle path (enumerated in PR)
- [x] frps plugin route + tests (cross-node claim refused, owner control, discriminating)
- [x] gateway forward_auth route + interception in ws-* proxy and logs stream; split ws-* proxy out of index.ts
- [x] deploy/selfhost: frps.toml, caddy fragments
- [x] tests proving vm-public-dns / cloudflare-tunnel / cf-container paths unchanged
- [x] local proof: control-plane call, vm-agent WS with real JWT, port preview, refused cross-node claim, frpc/frps kill recovery
- [x] docs: env reference / .env.example / runtime tunables baseline

## Acceptance criteria

- [x] Explicit `VM_AGENT_TRANSPORT=reverse-tunnel` is the only way to select it; other values behave exactly as before (tests)
- [x] Two concurrent allocations never share a port (real SQL)
- [x] Every node deletion/cleanup path releases the lease (tests per path)
- [x] frps plugin refuses a valid credential claiming another node's port; owner control passes; proven discriminating
- [x] Gateway endpoint performs the existing ws-* auth (session, terminal token, port cookie/token, public ports) without a second implementation
- [x] Local run evidence recorded in the PR

## Implementation notes

- Gateway decision via re-dispatch: `routes/self-host-gateway.ts` rebuilds the original request, marks it
  (WeakMap, `services/node-websocket-gateway.ts`) and runs it through the SAM app; the ws-* proxy and the
  logs-stream route return the upstream decision instead of fetching. No second auth implementation.
- ws-* proxy moved verbatim from `index.ts` to `routes/workspace-subdomain-proxy.ts` (+ `workspace-port-access.ts`).
- Non-reverse nodes keep the exact node query shape in `fetchNodeAgent` (route resolver reads the lease only for
  reverse-tunnel nodes), so existing deployments run the same single query.
- Plain HTTP previews stay on the Worker path (keeps ports-readiness payloads, redirects, Set-Cookie stripping);
  only WebSocket upgrades go through Caddy. Worker-proxied node responses are cut at celld's
  `CELLD_FETCH_TIMEOUT_S` (T1 sets 3600).
- Found by the local E2E run and fixed: braces in an frps.toml comment (frps refuses to start); celld rebuilds
  `request.url` from `X-Forwarded-Host` (gateway now reads `X-SAM-Gateway-Original-Host`; ws-* proxy never
  forwards the gateway secret); Caddy `header_up {host}` after a `Host` override is unordered (`vars` capture);
  node Set-Cookie on non-101 port responses (`header_down`).
- Dead end: Caddy `header_down` is not applied to 101 upgrade responses; a response-writer `header` rule with
  `match status 101` is needed for sockets.
- Found an unrelated pre-existing deadlock in the tunnel firewall script under iptables-legacy:
  `tasks/backlog/2026-11-10-tunnel-firewall-xtables-lock-deadlock.md`.
