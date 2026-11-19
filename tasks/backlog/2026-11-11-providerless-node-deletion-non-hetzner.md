# Providerless VM nodes on non-Hetzner providers cannot be deleted by SAM

## Problem

`reconcileStrictProviderlessVm` (`apps/api/src/services/strict-node-deletion.ts`) refuses every
node whose provider is not Hetzner: "provider inventory completeness is not guaranteed". A node
with no `provider_instance_id` therefore gets `409 Node runtime termination is not confirmed`
from `DELETE /api/nodes/:id` forever. The only way out is owner attestation
(`POST /api/nodes/:id/manual-deletion`). A user is not told that, and a platform-credential node
cannot use it at all ("contact an operator").

## Context

Found 2026-11-10 during the tunnel-hardening staging matrix
(`tasks/archive/2026-11-10-tunnel-transport-hardening.md`, row S1). GCP node
`01M73XZ9JPMCMEGPYCNEPCV62E` was created by direct provisioning with a deliberately tiny attempt
budget. Its create was recorded as requested but never accepted by GCP. That window is now closed
for durable creates (`ca425a898`), but any lost create response or GCP-side failure before the
instance identity is returned leaves the same providerless state. While the node lives, its
tunnel and `{nodeId}.vm` CNAME stay journaled as live.

## Acceptance Criteria

- [ ] GCP has a complete-inventory proof for one exact incarnation: a zone-scoped
      `instances.get` by the deterministic name `node-{id}` plus label match, or an aggregated
      list with all zones present and no `unreachable` warnings. Strict deletion uses it.
- [ ] Other providers either gain an equivalent proof or surface a user-visible
      "attest removal" action in the node UI, instead of a bare 409.
- [ ] A test per provider for: absent, present, and inventory-incomplete (stays refused).
