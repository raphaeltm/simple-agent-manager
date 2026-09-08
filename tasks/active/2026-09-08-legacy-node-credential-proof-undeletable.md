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

`hasExactProviderCredentialGenerationProof` replaces an inline condition with exactly one direct
caller: `requireStrictNodeProvider` → `resolveStrictNodeProvider` → `deleteStrictProviderInstance`
→ `deleteNodeResourcesStrict`.

`deleteNodeResourcesStrict` has **five** call sites, all of which get the same relaxation. That is
intended — every one of them was equally unable to delete a pre-0142 node:

| # | Caller | Impact |
| --- | --- | --- |
| 1 | `services/nodes.ts:606` `stopNodeResources` (user-initiated delete) | intended — this is the path the user was hitting |
| 2 | `scheduled/node-cleanup/shared.ts:491` `destroyNodeForCleanup` (all cleanup sweeps) | intended — the hourly retry that produced the 71 failures |
| 3 | `services/node-resource-deletion.ts:54` | intended |
| 4 | `scheduled/trial-expire.ts:339` | intended |
| 5 | `durable-objects/task-runner/state-machine.ts:711` (revoked recovery node cleanup) | intended; in practice these nodes are freshly auto-provisioned in the current deploy and already carry a fingerprint |

Caller 5 was **missed in the first cut of this enumeration** and found by the `cloudflare-specialist`
review. Recording that here because rule 67's requirement is the enumeration itself, and an
enumeration that is quietly wrong is worse than none.

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

Baselines reconciled (rule 02): `nodes-delete` 35 → 39, `provider-credentials-edge-cases` 32 → 45 (the fail-closed disjuncts
are one `it.each` table, so the case count exceeds the test count).
Full `apps/api` suite reconciled separately: 9075 tests, 0 collection failures.

Discrimination checks, each run once and reverted. **The mutation must be stated precisely** — an
earlier revision of this record described mutation 2 as "make `exactCredentialGenerationMatches`
return `{ matches: true }`", which if applied to the whole function body also disables the
*fingerprint* branch and reds two additional fingerprint-rotation tests. That recipe was wrong and
mislabelled a real regression-catcher as a control. Corrected below; caught by the `test-engineer`
review, which reproduced the recipe as written and got a different result than this file claimed.

| Mutation (exact) | Went red | Controls that stayed green |
| --- | --- | --- |
| In `requireStrictNodeProvider`, restore `!targetProvider \|\| !exactCredential?.credentialFingerprint` | `destroys a pre-0142 node whose binding carries a version but no fingerprint`, `still refuses a version-only binding whose credential row has since rotated` | no-binding-at-all, proofless-binding, no-cloud-provider, fingerprint-rotation |
| In `exactCredentialGenerationMatches`, replace **only the tail `matches:` expression** (leaving `if (exactCredential.credentialFingerprint) { … }` intact) with `matches: true` | `refuses a pre-0142 binding after the credential row rotates`, `refuses a binding with neither fingerprint nor version even when the row is unchanged`, `refuses a cc_credentials binding after the row rotates…` | version-match, fingerprint-mismatch, cc-version-match |

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

## Review dispositions

Three local reviewers ran against the original issue, the production evidence, and the diff.
All three independently confirmed the core safety claims: fingerprint priority is preserved (a
matching version cannot rescue a moved fingerprint), no cross-tenant path opens (tenant scoping is
a separate, untouched predicate), the error message never reaches an HTTP client, and the
incarnation fence still sits between provider resolution and `deleteVM`. `cloudflare-specialist`
additionally traced the full sweep path and confirmed the fix **does** free the stuck production
row: `sweepMaxLifetimeNodes` selects `status NOT IN ('stopped','deleted')`, and
`claimNodeForCleanup`'s CAS binds the candidate's own current status, so a row already at
`destroying` re-claims successfully.

Fixed in this branch:

