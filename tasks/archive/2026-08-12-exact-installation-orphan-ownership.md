# Exact-Installation Ownership for Provider Orphan Reconciliation

## Status

Complete on `sam/prevent-orphan-reconciliation-deleting-behv24` at PR #1814.
Initial implementation head: `598af0d57b1a282668744d3c64bde7f0a8ca89e6`.
The PR remains open and unmerged.

## Source

- Strict backend audit task: `01KZSZ5HDBARX61Q0PCASP1650`
- Audit session: `c9487e09-e90d-4e46-84af-f8ecf30f178c`
- Finding: OR-01, “Orphan reconciliation can delete another SAM installation’s live servers” (High, 99%, destructive ship blocker)
- Implementation task: `01KZTE3A44SKSNHSWZ66BEHV24`

## Problem

Provider-side orphan reconciliation currently selects servers using only the global
`managed=simple-agent-manager` label and an environment label. Two SAM installations
that share one provider account and use the same environment therefore discover each
other's servers. Since each installation has a different D1 database, the sibling
installation's live servers appear absent and become deletion candidates after the
grace period.

Provider-account access, a SAM-like name or prefix, and absence from one installation's
D1 inventory are not ownership proof. The destructive boundary must require positive,
exact installation identity and control-plane scope.

## Preflight

- Current branch and output branch: `sam/prevent-orphan-reconciliation-deleting-behv24`
- Current `HEAD` equals current `origin/main`: `fc1e394217248c3bd004b2e6619cf2344eade7e3`
- SAM task search (current 50 plus focused searches): no active duplicate
- GitHub open PR search: no duplicate implementation
- Historical related work was reviewed, including the original reconciliation task and
  failed/closed investigations; none provides this exact-installation guard.

### Classification

- Security-sensitive destructive infrastructure path
- Cross-component change: Pulumi output → generated Worker config → provisioning labels
  → provider discovery → D1 claim validation → provider deletion
- External provider boundary change, no public API contract change
- Clean-install and upgrade compatibility change, no D1 migration
- Canonical public documentation synchronization required

## Reverified Current Data Flow

1. `infra/` and `scripts/deploy/sync-wrangler-config.ts` generate environment and
   resource-prefix values, but no per-installation server ownership identity.
2. `apps/api/src/services/nodes.ts` provisions every supported VM provider with labels
   from `node-provider-labels.ts`: `managed`, `node`, `role`, and `env` only.
3. All seven providers preserve/filter arbitrary labels or tags: Hetzner, Scaleway,
   GCP, Vultr, UpCloud, DigitalOcean, and Infomaniak.
4. `provider-orphan-reconciliation.ts` lists by `managed` plus `env`, applies age and
   node-label checks, then compares provider node labels to this installation's D1.
5. An absent row or terminal row authorizes `provider.deleteVM(server.id)`.
6. Other `deleteVM` call sites start from an explicit D1 node/provider instance and do
   not classify resources from provider discovery plus local absence. The scheduled
   provider-orphan reconciler is the only destructive absence-based entry point.

## Root Cause and Prevention

The original reconciliation implementation correctly recognized that environment-only
selection was needed to separate SAM staging and production, but treated that
environment label as installation identity. Review and tests exercised two environments
sharing one provider account, not two installations using the same environment. Public
configuration documentation then repeated the unsafe assumption.

Timeline:

1. `50af27fac` introduced provider-side orphan reconciliation and environment labels.
2. The implementation and tests established `managed + env + D1 absence` as sufficient.
3. OR-01 independently identified the same-environment, cross-install deletion path.
4. Current `origin/main` was reverified and remains vulnerable.

Bug class: destructive external-resource reconciliation without an exact, stable owner
identity. A durable repository rule will require explicit same-prefix/same-environment
multi-installation tests for future destructive provider discovery.

## Design

### Installation identity

- Create a protected 16-byte Pulumi `RandomId` once per Pulumi stack and export its
  lowercase 32-character hex value as `installationId`.
- Generated Worker configuration injects it as `SAM_INSTALLATION_ID`; operators do not
  supply a new GitHub variable or secret.
- The ID is independent of `RESOURCE_PREFIX`, so separately managed installations remain
  distinct even when a prefix or account is reused.
- Missing or malformed identity keeps normal provisioning compatible but omits the
  ownership label and disables destructive provider-side orphan reconciliation.

### Provider ownership proof

- New provider servers carry an `installation` label in addition to the existing label
  contract.
- Discovery filters server-side by `managed + env + installation` and revalidates all
  three labels client-side before inventory lookup, then re-reads the resource and
  verifies label plus immutable identity continuity immediately before deletion.
- Missing, ambiguous, or foreign ownership is preserved. Non-owning metadata surfaced
  to reconciliation is counted and logged as a sanitized summary; names, prefixes,
  account membership, and local D1 absence never substitute for the installation label.

