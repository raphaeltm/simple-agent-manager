# Staging workspace VMs fail with "Tunnel for this node incarnation is already being cleaned up"

## Problem

On 2026-11-10, after deploying `sam/state-machine-defect-fixes` to staging (run 42887011701), two
workspace VMs failed to provision, at 19:56 and 20:00 UTC. Both workspaces were in Potato
(`01KWHD8XS7MQ7R6KWXJYRHDVH4`), on Hetzner nbg1 cx33. Each failed within about 35 seconds:

- `nodes.error_message`: `[hetzner] Tunnel for this node incarnation is already being cleaned up`
  (`services/node-tunnel-provisioning.ts`, `journalTunnelOwnership`)
- `node_cloudflare_tunnels`: `status = cleanup_pending`,
  `cleanup_reason = provisioning_failed_before_vm`, `tunnel_id = NULL`, `last_error = NULL`,
  `pending_create_count = 1`

The tunnel create, or an earlier provisioning attempt for the same incarnation, failed. The
journal was then released, and the retry hit the "already being cleaned up" fence.

**The original error is never recorded.** It is missing from `platform_errors`, from
`last_error`, and from a live `wrangler tail`. The tail shows only `node_provisioning.failed`
with the masking message.

Production is unaffected: its nodes provision normally on #2615 code, which suggests production
does not set `VM_AGENT_TRANSPORT=cloudflare-tunnel`.

Separately, CI showed `tests/unit/services/node-tunnel-races.test.ts > does not finalize cleanup
while an acknowledged create is still in flight` failing on run 42894614942. It passes 3/3
locally, so it is timing-sensitive.

## Context

- Introduced with #2615 (managed VM Cloudflare Tunnel transport).
- Staging sets `VM_AGENT_TRANSPORT=cloudflare-tunnel`.
- Every staging workspace VM is blocked by this, which also blocked live verification of PR #2627 (D3, D8).

## Likely root cause

Traced by the tunnel status agent (task 01M73DYVFKDZH35ZTF7HZ9ZWJ1); the timeout, release and
rethrow lines below are confirmed in code. It covers every symptom, but no single run was
traced end to end on staging.

1. Direct provisioning (`POST /api/workspaces` needing a new node, or `POST /api/nodes`, then
   `NodeLifecycle` `node-lifecycle-provisioning.ts`) wraps the whole `provisionNode` call in a
   per-attempt abort of `DEFAULT_NODE_PROVISIONING_REQUEST_TIMEOUT_MS = 5_000`. It retries every
   `DEFAULT_NODE_PROVISIONING_RETRY_INTERVAL_MS = 30_000`.
2. Tunnel transport adds about 6-7 sequential Cloudflare calls before the Hetzner `createVM` (list
   tunnels, create tunnel, put ingress, list DNS, create CNAME, get token), so the first attempt
   is aborted partway through the tunnel create.
3. The catch in `services/node-provisioning.ts` (~line 549) runs `releaseTunnelBeforeVm` on a fresh
   allocation. That moves the journal row to `cleanup_pending` / `provisioning_failed_before_vm`.
4. `rethrowIfProviderRequestAborted` (~line 558) rethrows before the
   `log.error('node_provisioning.failed')` / persist block, so the abort cause is never recorded.
5. The durable retry about 30s later resumes the same incarnation. `journalTunnelOwnership` then
   finds `cleanup_pending` and throws "already being cleaned up". The retry can never succeed.
6. Task and chat runs go through the TaskRunner, which passes no abort signal. That is why tunnel
   transport works for chats and #2615's staging sweep passed.

**Production risk:** enabling `VM_AGENT_TRANSPORT=cloudflare-tunnel` in production would break
direct workspace and node creation the same way. Do not enable it until this is fixed.

## Acceptance criteria

- [ ] The first tunnel-provisioning failure (tunnel create, ingress, DNS, token) is recorded in `node_cloudflare_tunnels.last_error` and logged at error level with the node and incarnation.
- [ ] The root cause on staging is identified and fixed, and a staging workspace VM provisions with tunnel transport and heartbeats.
- [ ] A pre-VM journal row is not released while a durable allocation can still resume that incarnation, or the resume can re-own or replace it, so a retry converges instead of failing on the cleanup fence.
- [ ] Tunnel steps resume across attempts instead of relying only on a larger 5s budget. State the throughput (rule 81).
- [ ] A regression test drives `scheduleDirectProvisioning` with `VM_AGENT_TRANSPORT=cloudflare-tunnel`, a Cloudflare create slower than the attempt deadline, and the retry, and asserts it converges.
- [ ] `node-tunnel-races.test.ts` controls its own ordering, so it cannot flake on slow runners (rule 62).
