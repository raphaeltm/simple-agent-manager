# Replacing a cloud credential should keep its compute pool picks

## Problem

On 2026-11-09 Raphaël used the GCP "fix permissions" flow after the UI said his credential lacked
Cloud Billing API access. The flow stored the fixed credential under a NEW id. Compute pool sources
are keyed by credential identity, so:

- the old source (and every machine he had picked from it) was cascade-deleted or left `disabled`;
- the new source started fresh. Before the 2026-11-09 editor redesign it also auto-activated 381
  legacy-size rows; after the redesign it starts with nothing picked.

Either way the person's picks are lost by an action meant only to repair permissions.

## Context

- `apps/api/src/services/gcp-credential-store.ts` (`replaceUserGcpCredential`)
- Composable credentials: one GCP connection was stored three times in production (legacy
  `credentials`, cc "SAM GCP Prod", cc "(migrated)"); managed mirror reconciliation
  (`gcp-pool-mirror-reconciliation.ts`) retires duplicates.
- Found while building `tasks/active/2026-11-09-compute-pool-editor-redesign.md`.

## Acceptance Criteria

- [ ] Repairing or rotating a credential keeps the pool's picks, account on/off state and order,
      either by updating the credential in place or by carrying them to the new source in the same
      write (`.claude/rules/66`: record the handoff).
- [ ] A vertical-slice test drives the real replacement route and asserts the picks survive.
- [ ] Running nodes bound to the old credential keep a working teardown path.

## Reconciliation (2026-11-16)

**SHIPPED.** PR #2718 (ca9672f74, merged 2026-11-14): a GCP re-save updates the credential row in place (`apps/api/src/services/gcp-credential-store.ts:144-148`), so pool source, picks and order survive, and old-source nodes stay reapable (`services/node-teardown-provenance.ts`); vertical-slice test `apps/api/tests/workers/credential-resave-capacity-provenance.test.ts`. Sibling #2715 covers teardown with the current credential. Moved from `tasks/backlog/` by the weekly queue reconciliation.