### Inventory and deletion proof

- Query D1 through a requested-ID left join so every candidate has an explicit found or
  absent result. Validate exact cardinality and shape at the storage boundary and abort
  the entire run on partial, malformed, duplicate, failed, or ambiguous inventory data.
- Preserve any non-terminal claim, including future/unknown states.
- A missing row remains deletion-eligible only after exact provider ownership, valid node
  identity, and grace expiry are established.
- A terminal row with a conflicting provider instance ID is ambiguous and must be
  preserved.
- Provider deletion remains bounded, sequential, retryable, and idempotent under the
  existing provider contract.

### Compatibility

- Upgrade: the next Pulumi update creates one stable identity without changing D1 or
  existing VMs. Legacy VMs have no trustworthy marker and remain permanently protected;
  newly provisioned VMs participate in normal orphan cleanup.
- Clean install: Pulumi creates the identity before Wrangler configuration is generated,
  so every new VM is attributable without manual configuration.
- Lost/recreated state or local/manual deployment without identity fails closed; it never
  guesses ownership from a prefix or legacy labels.
- No API/config removals, no required user-supplied setting, no blanket cleanup disable,
  and no provider-specific ownership behavior.

## Control-Loop Load Review

- Invocation frequency and KV gating are unchanged.
- One provider list call remains; the additional label narrows results.
- One batched D1 query remains; selected columns increase only by provider instance ID.
- Confirmed successful provider deletions remain capped by
  `PROVIDER_ORPHAN_DESTROY_LIMIT`, preserving the pre-existing retry behavior after
  individual provider errors.
- Same-install deletion candidates escape through idempotent provider deletion; transient
  failures retry on a later eligible run. Young resources escape after grace expiry.
- Foreign and legacy resources intentionally remain outside this destructive loop because
  they lack sufficient ownership proof.

## TDD and Validation Checklist

- [x] Failing label/identity unit tests written before implementation
- [x] Failing generated-config/Pulumi clean-install and upgrade tests written first
- [x] Two installations sharing one provider account, same environment, different IDs
- [x] Same and different resource/name prefixes cannot affect ownership
- [x] Legacy/unlabeled resources never reach `deleteVM`
- [x] Foreign identity and malicious/colliding names never reach `deleteVM`
- [x] Missing/malformed installation identity skips before provider discovery
- [x] Missing, failed, malformed, duplicate, and conflicting D1 evidence fails closed
- [x] Grace expiry, interval gating, destroy limit, retries, and idempotency preserved
- [x] Legitimate same-install missing-row and terminal-row orphans are deleted
- [x] Provider label/tag portability covered for all seven providers
- [x] Dry-run assessed (none exists; no new behavior introduced)
- [x] Focused API/provider/infra/deploy tests green
- [x] Full repository quality gates green
- [x] Task completion validator passes
- [x] Mandatory specialist and independent adversarial review findings resolved
- [x] Canonical public docs describe upgrade and operator-visible skip semantics
- [x] Exactly one non-draft PR opened against current `main`
- [x] CI reaches terminal green with no red or pending checks

## Explicit Constraints

- Do not merge.
- Do not deploy to or mutate staging.
- Do not disable legitimate exact-install orphan cleanup.
- Do not add unrelated provider refactors.

## Review Evidence

- Test engineer: approved after real raw-response-to-delete vertical tests for all seven
  providers, full final-ownership branch coverage, persistent-KV retry coverage, both
  terminal states, and realistic provisioning fixtures.
- Security auditor: approved after requiring literal D1 success metadata and re-reading
  exact provider ownership immediately before deletion.
- Fresh adversarial security reviewer: approved after requested-ID left-join inventory
  made successful partial D1 results non-authoritative, duplicate ownership metadata was
  classified as ambiguous, and GCP numeric-ID-to-name deletion was exercised realistically.
- Provider-path reviewer: approved all seven create/list/get/delete encodings and actual
  provider-specific destructive HTTP boundaries.
- Cloudflare specialist: approved protected Pulumi identity, deploy order, dry-run,
  clean-install, upgrade, state-loss, keep-data, and full-teardown semantics.
- Constitution validator: approved after destructive orchestration was split into
  sub-500-line focused modules with every function under 50 lines.
- Environment validator: approved generated/non-secret naming, validation, precedence,
  workflow mapping, and clean-install/upgrade consistency.
- Documentation sync validator: approved after the teardown input description was aligned
  with preservation of D1, installation identity, and generated keys.

## PR and CI Evidence

- PR: https://github.com/raphaeltm/simple-agent-manager/pull/1814
- Initial implementation head: `598af0d57b1a282668744d3c64bde7f0a8ca89e6`
- Terminal implementation rollup: 18 successful, 8 expected path-based skips,
  0 cancelled, 0 failing, and 0 pending.
- Staging was explicitly prohibited and was not deployed or mutated.
- The PR was not merged.
