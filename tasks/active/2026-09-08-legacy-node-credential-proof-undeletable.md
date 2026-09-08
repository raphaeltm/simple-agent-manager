# Pre-0142 nodes are permanently undeletable (strict teardown requires a backfill-proof column)

Status: in progress
Created: 2026-09-08
Production incident node: `01M1RKXS5YT0AEAD84872MNN2E`

## Problem

A production node could not be deleted from the UI. Repeated delete attempts failed, and manually
destroying the Hetzner server from the provider console did not help — the row stayed visible at
`status='destroying'` forever.

## Root cause

`requireStrictNodeProvider` (`apps/api/src/services/strict-node-deletion.ts`) refused teardown
whenever `placement_credential_fingerprint` was NULL, **before** resolving the provider:

```ts
if (!targetProvider || !exactCredential?.credentialFingerprint) {
  throw new Error(`Cannot strictly delete node ${node.id}: exact provider credential binding is missing`);
}
```

That column was added by migration `0142` in PR #2019. The migration deliberately leaves existing
rows NULL, and there is no backfill path — the whole point of a content fingerprint is that it
cannot be reconstructed after the fact. So every node that was alive across the deploy boundary
became undeletable for the rest of its life.

Timeline for the incident node:

| Time (UTC, 2026-09-05) | Event |
| --- | --- |
| 11:05:42 | Node provisioned — fingerprint column not yet deployed |
| 13:37:54 | PR #2019 merged (`94ae09f75`) |
| ~15:45 | Deployed to production |
| 15:45:42 | First `exact provider credential binding is missing` |

**The gate was stricter than the resolver it guards.** `exactCredentialGenerationMatches`
(`provider-credential-exact.ts`) already has an explicit null-fingerprint fallback that compares
`credentialVersion`. The incident node's persisted version (`1770544753719`) matched credential
`01KGYB1V1QX1CQCSTZTQ29YA6T`'s `updated_at` (`2026-02-08T09:59:13.719Z`) exactly, and that
credential is still active and still Hetzner. Valid, rotation-detecting proof existed; the early
throw made the resolver's own fallback dead code on the teardown path.

The manual Hetzner deletion was irrelevant: `hetzner.ts` already treats a 404 from `deleteVM` as
idempotent success. SAM never reached the provider call.

## Production evidence

- 71 failures with this exact signature (`platform_errors`, sam-observability-prod), first
  `2026-09-05T15:45:42Z`, latest `2026-09-08T16:50:59Z`.
- Retries hourly forever: `cleanup_backoff_until` rolls forward each attempt, and neither
  `sweepMaxLifetimeNodes` nor `destroyNodeForCleanup` caps attempts.
- Row pinned at `status='destroying'` because `stopNodeResources` claims the node into
  `destroying` and then throws without releasing the claim.
- Blast radius: exactly one affected node. Two other live NULL-fingerprint nodes
  (`01KXAR1T3XCQKKPBEJEERQ2PSZ`, `01M1015FQ9D772EF6HHB5AGZ0Z`) are `node_role='deployment'`
  and fully unbound (all four placement columns NULL), so the workspace sweep skips them —
  but they would hit the same wall on deployment-environment teardown. Tracked separately.

## Fix

Accept a **version-only** generation proof at the teardown gate, via a named predicate
`hasExactProviderCredentialGenerationProof`. The resolver is left to enforce the fence itself and
still refuses a rotated credential on either path, so teardown stays fail-closed.

Safety argument: every ciphertext-mutating write to `credentials` sets `updatedAt`
(`routes/credentials.ts:367`, `routes/projects/credentials.ts:318`), so rotation still moves the
version and `exactCredentialGenerationMatches` still returns `matches: false`. Version-only proof
is weaker than a content fingerprint, but it is exactly as strong as the binding that provisioned
these nodes in the first place. Fingerprinted rows are unaffected: when a fingerprint is present it
must still match exactly, and a matching version cannot rescue it.

Also improved the terminal diagnostic to name which prerequisites are absent
(`.claude/rules/49`), without echoing the credential reference.

