# L17b: reverse tunnel routing, WebSocket gateway, self-host gateway route and lease sweep

## Problem

L17a (#2831, e5c5aa4f7) landed leases, frps authorization and provisioning under
`apps/api/src/selfhost/`. Main still cannot reach a reverse-tunnel node: the control plane only
knows the public `{node}.vm.{domain}` hostname, the frps plugin and Caddy forward_auth endpoints do
not exist, and the backstop sweep is not mounted. Task 01M7MH487P2E0QKKXJ4VT4RCTE; coordinator
01M7JMXS2JRW6QQMB1356ENPM3; source `origin/sam/selfhost-pass-2` (ported by hand, no cherry-picks).

## Placement (Raphaël, 2026-11-14: self-host-only code is never loaded by the Worker)

Shared Worker seams (zero added I/O on Cloudflare, where no extension is installed):
- `services/node-transport-extension.ts`: driver gains `resolveAgentOrigin`; `provisionsExtensionTransportNodes`.
- `services/node-agent-route.ts`: route from the node row (container | extension | public); a
  tunnel-only transport with no installed driver fails closed.
- `fetchNodeAgent`, the ws-* proxy and the logs stream fold `transport` into the node read they
  already make. The liveness probe reads `transport` from its existing snapshot query.
- `services/node-websocket-gateway.ts`: WeakMap marker + decision headers; one WeakMap lookup on CF.
- Snapshot upload relay: tunnel-only nodes are never relays (SQL predicate + flag, no I/O).

Self-host only (`selfhost/reverse-tunnel/`): `route.ts` lease origin, `gateway.ts` frps plugin +
node-websocket forward_auth, `entry.ts` `withReverseTunnel(worker, render)` mounting the gateway
ahead of the shared app and the lease sweep on the five-minute cron.

Per-request I/O on shared routes: unchanged for every Cloudflare transport (0 added reads).
Reverse-tunnel nodes add one indexed lease read per control-plane request.

## Findings

- F19: closed by L17a (real SQL backstop/direct delete/providerless tests). L17b adds the mounted
  sweep entry-point test.
- F20 duplicate sessions: L17a authz returns a server-chosen run_id; this slice serializes it as
  `{reject:false, unchange:false, content}` (required for frps to apply it).
- F20 revocation latency: control-plane traffic and WebSocket decisions now resolve only the active
  lease of the current incarnation, so revocation applies on the next request; frps drops the
  control session within one heartbeat timeout because a refused Ping does not refresh it.
- F20 HMAC subkey: closed by L17a (HKDF purpose subkeys). Rotation: idea 01M7KPNV3B28WPEVJRNRAM2X1D.
- F21 NULL tunnel_id backfill: closed by L17a. Broad 404 matcher: Caddy, L22.
- F21 Login rate limit: see decision in PR.
- F21 port_range_cooling_down: see decision in PR.

## Checklist

- [x] Shared route seam + fetchNodeAgent / ws proxy / logs stream / liveness probe / relay
- [x] Shared gateway decision module
- [x] Self-host route resolver, gateway routes, entry wrapper with sweep
- [ ] Tests: route seam (CF zero extra read, fail-closed, revocation), gateway serializer + auth,
      forward_auth through the real app, sweep mounted entry point, liveness probe routing,
      relay exclusion, import graph
- [ ] Docs: self-hosting guide gateway/entry contract
- [ ] Lint/typecheck/test/build; reviews: security-auditor, cloudflare-specialist, test-engineer,
      task-completion-validator
- [ ] Staging: default + cloudflare-tunnel nodes connect, heartbeat, system-info, websocket; sweep no-op; cleanup
- [ ] BOX: reverse-tunnel run on the self-host box against this branch
- [ ] PR, CI, CodeRabbit, merge, idea update

## Acceptance

- Cloudflare Worker graph excludes `selfhost/`; shared routes add no I/O on Cloudflare.
- Reverse node HTTP, liveness and WebSocket traffic route to the current lease; a released lease is refused.
- frps Login allow is serialized with unchange:false/content; other ops unchange:true.
- Lease sweep runs from the self-host entry on the sweep cron, isolated, honours the kill switch.
