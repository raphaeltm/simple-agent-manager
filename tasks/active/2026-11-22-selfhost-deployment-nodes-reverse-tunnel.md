# Self-host: app deployment nodes on a box through the reverse tunnel

SAM task `01M81BE3NYP2225ZR58SJBSEGJ` (coordinator `01M7XCE59V5X0WTNF1X3NFZP5J`, channel
`feature.selfhost-landing`). Ideas `01M7Z0N9ACNE44NC4ZWK3K2QNB`, `01M7V5DMWTXWDMCWA5T4YC9HC5`.

## Problem

On a single-box install, a release provisions a deployment node that fails boot at
`origin_ca_bootstrap`: the box reverse-tunnel transport selects only `nodeRole === 'workspace'`
(`apps/api/src/selfhost/reverse-tunnel/transport.ts`), so deployment nodes take public transport,
which needs Cloudflare Origin CA. The release stays `created`.

Raphaël's decision (2026-11-22, ask `01M7Z0VBV4P55ED5WFHA9RKN0S`): deployment nodes use the box
tunnel exactly as workspace nodes do; nothing new is exposed; all app traffic flows through the
box. The node opens no public app port, does no ACME, and no per-node credential crosses the box's
TSIG boundary.

Self-hosting only. Hosted SAM (Cloudflare) must not change.

## Research findings

- Transport: `resolveManagedNodeTransport` (`services/node-tunnel-config.ts`) defers to an installed
  extension's `select`; only the self-host entry installs one. One lease port per node incarnation;
  lease and frps-plugin checks never read the role (`leases.ts`, `authz.ts`).
- Deployment node ingress today: vm-agent installs Caddy (`deploy/runtime.go:ensureCaddy`) and
  writes bare-hostname sites (`deploy/caddy.go:GenerateCaddySnippet`), so Caddy does ACME and binds
  public 80/443. Compose publishes `127.0.0.1:<hostPort>` (`compose-renderer.ts`). Cloud-init
  writes a bootstrap Caddyfile `:80` for every role (`cloud-init/src/template.ts`).
- Firewall: GCP opens 80/443 by network tag when the provider label `role=deployment`
  (`providers/src/gcp.ts`). The tunnel iptables script drops the agent, tunnel and SSH ports only
  (`template-ingress.ts:TUNNEL_FIREWALL_WRITE_FILE`); deployment nodes run the same script
  (`deploy/runtime.go:ensureDeploymentNetworkHardening`).
- App hostnames: `r{n}-{svc}-{port}-{envId lowercased}.apps.{BASE_DOMAIN}`
  (`app-deployment/src/deployment-routing.ts:buildRouteHostname`). No route table: targets are
  re-derived from the latest release manifest (`getEnvironmentPublicRouteTargets`); env → node via
  `deployment_environments.node_id`.
- DNS on the box: `apps.<apex>` is a Worker namespace in sam-dns (`zone.go:workerNamespaces`), so the
  apex wildcard never answers below it; unregistered app names are NXDOMAIN by design. sam-dns
  accepts `_acme-challenge.<anything>` TXT updates (`update.go:isChallengeName`), so a
  `*.apps.<apex>` wildcard certificate by DNS-01 works with no sam-dns change.
- Box Caddy serves only `*.{SAM_DOMAIN}` (one label), so `*.apps.` needs its own site block.
- Workspace port previews through the tunnel: HTTP via celld → `resolveNodeAgentRoute` → lease origin
  → vm-agent `/workspaces/{id}/ports/{port}`; WebSockets via Caddy forward_auth to
  `/api/self-host/gateway/node-websocket` with `gatewayDecisionResponse` headers
  (`services/node-websocket-gateway.ts`, `caddy/sam.d/node-ws.caddy`).

## Design