## Enumeration of callers (rule 67)

`hasExactProviderCredentialGenerationProof` replaces an inline condition with exactly one caller:

| Caller | Path | Impact |
| --- | --- | --- |
| `requireStrictNodeProvider` | `resolveStrictNodeProvider` → `deleteStrictProviderInstance` → `deleteNodeResourcesStrict` | intended: accepts version-only proof |

`deleteNodeResourcesStrict` reaches it from `stopNodeResources` (user delete),
`destroyNodeForCleanup` (all cleanup sweeps), `node-resource-deletion.ts`, and
`scheduled/trial-expire.ts`. All four get the same relaxation, which is intended — every one of
them was equally unable to delete a pre-0142 node.

No other call site of `exactProviderCredentialBindingFromPlacementSnapshot` changes:
`services/nodes.ts:232` (provisioning) does not consult the predicate.

## Implementation checklist

- [x] Add `hasExactProviderCredentialGenerationProof` with the safety rationale documented
- [x] Use it at the strict teardown gate
- [x] Name the missing prerequisites in the terminal diagnostic, without leaking the reference
- [x] Sync the now-inaccurate "required" doc comment on `credentialFingerprint`
- [x] Split the merged legacy-binding test into its three real disjuncts
- [x] Incident regression test (version-only binding is destroyable)
- [x] Rotation control (version-only binding whose row moved is still refused)
- [x] Resolver-level tests through real SQLite so `updated_at` genuinely round-trips
- [x] Unit-test every disjunct of the new predicate
- [x] Prove discriminating in both directions

## Test evidence

Baselines reconciled (rule 02): `nodes-delete` 35 → 39, `provider-credentials-edge-cases` 32 → 41.

Discrimination checks, each run once and reverted:

| Mutation | Tests that went red | Controls that stayed green |
| --- | --- | --- |
| Restore `!exactCredential?.credentialFingerprint` gate | `destroys a pre-0142 node…`, `still refuses a version-only binding whose credential row has since rotated` | no-binding-at-all, proofless-binding, fingerprint-rotation |
| Neuter the version fence in `exactCredentialGenerationMatches` | `refuses a pre-0142 binding after the credential row rotates`, `refuses a binding with neither fingerprint nor version…` | version-match, fingerprint-mismatch |

## Post-mortem

**What broke.** Every managed VM node alive across the #2019 production deploy became permanently
undeletable. One node hit it; it retried teardown hourly for three days and stayed visible in the UI
with no way for the user to remove it.

**Root cause.** A fail-closed guard was placed on a column that, by design, existing rows can never
have — with no backfill, no migration-time reconciliation, and no operator override.

**Class of bug.** *A new required field gating an existing lifecycle operation, where the field is
unbackfillable and the gate has no escape path.* This is the schema-migration sibling of
`.claude/rules/63`: rule 63 covers a widening that silently deletes a check; this is a tightening
that silently deletes a **capability** for every pre-existing row. It compounds with
`.claude/rules/47` — the stranded row had no terminal state, so it retried forever instead of
surfacing.

**Why it wasn't caught.** The suite had one test named "fails closed when a legacy node lacks an
exact provider-account binding" whose fixture set **all four** placement columns to NULL. That is
the genuinely-unbound state, where failing closed is correct. The state migration 0142 actually
creates — source + reference + version present, fingerprint NULL — had no test at all. Two distinct
states were merged under one name and the merged behaviour asserted as correct, so the guard's real
falsifying case was unreachable by the whole suite (`.claude/rules/69`).

**Process fix.** New rule `.claude/rules/71-tightening-a-column-can-delete-a-capability.md`.

## Follow-up (not in this PR)

- SAM idea: rebind or retire the two fully-unbound deployment nodes, and give strict teardown a
  bounded escape path so a permanently-failing candidate surfaces instead of retrying forever
  (`.claude/rules/47`). Deliberately separate: a force-delete that bypasses termination proof can
  orphan paid cloud VMs, which is a spend/security-design decision for Raphaël, not an agent call.
