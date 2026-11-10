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

## Acceptance criteria

- [ ] The first tunnel-provisioning failure (tunnel create, ingress, DNS, token) is recorded in `node_cloudflare_tunnels.last_error` and logged at error level with the node and incarnation.
- [ ] The root cause on staging is identified and fixed, and a staging workspace VM provisions with tunnel transport and heartbeats.
- [ ] A provisioning retry after a failed tunnel create either reuses or cleanly replaces the journal row, instead of failing on the cleanup fence.
- [ ] `node-tunnel-races.test.ts` controls its own ordering, so it cannot flake on slow runners (rule 62).