1. `select` admits `nodeRole === 'deployment'` as well. Same lease, same frps plugin, same
   callback JWTs. Lease budget: one port per live node incarnation, shared by workspace and
   deployment nodes, from `REVERSE_TUNNEL_PORT_RANGE_*` (default 20000-29999, 10,000 ports), plus
   the existing reuse cool-down.
2. App DNS: the release callback writes each route's record into the box zone pointing at the
   **box** (`SAM_DNS_PUBLIC_IPV4`, now also a Worker var), not the node. Explicit records keep
   sam-dns's "unregistered app name is NXDOMAIN" property and reuse the existing writer and
   cleanup. Without DNS on the box, the operator's `*.SAM_DOMAIN` record already covers
   `*.apps.` and no record is written.
3. App ingress: box Caddy gets a `*.apps.{SAM_DOMAIN}` site (wildcard by the same DNS-01). Every
   request (HTTP and WebSocket) goes through forward_auth to a new
   `/api/self-host/gateway/app-route` decision. The Worker resolves hostname → environment → bound
   node, checks the hostname is a route target of that environment's latest release, and that the
   node is a live reverse-tunnel deployment node with an active lease. It answers with the lease
   upstream, the vm-agent URI `/deployment/app-ingress/<hostname>/<path>` and a short-lived
   short-lived app-ingress token (audience `node-app-ingress`, one node, one hostname) in
   `X-SAM-Upstream-Node-Authorization`. Caddy proxies through frps to the
   node's vm-agent.
4. vm-agent, only when `DEPLOY_APP_INGRESS=tunnel` (cloud-init sets it in reverse-tunnel mode):
   - node Caddy runs `auto_https off`, `default_bind 127.0.0.1`, `http_port <DEPLOY_APP_INGRESS_PORT>`,
     with `http://<hostname>` sites: no ACME, no public listener;
   - `/deployment/app-ingress/{hostname}/{path...}` authenticates the app-ingress token from
     the SAM header, refuses a hostname not in an active environment's applied routes, strips SAM
     headers, and proxies to node Caddy on loopback with `Host: <hostname>`.
5. Firewall: in reverse-tunnel mode the tunnel iptables script also drops 80/443, and the
   cloud-init bootstrap Caddyfile binds loopback; GCP does not get the app-route network tag
   (provider label `app-ingress=tunnel`).
6. Hosted: no extension is installed, cloud-init placeholders render empty outside reverse mode,
   the new label is never added, the vm-agent mode is off. Byte-identical.

## Threat model

- **Route authorization.** A hostname reaches a node only if: it is exactly
  `<label>.apps.<BASE_DOMAIN>`; the label's environment id names an environment whose
  `node_id` is the node; the hostname is a route target of that environment's latest release; the
  node is `transport='reverse-tunnel'`, role deployment, live, with an active lease on its current
  incarnation. The node side independently refuses a hostname that none of its applied routes
  carries, and node Caddy routes only exact applied hostnames to their own loopback host port.
  The client cannot choose the upstream, the port or the vm-agent path: they come from the
  Worker's decision, and Caddy strips client `X-SAM-*` headers first.
- **Cross-node / cross-project.** The node is taken from `deployment_environments.node_id`, never
  from the request. A hostname for environment A cannot be sent to environment B's node (the
  environment id is in the hostname and joined to its own node). The vm-agent checks the routed
  node id against its own id and the hostname against its own applied routes, so a
  decision for node X cannot be replayed through node Y's lease. Custom domains are not served on a
  box (the Worker only authorizes `*.apps.` names); follow-up idea 01M81E6FQQ4EFQJR4Y2J7BX4Y3.
- **App-ingress credential.** Purpose-limited (security review M1): audience `node-app-ingress`, one
  node, one hostname, `SELF_HOST_APP_INGRESS_TOKEN_TTL_SECONDS` (300 s). The agent accepts it only on
  that hostname's app-ingress route; the management API refuses it, and app ingress refuses a
  management token.
