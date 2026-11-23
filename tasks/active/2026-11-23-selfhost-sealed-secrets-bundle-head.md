# Self-host sealed secrets: select the current bundle by an authoritative head

Self-hosting only; hosted SAM is unaffected. Owns ideas `01M83X8B5QEZYW056030YGWCG6` (P1 from
Codex on [#2985](https://github.com/raphaeltm/simple-agent-manager/pull/2985)) and
`01M7W2QMJ4MFVXT4Q06DCAWP1K` (P2 from #2933, same root cause).

## Problem

Every place that picks "the current sealed bundle" sorts bundles by their `createdAt` header. A
host clock that moves backwards between two seals makes the bundle sealed last look older, so the
next deploy names the earlier bundle and silently rolls back a rotation, a `secrets.env` edit or an
`--unset`. A replaceable-box rebuild from the bucket makes the same choice.

## Research findings

Call sites that choose the current bundle by `createdAt` (verified in code):

- `listBundles()[0]` in `key-seal.ts resolveSealedSecrets` (every deploy), `secrets-switch.ts
  runSwitch`, `rotate-store.ts head()` and `prune()`, `secrets-preflight.ts`, `plaintext-scan.ts`,
  `key-choice.ts chooseKeyProvider` (provider hint only).
- `replaceable-box.ts newestLocalBundle` / `assertBoxNotBehindBucket` / `reconcileBundleMirror`.
- `replaceable-rebuild.ts runRebuild` (sorts the bucket bundles).
- `state-installation.ts sealedInstallationId` (installation id hint from the newest header).
- `rotate-apply.ts afterInstant` and the "is not the newest; is the clock behind?" check exist only
  because of createdAt ordering.
- Prune keeps `[new, ...older by createdAt].slice(0, 3)`: after a rollback it can drop the bundle the
  still-running Worker version names.
- Writers that make a bundle current: `resolveSealedSecrets`, `rotate-store write` (applyPatch),
  `secrets-switch` (and its rollback, which removes the new bundle), `secrets-migrate` failure
  cleanup (removes bundles it sealed).

## Design

- Head file `sam-bundle-head/1`: plaintext `{seq, bundleId, installationId}` plus `seal`, a sealed
  bundle (same format as the ledger) holding `SAM_BUNDLE_HEAD` = the same fields, sealed with the
  provider of the bundle it names. Stored at `.state/key-agent/head.json` and, on a replaceable
  box, `sam-box/head.json`. Verified read opens the seal and requires the inner fields to equal the
  outer ones, the seal's installation to match, the named bundle to exist, and its installation to
  match. Anything else fails closed.
- One selector, `scripts/selfhost/bundle-head.ts`, used by every call site above.
- No head (boxes from before this change): `createdAt` fallback; the next deploy writes the head
  naming the bundle it deploys (the same one the old rule picked, so an upgrade changes nothing).
- `seq` increases on every head write; the replaceable "box behind bucket" check compares seqs
  instead of dates.

## Checklist

- [x] `bundle-head.ts`: format, seal/open, selector, keep list, commit helper
- [x] BundleStore `readHead`/`writeHead`/`removeHead` (local + mirrored to `sam-box/head.json`)
- [x] Deploy (`resolveSealedSecrets`) selects by head, writes head after a seal and on migration
- [x] Prune keeps the new head and the previous head
- [x] Rotation: head(), write advances head, prune, resume across a crash between bundle and head
      (`stagedOver`), drop `afterInstant`
- [x] Secrets switch: advance head, rollback restores the previous head
- [x] Migrate failure cleanup removes a head naming a removed bundle
- [x] Preflight, plaintext scan, key choice, state-installation, status use the selector / hint
- [x] Reconcile: verified heads, seq comparison, uploads the local head
- [x] Rebuild: selects the bucket head, copies it verbatim, createdAt fallback without one
- [x] Tests through the real deploy: clock rollback, rebuild after rollback, tampered head, foreign
      head, no-head migration; each guard deleted once
- [x] README (deploy/selfhost) updated
- [ ] Live: sealed-secret live suite on celld; shared box head migration keeps the same bundle

## Acceptance criteria

- Seal at T, then at T-1h: the next deploy names the second bundle.
- A rebuild from the bucket after that picks the same bundle.
- A tampered head and a foreign-installation head stop deploy and rebuild.
- A box with no head deploys the createdAt choice and then has a head naming it.

## Implementation notes

- Mutation proof (each guard deleted once, `bundle-head.test.ts`):
  selector ignores the head -> all 4 red; inner/outer field check -> tamper test red; installation
  match in the selector -> tamper test red; reconcile seq comparison -> tamper test red; rebuild
  ignores the bucket head -> rollback and tamper tests red; rotation `stagedOver` resume -> rotation
  test red; migration head write -> before-head test red; head commit after a seal -> rollback test red.
- `key-service.test.ts` "refuses to deploy from an older bundle when the newest cannot be read":
  its control removed the current bundle and expected a deploy from the older one, which is the
  rollback this change prevents. It now asserts that removal is refused and that restoring the file
  deploys without the unset value.
- Residual (documented in README "Rollback"): a bucket writer can replay an older genuine head and
  delete newer bundles; the same capability already existed over celld's data and the bundles.