| Finding | Reviewer | Fix |
| --- | --- | --- |
| Caller enumeration missed `task-runner/state-machine.ts:711` | cloudflare-specialist | enumeration above corrected to five |
| Writer enumeration in the predicate comment was unscoped — true only for `credentialType='cloud-provider'`; missed `codex-refresh-lock.ts` (uses `datetime('now')`, second precision) and `default-capacity-source-credentials.ts` | security-auditor | comment rewritten as a per-writer table, explicitly scoped, with the `cc_credentials` immutability invariant documented |
| Millisecond `timestampVersion` collision undocumented | security-auditor | recorded as an ACCEPTED RESIDUAL RISK in the predicate comment, with its bounded blast radius |
| `hasExactProviderCredentialGenerationProof` used `!= null` for the fingerprint while `exactCredentialGenerationMatches` uses truthiness — an empty string would count as proof in one and not the other | security-auditor | aligned to truthiness; two `it.each` cases pin it |
| `cc_credentials:`-referenced version-only path untested | security-auditor, test-engineer | new real-SQLite describe block: match + rotation-refusal through the real join |
| `!targetProvider` disjunct of the modified gate untested | test-engineer | new test: managed node with `cloudProvider: null` fails closed and the diagnostic names `cloudProvider` |
| Three resolver "refuses" tests were absence-only in isolation | test-engineer | each now carries a liveness assertion in the same test — the same fixture, addressed with the row's current version, resolves |
| Discrimination-check-2 recipe was imprecise and mislabelled a control | test-engineer | corrected above; both checks re-run with exact mutations |
| Redundant type import (`ExactProviderCredentialBinding` from two modules) | cloudflare-specialist | consolidated into the barrel import |
| Follow-ups tracked as prose rather than a filed artifact | security-auditor | idea IDs now recorded below (project policy `7cf74246` makes SAM Ideas the tracker for this repo, not `tasks/backlog/`) |

## Follow-up (not in this PR)

Tracked in SAM idea **`01M211FBNN6J77DMT9KY076VEX`**:

- **No bounded escape path** for a permanently-failing teardown candidate (`.claude/rules/47`).
  Deliberately separate: a force-delete that bypasses termination proof can orphan paid cloud VMs,
  which is a spend/security-design decision for Raphaël, not an agent call.
- **Asymmetric claim/release** (raised by `cloudflare-specialist`): `stopNodeResources` and
  `node-resource-deletion.ts` claim a node into `destroying` and throw without restoring the prior
  status, and `releaseNodeCleanupClaim` then "releases" back to the status it read — which is
  already `destroying`. So any future teardown failure from a *different* cause pins the row the
  same way. `trial-expire.ts` already has the more robust shape (stale-lock reclaim window, release
  to `error`). This is a distinct, fixable bug from the deferred force-delete design question.
- **The two fully-unbound deployment nodes** (`01KXAR1T3XCQKKPBEJEERQ2PSZ`, `01M1015FQ9D772EF6HHB5AGZ0Z`),
  which the version-only fallback cannot rescue — they have no reference and no version.
- **`...Once` mock-leak class** (raised by `test-engineer`): one instance was fixed here; ~14 other
  `mockResolvedValueOnce`/`mockImplementationOnce` calls in `nodes-delete.test.ts` carry the same
  latent hazard, since `vi.clearAllMocks()` does not drain queued one-shots. Fixing the class means
  switching the file to `mockReset()` semantics, which is a broader change than this fix warrants.

Idea **`01M211ES3GZ8SQWPT50A838K37`** tracks this bug and fix; mark complete only after merge AND
production shows the node actually gone.

## Note on prior production mileage

`security-auditor` observed that the version-only fallback was **not** dead code system-wide before
this change: `CapacityPlacementSnapshot` (`packages/shared/src/types/capacity-pool.ts`) has no
fingerprint field at all, so node *creation* through the capacity-pool placement resolver has always
resolved credentials via the version-only branch, then written the computed fingerprint back
(`services/nodes.ts:271-275`). The claim in this record is narrower and stands — it was dead on the
*teardown* path — but it is worth knowing the fence being relied on has real production mileage
rather than being newly exercised.
