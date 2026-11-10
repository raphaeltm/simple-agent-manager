# Managed Cloudflare Tunnel provisioning and deletion lifecycle (API slice)

Child task `01M7272SZ33K1C9ED60CRQC5N7` of parent `01M719ZRT6MJX696B9FH8TBWX9`
(channel `feature.vm-tunnels-staging`). Branch `sam/implement-managed-cloudflare-tunnel-rqc5n7`,
based on `sam/where-did-get-terms-8tbwx9` @ `7b2a78048`. The parent owns Env/wrangler/docs
wiring, caller transport, staging deployment, the live E2E, the PR and the merge. Sibling
`01M7271R6RNECJGDK1T01XP2A0` owns the Go agent and cloud-init.

## Problem

`VM_AGENT_TRANSPORT='cloudflare-tunnel'` must give each NEW managed workspace VM node an
outbound-only, remotely configured named tunnel, reached through the existing
`{nodeId}.vm.{BASE_DOMAIN}` hostname as a proxied CNAME to `{tunnelUUID}.cfargotunnel.com`.
Tunnel, connectors and DNS must be deleted on node deletion and on every failure path,
including failures before the VM exists, cancellation and capacity rejection. Cleanup
failures must stay retryable without losing the resource identity, and a stale cleanup must
never delete a replacement incarnation's resources.

## Research findings

- `nodes.transport/tunnel_id/tunnel_name` already exist (migration 0097, BYO phase 0). The
  heartbeat route already skips IP/A-record backfill when `tunnel_id` is set
  (`routes/node-lifecycle.ts`, covered by `tests/unit/routes/node-lifecycle-byo.test.ts`),
  and Origin CA issuance is refused for `transport='cloudflare-tunnel'`.
- Node rows are hard-deleted on several paths (`provisionNode` rejected allocations,
  `provisioning-authority.ts`, the TaskRunner rejected-node helper, `routes/nodes/delete.ts`),
  so tunnel identity cannot live only on the node row. A separate journal with no FK is
  needed.
- Strict node teardown deletes backend DNS best-effort and discards the failure. That is
  unsuitable for tunnels, which need a durable retryable record.
- Cloudflare API (developers.cloudflare.com/api, checked 2026-11-10): `POST
  /accounts/{a}/cfd_tunnel` `{name, config_src:'cloudflare'}`, `GET .../cfd_tunnel?name=&is_deleted=false`,
  `GET .../{id}/token`, `PUT .../{id}/configurations` `{config:{ingress}}`, `DELETE
  .../{id}/connections`, and `DELETE .../{id}`, which requires no active connections. The docs
  do not say tunnel names are unique, so lost-response recovery adopts only an exact name
  match and refuses when more than one matches.
- The staging experiment showed the POST response includes a token. We still fetch it from
  `/token` so a resumed or retried run can rebuild cloud-init without persisting it.
- Sibling contract v1 (channel seq 2): tunnel mode refuses `originCaCertificateUrl`. Variables
  are `cloudflareTunnelToken`, `cloudflareTunnelPort` (default 8444, must differ from
  vmAgentPort) and `cloudflaredVersion` (must be pinned). The token is in user-data.

## Implementation checklist

- [x] Migration `0230_node_cloudflare_tunnels.sql` + `schema.nodeCloudflareTunnels` journal
      (statuses provisioning/active/cleanup_pending/cleaned; unique per incarnation and name).
- [x] `cloudflare-tunnel-api.ts`: client; bounded retries only for idempotent calls; errors
      carry status/codes only; cancellation surfaces as the caller's reason.
- [x] `node-tunnel-config.ts`: transport selection (fail closed on unknown value; workspace
      VM managed only), port validation, deterministic name, ingress (catch-all 404).
- [x] `node-tunnel-provisioning.ts`: journal before any mutation (fenced INSERT…SELECT on the
      live incarnation), adopt-or-create tunnel with lost-response recovery, ingress, CNAME
      with conflict adoption and superseded-incarnation cleanup, token for cloud-init only.
- [x] `node-tunnel-cleanup.ts`: content-fenced DNS delete, connectors + tunnel delete, backoff,
      `settleNodeTunnels` (per node) and `runNodeTunnelCleanupSweep` (cron).
