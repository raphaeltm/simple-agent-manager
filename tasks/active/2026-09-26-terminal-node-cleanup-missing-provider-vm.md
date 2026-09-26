# Terminal node cleanup for missing provider VMs

## Problem

During the 2026-09-25 Hetzner quota incident, five production nodes were left in
`destroying` for more than a day. Production D1 read-only evidence showed each
row was a managed Hetzner workspace VM with `provider_instance_id IS NULL`,
`runtime_termination_confirmed_at IS NULL`, no IP/DNS record, exact placement
credential proof present, and hourly cleanup backoff updates. Hetzner never
created these servers, so retrying provider deletion can never make progress.

## Research Findings

- `apps/api/src/services/strict-node-deletion.ts` only accepted a providerless
  managed VM when `runtime_termination_confirmed_at` already existed.
- `apps/api/src/scheduled/node-cleanup/shared.ts` required
  `provider_instance_id` in cleanup provenance, which excluded already-claimed
  `destroying` rows with no provider ID.
- `apps/api/src/scheduled/node-cleanup/node-phases.ts` had no phase dedicated to
  stale `destroying` handoff rows.
- Existing cleanup terminal state for this path is `nodes.status = 'deleted'`
  plus `runtime_termination_confirmed_at`, with workspace lifecycle finalization
  after proof.
- Provider 404 from `deleteVM` is already treated as an idempotent successful
  provider absence by provider implementations; ambiguous provider failures still
  throw and are backed off by cleanup.

## Checklist

- [x] Add a bounded cleanup phase for stale `destroying` managed workspace nodes.
- [x] Admit already-`destroying` rows with no provider ID only when the rest of
      the managed VM provenance is present.
- [x] Let strict deletion write termination proof for claimed `destroying` VM
      rows with no provider ID.
- [x] Preserve fail-closed behavior for creating/in-flight rows with no provider
      ID and transient provider errors.
- [x] Add unit/vertical tests for never-created cleanup and transient-error retry.
- [x] Run relevant tests and full quality gates.
- [x] Run specialist review gates.
- [ ] Verify on staging with real provisioning and cleanup where feasible.

## Acceptance Criteria

- A managed VM node already in `destroying` with no provider instance ID reaches
  terminal cleanup, writes `runtime_termination_confirmed_at`, releases DNS, and
  finalizes workspace records.
- A provider delete 404/not-found path remains terminal because the provider
  implementation treats it as idempotent absence.
- Transient or ambiguous provider deletion errors still back off and retry.
- User-owned and deployment nodes remain excluded from cleanup.