- **Compromised deployment node.** It holds the same per-node frp credential and node callback JWT
  as a workspace node today, and frps limits it to its one leased port (plugin plus `allowPorts`,
  `maxPortsPerClient = 1`). It can answer its own app hostnames with anything, which it can already
  do when hosted. It cannot bind another node's port, reach the box's loopback services (frp is
  reverse-only; it gets no visitor), or obtain TSIG material (DNS-01 runs only on the box). The
  management token minted per request is bound to that node (`node` claim, routed node-id check),
  uses the existing management-token expiry, and is stripped before the
  app sees the request. New trust boundary: none beyond "deployment nodes use the same tunnel trust
  as workspace nodes".
- **Callback auth (rule 34).** Deploy-release, route and event callbacks keep the node callback JWT
  and the existing routes; only their transport moves to the tunnel. The new gateway endpoint is
  box-internal: gateway secret header, 404 on the public listener (existing
  `@sam_gateway_internal` matchers).
- **L23 egress fence.** Unchanged: the Worker reaches nodes only at `127.0.0.1:<leasePort>`
  (`assertReverseTunnelUpstreamPort`). The box Caddy now also proxies to lease ports for app
  hosts, but only to the upstream the Worker's decision names, and the decision only names a
  lease port from the configured range.
- **App cookies.** An app can set cookies for its own host, as when hosted. Same trust as hosted.

## Implementation checklist

- [x] `transport.ts`: select deployment role; extension `appRouteAddress`
- [x] Release callback: route DNS target from the extension (box IP) for tunnel nodes; no node-IP requirement there
- [x] `boxDnsWorkerVars` passes `SAM_DNS_PUBLIC_IPV4`; Env type + docs
- [x] Provider label `app-ingress=tunnel` for reverse-tunnel deployment nodes; GCP skips app-route tag
- [x] Cloud-init reverse mode: drop 80/443, loopback bootstrap Caddyfile, `DEPLOY_APP_INGRESS=tunnel` env; hosted output byte-identical (test)
- [x] Worker app-route decision module + gateway endpoint
- [x] Box Caddy `*.apps.` site + `sam.d` app-route fragment
- [x] vm-agent config, Caddy tunnel mode, app-ingress handler, applied-route accessor
- [x] Tests: rule 74 divergence/convergence through the real resolver; cloud-init byte-identity; release-on-box provisions tunnel without Origin CA; route authorization through the real decision with foreign-node / foreign-project attack + owner control, each shown discriminating; Go handler tests
- [x] Docs: `deploy/selfhost/README.md`, `self-hosting.mdx` (remove the caveat once proven)
- [ ] Live proof on a disposable box (PENDING, in progress)
- [ ] Staging: hosted app deployment proof on "Deployment Test 1" (PENDING)
- [x] Follow-up ideas: custom domains on a box (idea 01M81E6FQQ4EFQJR4Y2J7BX4Y3)

## Acceptance criteria

- A release on a box provisions a deployment node with the tunnel, no Origin CA step, and reaches `applied`.
- The app URL resolves to the box and serves over HTTPS; the node has no public ingress; an unregistered
  hostname or another node's hostname is refused.
- Hosted: deployment nodes still select today's transport and the same cloud-init.

## Evidence

- Unit/integration: api 470 (selfhost, reverse-tunnel lifecycle, release callback, rule 74 pair), cloud-init 290
  (Cloudflare byte-identity snapshot unchanged), vm-agent deploy/config/server (`-race` on app ingress).
- Real box Caddy image: `pnpm selfhost:live-test caddy-fragments` 182 passed (3 new app-route cases).
- Discrimination: see the PR table (5 guards deleted, each reddened exactly its attack test).
- `SAM_DNS_PUBLIC_IPV4` is a box-only Worker var, read through `BoxDnsSettingsEnv` like `SAM_DNS_PROVIDER`
  (not in `apps/api/src/env.ts`: the Cloudflare Worker never has it).
- Live box proof: pending.
- Staging (hosted) proof: pending.
