# Q8 integration map (read from code only, not run)

Read against `origin/main` at `cabd2fde8` (PR #2615 "managed VM Cloudflare Tunnel transport", merged
2026-11-10 12:23 UTC). Produced by a read-only code survey; line numbers are against that commit.
Anything marked *inferred* was not read in detail.

## 1. Control plane → node URL builders

`getNodeBackendBaseUrl` (`apps/api/src/services/node-agent-readiness.ts:19`) returns
`${VM_AGENT_PROTOCOL||https}://{nodeId}.vm.{BASE_DOMAIN}:${VM_AGENT_PORT||8443}`. It reads env only,
never the node row. #2615 replaced the old inline builders with calls to it:

| Call site | Purpose | How it fetches |
|---|---|---|
| `node-agent.ts:182` `nodeAgentRequest` | JSON calls (management JWT, `X-SAM-Node-Id`) | `fetchNodeAgent` |
| `node-agent.ts:911` `nodeAgentRawRequest` | event/metrics DB export | `fetchNodeAgent` |
| `node-agent.ts:931` `getWorkspacePortsOnNode` | port list | `fetchNodeAgent` |
| `node-agent-readiness.ts` `waitForNodeAgentReadyWith` | `/health` polling | injected `fetchNodeAgent` |
| `task-runtime-liveness-node-probe.ts:87` | liveness probe | raw `fetchWithTimeout` (:94) |
| `session-snapshot-upload-relay.ts:243` | relay upload URL (:389) | handed to another VM, not fetched by the Worker |
| `workspace-attachments.ts:39` | attachment upload | `fetchNodeAgent` |
| `workspace-file-transfer.ts:96` | file transfer | `fetchNodeAgent` |
| `routes/nodes/diagnostics.ts:135` | `/logs/stream` WebSocket | `fetchNodeAgent` |
| `routes/mcp/workspace-tools.ts:98,107` | MCP tool calls | `fetchNodeAgent` |
| `routes/projects/session-workspace-proxy.ts:186` | chat-session workspace proxy | `fetchNodeAgent` |
| `routes/workspaces/local-forward.ts:122` | local forward | `fetchNodeAgent` |
| `routes/node-lifecycle.ts:156` | returns `nodeAgentUrl` to the client | no web or CLI consumer found |
| `index.ts:625` | browser `ws-{id}` proxy | raw `fetch` |

Seam: `fetchNodeAgent` (`node-agent.ts:270`) already reads `nodes.runtime` from D1 per call
(`:290-296`) and rewrites `cf-container` nodes to `http://localhost:{port}` (`:310-313`). A
`reverse-tunnel` rewrite to `http://127.0.0.1:{leasePort}` fits there with no extra round trip if the
same query selects `transport` and the lease port. Outside that seam:
`index.ts:625` (runtime already loaded at `:430`; add the port to that query) and
`task-runtime-liveness-node-probe.ts:94`.

Breaks: the snapshot upload relay hands the node URL to a *different VM*; `127.0.0.1` on the box is
meaningless there. Disable relay selection for reverse-tunnel nodes (or route the relay through the
Worker). `node-agent.ts:245` "DNS record missing" 404 hint becomes irrelevant. `VM_AGENT_PROTOCOL/PORT`
are global, so mixed transports need the per-node rewrite. `index.ts:525,668` set
`X-Forwarded-Proto: https` (harmless). `local-forward.ts:245` reads `CF-Connecting-IP` (falls back to '').
No `cf:` fetch options on the node path. No SSRF guard on the node path (`fetch-timeout.ts:50`).

## 2. #2615 pieces: (a) unchanged, (b) small change, (c) Cloudflare-specific/replaced

- Transport selection: (b) `NodeTransport` (`packages/shared/src/types/workspace.ts:57`) add
  `'reverse-tunnel'`; (a) `nodes.transport` (`schema.ts:1704`, free text); (b)
  `resolveManagedNodeTransport` (`node-tunnel-config.ts:98`, already fails closed on unknown values);
  (b) resume branch `node-provisioning.ts:179-183` hard-codes `'cloudflare-tunnel'`.
- Creation: (c) `ensureNodeTunnelForProvisioning` (`node-tunnel-provisioning.ts:282`) + `ensureNamedTunnel`,
  `ensureTunnelCname`, `putTunnelIngress`, `getTunnelToken`, all of `cloudflare-tunnel-api.ts`,
  `buildNodeTunnelIngress` (`node-tunnel-config.ts:137`). Replaced by a port-lease allocation.
- Journal: (b) `node_cloudflare_tunnels` (migrations 0230/0231, `schema.ts:1771`) — keep the
  per-incarnation ownership shape, drop account/zone/DNS columns; a new table. (a) `LIVE_INCARNATION_SQL`
  (`node-tunnel-journal.ts:48`).
- Cleanup: (b) `runNodeTunnelCleanupSweep` (`scheduled/handler.ts:154`), `releaseNodeTunnels`
  (`strict-node-deletion.ts:234-236`, gated on `transport === 'cloudflare-tunnel'`), `settleNodeTunnels`
  (`node-provisioning.ts:677`), `releaseTunnelBeforeVm`. For reverse-tunnel: release the port lease and
  optionally kick the frps proxy (frps admin API); no Cloudflare calls.
