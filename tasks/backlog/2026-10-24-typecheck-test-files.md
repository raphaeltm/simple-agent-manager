# Test files are excluded from `pnpm typecheck`, so type-level proofs inside them prove nothing

> **Reconciliation 2026-10-26:** The `links.ts` example is out of date. #2431 (`35f14a954`), merged
> before this file landed, rewrote that comment (`packages/shared/src/types/links.ts:21-39`) to rest
> the compile-time half on T4's `LINK_RELATION_LABELS`, a `Record<LinkRelation, string>` in a source
> file (`apps/web/src/components/linked-work/relation-labels.ts:15`), so a new union member already
> fails `pnpm typecheck` through `apps/web`. The map at
> `packages/shared/tests/link-relations.test.ts:34` is still unchecked and its comment's pointer to
> `links.ts` is stale; the rest is open.

Found by the T7 delta test review (PR #2430, branch `sam/t7-start-work-replaces-5gdbdk`).

## Problem

`packages/shared/tsconfig.json`, `apps/api/tsconfig.json` and `apps/web/tsconfig.json` all carry
`"exclude": [..., "tests"]`, and `pnpm typecheck` is plain `tsc --noEmit` against those configs.
So **no test file in those three packages is type-checked by CI.**

That is mostly a quality nuisance, but it silently voids a specific and increasingly common
pattern: an exhaustiveness proof written as a type annotation inside a test.

Two live examples, both in the Linked work program:

- `packages/shared/tests/link-relations.test.ts` asserts `LINK_RELATIONS` covers the
  `LinkRelation` union by comparing it against a `Record<LinkRelation, true>` map. The runtime
  comparison works. The _compile-time_ half does not: adding a member to the union while
  forgetting both the list and the map compiles clean and passes.
- `packages/shared/src/types/links.ts` says in its own doc comment that "a member added to the
  union without being added here is not a compile error, so the exhaustiveness proof is a
  `Record<LinkRelation, …>` elsewhere plus a test that compares the two". That sentence is
  currently describing a proof that does not hold, and T4's label-map test in `apps/web`
  relies on the same assumption.

Verified by adding a member to the `LinkRelation` union and running `tsc --noEmit` from
`packages/shared/`: exit 0, with the test's map now incomplete.

`packages/terminal` already does the right thing with a `tsc --project tsconfig.test.json` step,
so there is prior art in this repo.

## Why this is worth fixing rather than commenting around

The pattern it breaks is one the rules actively encourage — `.claude/rules/79` asks for a
`Record<Enum, …>` so the compiler enumerates a widened union for you, and that only works if the
file holding the Record is checked. Every such proof written in a test today is decorative.

## Acceptance criteria

- [ ] Enumerate every type-level proof currently living in an excluded test file (grep for
      `Record<` annotations and `satisfies` in `tests/`), and say which ones are decorative today.
- [ ] Add a type-check step covering test files for `packages/shared`, `apps/api` and `apps/web`,
      following `packages/terminal`'s `tsconfig.test.json` prior art, and wire it into
      `pnpm typecheck` so CI runs it.
- [ ] Expect and fix the backlog of pre-existing type errors this surfaces; land the config
      change and the fixes together so CI is green, or gate it behind a ratchet if the count is
      large.
- [ ] Prove it discriminating: add a member to a union covered by one of those `Record` proofs,
      confirm `pnpm typecheck` now fails, then revert.
- [ ] Update `packages/shared/tests/link-relations.test.ts` and
      `packages/shared/src/types/links.ts` comments once the claim is actually true.
