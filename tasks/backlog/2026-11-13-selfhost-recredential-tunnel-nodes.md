# Re-credential live reverse-tunnel nodes after an ENCRYPTION_KEY rotation

## Problem

A reverse-tunnel node's frp credential is `HMAC(ENCRYPTION_KEY, label|leaseId|nodeId|incarnation)`
(`apps/api/src/services/node-reverse-tunnel-config.ts` `deriveReverseTunnelCredential`), delivered
once in cloud-init; the lease row stores only its SHA-256 and frps logins compare that hash
(`node-reverse-tunnel-authz.ts`). After `pnpm selfhost:secrets rotate encryption-key`, leases created
before the switch keep a credential derivable from the old (exposed) key. Whoever holds the old key
and an old backup (lease, node and incarnation ids) can log in to frps as such a node and receive
its traffic, until the node is replaced. The rotation reports the count
(`scripts/selfhost/rotate-steps-data.ts` `recordLegacyTunnelLeases`) but cannot fix it.

## Context

Found by the security review of the self-host key rotation (task K2, draft PR against
`sam/selfhost-pass-2`, finding H2). Fixing it needs the VM agent to accept a new credential over an
already-authenticated channel (rollout-coupled, `packages/vm-agent/.claude/rules/54`).

## Acceptance Criteria

- [ ] The control plane can issue a fresh random credential for a live lease and deliver it to the
      node over an authenticated channel (e.g. the heartbeat response), and the node reconnects frpc
      with it; the lease's `credential_hash` moves in the same step.
- [ ] Old agents keep working with their existing credential (rollout compatible).
- [ ] `rotate encryption-key` re-credentials every lease created before the switch, and only reports
      nodes whose agent cannot take a new credential.
- [ ] Tests: a lease credential derived from the old key is refused after re-credentialing; a live
      node keeps its tunnel through the change.