- Provisioning: (a) skipping the public-IP wait and A record (`node-provisioning.ts:447,494`);
  (b) IP backfill keyed on `tunnelId` (`node-lifecycle.ts:414-417`); (b) Origin CA refusal keyed on
  `transport === 'cloudflare-tunnel'` (`node-lifecycle.ts:328`).
- Cloud-init: (a) `isTunnelMode` (`tunnel.ts:69`), firewall reapply (`template.ts:185`),
  `VM_AGENT_TUNNEL_ENABLED/PORT` (`template.ts:137`), `TUNNEL_FIREWALL_WRITE_FILE`
  (`template-ingress.ts:308`, drop-all-inbound still holds because frpc only dials out),
  `sam-wait-tunnel-listener` (`template-ingress.ts:131`); (b) `validateTunnelVariables` (`tunnel.ts:82`);
  (c) `CLOUDFLARED_RELEASES` (`tunnel.ts:17`), cloudflared runcmds and unit (`template-ingress.ts:88,119,131`),
  `tunnelReplacements` (`tunnel.ts:151`) → frpc equivalents; (b) boot-failure reasons (`node-boot-failure.ts:18`).
- vm-agent: all (a). `classifyTunnelIngress` (`tunnel_ingress.go:29`) marks tunnel-listener requests;
  `isRelayedRequest` (`proxy_guard.go:45`) removes loopback trust for them (git credential helper,
  `git_credential.go:397`); `newTunnelServer` (`:65`) binds `127.0.0.1` only; `isOwnListenerPort` (`:143`).
  frpc → `127.0.0.1:8444` is the same shape as cloudflared, so the safety argument transfers.

## 3. Files a `reverse-tunnel` transport would touch

- Shared: `packages/shared/src/types/workspace.ts:57`.
- D1: new additive migration + `schema.ts` table, e.g. `node_reverse_tunnel_leases(node_id,
  runtime_incarnation_id, port UNIQUE, status, …)`; the UNIQUE index on `port` is the atomic allocator.
- API: new `services/node-reverse-tunnel-*.ts` (allocate/release/sweep); `node-tunnel-config.ts`;
  `env.ts:1181` (transport, port range, frps address); `node-agent.ts:270`; `index.ts:430/625`;
  `task-runtime-liveness-node-probe.ts:87`; `session-snapshot-upload-relay.ts`.
- frps plugin endpoint: new callback-only route (mounted before `/api/nodes` session routes, rule 34).
  frps posts credentials in the JSON body (`content.metas`), not an `Authorization` header, so it calls
  `verifyCallbackToken(token, env, {expectedScope:'node'})` (`jwt.ts:312`) directly, checks
  `payload.workspace === nodeId`, node status, and on NewProxy `remote_port === lease.port`.
  Token expiry risk: node callback JWTs expire (`CALLBACK_TOKEN_EXPIRY_MS`) and renew only via heartbeat
  (`node-lifecycle.ts:581`). A token written once into frpc config fails Login on any reconnect after
  expiry → either the vm-agent rewrites the frpc token file and reloads frpc, or use a dedicated
  long-lived per-node frp credential (hash stored on the lease row).
- Provisioning: `node-provisioning.ts:183,268,276`; `node-provisioning-cloud-init.ts:59,88`.
- Lifecycle/cleanup: `strict-node-deletion.ts:234`, `scheduled/handler.ts:154`, `node-lifecycle.ts:328,414-417`.
- Cloud-init: `tunnel.ts`, `template-ingress.ts`, `variables.ts`, `validate.ts`, `generate.ts`. frpc
  binary: pinned GitHub download + sha256 like cloudflared, or shipped via `/api/agent/download`
  (`template.ts:72`) and `scripts/deploy/publish-vm-agent-artifacts.sh` (*inferred*).
- vm-agent: no change.
- Deploy: `sync-wrangler-config.ts`, `worker-var-defaults.ts`, `wrangler_sync_env` in
  `deploy-reusable.yml`. frps itself lives on the box, outside this repo's deploy.

## 4. vm-agent TLS-on-8443

Defaults to 8080 (`config_load.go:71`); TLS only when `TLS_CERT_PATH` and `TLS_KEY_PATH` are set
(`:392`); 8443 and Origin CA come from cloud-init when `originCaCertificateUrl` is set
(`generate.ts:58-59`, `template-ingress.ts:12`). #2615 omits the Origin CA URL for tunnel nodes
(`node-provisioning-cloud-init.ts:59`), validation rejects it with a tunnel token (`tunnel.ts:82`), the
server refuses issuance (`node-lifecycle.ts:328`), and the tunnel listener is plain HTTP on loopback.
Reverse-tunnel reuses this unchanged.

## 5. Node → control plane

`controlPlaneUrl` must be `https://` (`cloud-init validate.ts:30,94`), so the box needs a public TLS
endpoint nodes can reach (Caddy in front of celld). This is the same endpoint frpc can use over wss (Q6).
