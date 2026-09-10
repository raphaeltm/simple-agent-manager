# A New Required Column Can Silently Delete a Capability for Every Existing Row

## When This Applies

Any change that makes an operation depend on a **column that existing rows do not have and cannot
be given**: a content hash, a signature, a captured nonce, an attestation, a proof-of-origin. It
applies with full force when the new column gates a **lifecycle operation** — delete, stop, retire,
release, refund — because those are the operations a user reaches for when something is already
wrong.

The tell is a migration whose comment says some variant of _"existing rows remain NULL and
therefore fail closed"_, with no accompanying answer to "and then what happens to them?".

## Why This Rule Exists

Migration `0142` (PR #2019) added `nodes.placement_credential_fingerprint`, an immutable identity
for the exact encrypted credential generation a VM was provisioned with. Strict teardown then
required it:

```ts
if (!targetProvider || !exactCredential?.credentialFingerprint) {
  throw new Error(
    `Cannot strictly delete node ${node.id}: exact provider credential binding is missing`
  );
}
```

A content fingerprint cannot be reconstructed after the fact — that is the entire point of it. So
the migration could not backfill, and every node alive across the deploy inherited a NULL that it
would carry forever. Node `01M1RKXS5YT0AEAD84872MNN2E` was provisioned at 11:05:42Z on 2026-09-05
and the gate deployed around 15:45Z the same day. From that moment it could never be deleted: not
by the user, not by any cleanup sweep, not by deleting the underlying server at the provider.

It failed **71 times**, hourly, for three days, and would have continued indefinitely. The user
tried repeatedly from the UI, then destroyed the Hetzner server by hand — which changed nothing,
because the gate throws before the provider is ever contacted, and `hetzner.ts` had always treated
a 404 from `deleteVM` as idempotent success. The row sat visible at `status='destroying'`.

The most instructive part: **the resolver behind the gate already handled this case.**
`exactCredentialGenerationMatches` has an explicit null-fingerprint fallback comparing
`credentialVersion`, and for this node that fallback would have passed — its persisted version
matched the credential row's `updated_at` exactly, and the credential was still active. The gate
was stricter than the thing it guarded, which made the fallback dead code on the teardown path.
The capability was removed by an early return, not by a missing mechanism.

## Class of Bug

**A tightening that deletes a capability for every pre-existing row.**

`.claude/rules/63` is the mirror image: relaxing a column silently deletes the _checks_ that used
it. This is the other direction — requiring a column silently deletes the _operations_ that older
rows can still perform. Both are invisible in the diff, because the harm lands on rows that are not
in front of you.

Tells:

- A migration comment stating existing rows "fail closed" as if that were the end of the analysis.
- A guard requiring a field that is unbackfillable by construction (hash, signature, nonce,
  captured secret) rather than merely un-backfilled.
- A guard whose condition is narrower than the validation function it calls, so a legitimate
  weaker proof the resolver already accepts can never reach it.
- A fail-closed lifecycle path with no operator override, so "fails closed" means "is stuck".

## Hard Requirements

1. **State what happens to existing rows, in the migration and in the PR.** Not "they fail closed" —
   what a user or operator does next. If the answer is "nothing, ever", the change is incomplete.
   Every row must have at least one of: a backfill, a weaker-but-real fallback proof, or an
   explicit operator escape path.

2. **Never let a guard be stricter than the validator it guards.** If the downstream resolver
   accepts a weaker proof, the gate must let that case reach it and let the resolver decide.
   A precondition check that rejects inputs the validator would have accepted is not defence in
   depth; it is an unreachable branch plus a deleted capability.

3. **A weaker fallback must still detect the thing the strict proof detects.** Say which writer
   maintains it. Here the version snapshot works because _every_ ciphertext write to `credentials`
   sets `updatedAt`, so rotation still moves it — enumerate those writers (`.claude/rules/44`) and
   name them in a comment. A fallback nobody maintains is not a fallback.

4. **Grandfathering is a state, not a special case.** Give the legacy shape a name, a predicate,
   and its own tests. An inline `!row.newColumn` scattered across call sites cannot be reasoned
   about or searched for later.

5. **Lifecycle gates need an escape path** (`.claude/rules/47`). If a candidate can enter a state
   where it can never succeed, it must surface — a terminal status, an alert, an operator override —
   rather than retry on a timer forever. Hourly retries for three days produced no signal anyone saw.

## Required Tests

- **One test per binding state**, named for the state, never merged: fully absent, weak-proof-only,
  strong-proof-present, strong-proof-mismatched. The bug shipped because "absent" and
  "weak-proof-only" shared one fixture and one name.
- **The grandfathered row completes the operation.** Must fail against the pre-fix guard.
- **The weaker proof still refuses a genuine mismatch** — otherwise the fallback is just a bypass.
  Verify by neutering the fallback's comparison and confirming exactly that test goes red.
- **The strong proof is not weakened**: a row carrying the strong proof, mismatched, is still
  refused even when the weak proof would have matched.
- **Exercise the real column round-trip.** Test against a real SQL engine (`.claude/rules/28`) so a
  value like `updated_at` is read the way production reads it, rather than handed to the comparison
  directly (`.claude/rules/62`).

## Quick Compliance Check

- [ ] The migration says what existing rows can still do, not just that they fail closed
- [ ] Every pre-existing row has a backfill, a fallback proof, or an operator escape path
- [ ] No guard is stricter than the validator it calls
- [ ] The fallback's maintaining writers are enumerated and named in a comment
- [ ] The legacy shape has a named predicate and its own tests
- [ ] A stranded candidate surfaces instead of retrying forever
- [ ] One test per binding state, each proven discriminating

## References

- Task: `tasks/active/2026-09-08-legacy-node-credential-proof-undeletable.md`; PR #2019 (the
  tightening), this fix's PR
- Implementation: `apps/api/src/services/provider-credential-exact.ts`
  (`hasExactProviderCredentialGenerationProof`), `apps/api/src/services/strict-node-deletion.ts`
- `.claude/rules/63-widening-a-table-can-delete-an-auth-check.md` — the mirror image
- `.claude/rules/69-emergency-config-paths-need-their-own-coverage.md` — a guard whose falsifying
  case is unreachable in the configuration the tests use
- `.claude/rules/47-control-loop-io-budget.md` — every candidate needs an escape path
- `.claude/rules/44-dual-write-migration-enumerate-writers.md` — enumerate the maintaining writers
- `.claude/rules/28-credential-resolution-fallback-tests.md` — real SQL engine, owner-path controls
