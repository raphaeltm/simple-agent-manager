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
- A null provider ID does not itself prove absence: provider creation can succeed
  before its ID is persisted. Only a definite provider rejection can write
  absence proof for a concurrent `destroying` claim. Ambiguous responses stay
  unproven and require reconciliation.
- Provider 404 from `deleteVM` is already treated as an idempotent successful
  provider absence by provider implementations; ambiguous provider failures still
  throw and are backed off by cleanup.

## Checklist

- [x] Add a bounded cleanup phase for stale `destroying` managed workspace nodes.
- [x] Admit already-`destroying` rows with no provider ID only when the rest of
      the managed VM provenance is present.
- [x] Persist exact-incarnation termination proof after a definite provider
      rejection, including when deletion already claimed the row.
- [x] Require that proof before a providerless `destroying` row enters cleanup.
- [x] Exclude active workspaces before the bounded candidate page.
- [x] Preserve fail-closed behavior for creating/in-flight rows with no provider
      ID and transient provider errors.
- [x] Add unit/vertical tests for never-created cleanup and transient-error retry.
- [x] Run relevant tests and full quality gates.
- [x] Run specialist review gates.
- [x] Provision and delete a real staging VM; confirm zero active staging nodes.
- [x] Exercise the exact rejected-create plus concurrent destroying state on
      staging, or document why the live provider cannot safely induce it.
  - _Reconciled 2026-09-30:_ documented in PR #2157: the live Hetzner API cannot safely be made to reject at that race point; the exact interleaving is covered by a vertical SQLite/provider test (mocked Hetzner 412 while the row moves to `destroying`, then the real sweep finalizes it). Raphaël accepted the limitation on 2026-09-27.

## Acceptance Criteria

- A managed VM node already in `destroying` with no provider instance ID reaches
  terminal cleanup only after exact-incarnation provider rejection proof exists;
  it releases DNS and finalizes workspace records.
- A providerless `destroying` row without that proof remains unfinalized.
- A provider delete 404/not-found path remains terminal because the provider
  implementation treats it as idempotent absence.
- Transient or ambiguous provider deletion errors still back off and retry.
- User-owned and deployment nodes remain excluded from cleanup.

---

_Reconciled 2026-09-30 (weekly queue reconciliation): shipped via PR #2157 (`8880c8761`, merged 2026-09-27), first successful production deploy run 36294521255. The five legacy production rows this did not clear were handled by the follow-up `2026-09-27-fix-ghost-destroying-node-sweep.md` (PR #2163)._