- [x] `provisionNode`: tunnel before createVM; no IP wait/A record for tunnel nodes; release on
      pre-VM failure and cancellation; settle after rejection/deleted row; keep tunnel when a
      VM may exist.
- [x] `deleteNodeResourcesStrict`: release/clean after runtime termination proof (VM only).
- [x] Cron wiring `node_tunnel_cleanup` (isolated sweep) with completion-log counters.
- [x] File-size splits: `node-provisioning-cloud-init.ts`, `-predicates.ts`,
      `-race-cleanup.ts`; `strict-node-deletion-shared.ts`; writer-inventory allowlist updated.
- [x] Vertical-slice tests (real SQLite + shipped migration, real provisioning/deletion code,
      stateful fake Cloudflare): `tests/unit/services/node-tunnel-lifecycle.test.ts`.

## Deliberate exclusions

- Deployment-role nodes stay `vm-public-dns`. They serve public app routes on their own IP, and
  converting them is outside this slice's coordinated scope.
- Instant (cf-container) never selects tunnel transport. Strict teardown does not touch the
  journal for containers (tested).
- User-owned (BYO) enrollment tunnels are unchanged.

## Requests to parent

- Add `VM_AGENT_TRANSPORT`, `VM_AGENT_TUNNEL_PORT` and `CLOUDFLARED_VERSION` to `Env`. These
  modules read them through a narrow local interface (`TunnelTransportEnv`) until then.
  Optional knobs, read the same way: `NODE_TUNNEL_CLEANUP_REQUEST_TIMEOUT_MS`,
  `NODE_TUNNEL_CLEANUP_BATCH_SIZE`, `NODE_TUNNEL_CLEANUP_BACKOFF_BASE_MS` and
  `NODE_TUNNEL_CLEANUP_BACKOFF_MAX_MS`.
- `CF_API_TOKEN` needs account Cloudflare Tunnel Write plus zone DNS Edit (installer/permissions).
- The caller transport for tunnel nodes must not use the public IP. `nodes.ip_address` is still
  recorded for diagnostics only.

## Acceptance criteria → evidence

| Criterion | Test (node-tunnel-lifecycle.test.ts) |
| --- | --- |
| Journal + tunnel + DNS before VM; token only in cloud-init, never stored or logged | "journals and builds the tunnel before the VM exists…" |
| Legacy and deployment nodes unchanged | "keeps legacy public-IP…", "excludes deployment-role nodes…" |
| Instant never touches tunnels | "never selects tunnel transport…", "Instant container teardown never…" |
| Lost create/DNS responses and transient retries | "adopts a tunnel whose create response was lost…", "retries transient failures…" |
| Durable resume reuses the tunnel | "a durable resume of the same incarnation…" |
| Create, config and token failure → cleaned, no VM | `it.each` in "failures before the VM exists" |
| DNS conflict leaves the foreign record | "DNS conflict with a foreign record…" |
| Cancellation → pending, then the sweep cleans it | "cancellation during tunnel creation…" |
| Capacity rejection → cleaned | "a provider capacity rejection…" |
| Ambiguous createVM keeps the tunnel across two sweeps | "an ambiguous createVM failure keeps the tunnel…" |
| Node deletion order (DNS → connectors → tunnel) | "strict deletion removes the VM…" |
| Retryable failure with backoff, no hammering | "a failed Cloudflare cleanup stays pending…" |
| Stale cleanup never touches the replacement | "a replacement incarnation cleans the stale one first…" |
| Account mismatch fails closed | "fails closed when the configured Cloudflare account…" |
| Live node never released | "a live node is never released by the sweep" |

Discrimination checks (each guard deleted once, then restored):

- DNS content fence removed → the replacement test went red.
- `runtime_termination_confirmed_at IS NULL` removed from the live predicate → 3 deletion tests
  went red.
- Pre-VM release applied regardless of VM request → the resume, capacity and ambiguous tests
  went red.
- Lost-response adoption removed → the adopt test went red.

## Remaining (parent-owned)

Real staging E2E: an actual managed VM, an agent serving port 3000 through the tunnel with the
origin's inbound access blocked, node deletion removing the tunnel and DNS, and an Instant
regression run.
