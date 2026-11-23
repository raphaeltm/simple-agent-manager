# Give stranded platform-capacity nodes a supported way out of `destroying`

SAM task `01M7RHQY3V41D77R6YYJDGTWCS` (re-dispatch of `01M7Q4P9GNM747H6CY5YA25ACH`), coordinator
`01M7KXHRDQ6C08JCHTRH5R3QQK`. Ideas `01M76T4XXVQS1TX8VQM2BRPWFG`, `01M6DFJTV3VCFEJEBYMK3KYF7A`.

## Problem

Staging2 node `01M7MTMV89F5ZV23VSF0ZVPJPS` (Hetzner, managed VM, platform capacity in all three
source columns) failed provisioning on 2026-11-17 13:20:31Z ("Node allocation plan is no longer
current") before any provider ID was recorded, and has been `destroying` since, logging ~150
errors a day. The owner confirmed in the Hetzner console that no such server exists.

1. `reconcileStrictProviderlessVm` (`apps/api/src/services/strict-node-providerless-reconcile.ts`)
   refuses list-absence as finality by design (late-create risk) and throws a plain `Error`.
2. The platform credential row was re-saved; its ciphertext generation no longer matches the
   node's pinned fingerprint. `requireStrictNodeProvider` then throws "Cloud provider
   credentials missing for strict node deletion" — wrong label: it is a generation mismatch.
3. Both refusals are plain errors, so `handleCleanupFailure` shrinks the backoff to zero after
   the blocked deadline (rule 47) and `cleanup_blocked_reason` never names the cause.
4. The owner path (`POST /api/nodes/:id/manual-deletion`) correctly refuses platform capacity
   with 403. No operator path exists.

## Research findings

- Owner path: `routes/nodes/manual-deletion.ts` → `services/node-manual-deletion.ts`
  (`recordManualNodeDeletion`: status gate, VM only, refuses SAM capacity, provider existence
  check, `recordOwnerAttestedRuntimeTermination`) → `completeOwnerNodeRemoval` in
  `routes/nodes/delete.ts` (audit, record removal, NodeLifecycle finalize, stranded tasks).
- Audit: `services/owner-node-deletion-audit.ts` writes `node_health_events` (survives node
  removal) with a fenced INSERT; reasons are an allowlist.
- Provenance: `nodes.runtime_termination_attested_at` = proof ⇒ attested, not strict
  (`isOwnerAttestedTermination`).
- Teardown authority: `services/node-teardown-authority.ts` — `NodeTeardownBlockedError` with
  named reasons, `resolveStrictNodeTeardownAuthority` (pinned, else current owner + platform
  credentials), `recordNodeTeardownBlocked` writes `cleanup_blocked_reason` + rate-limited alert.
  Providerless reconcile does not use it; it calls `requireStrictNodeProvider` directly.
- `handleCleanupFailure` (`scheduled/node-cleanup/cleanup-outcome.ts`) keeps the full failure
  backoff only for `NodeTeardownBlockedError`.
- Anomaly `node_destroying_too_long` (`services/fleet-ops/anomalies.ts`) already surfaces every
  long-destroying node with `cleanup_blocked_reason` → (d) exists; it needs an accurate reason.
- Admin UI: `pages/AdminInfrastructure.tsx` renders only the installation pools panel. No admin
  node list exists; a superadmin cannot open another user's Node page (`requireNodeOwnership`).
- Policy 2b97aefc: a new superadmin mutation route ships with a phone-usable admin UI control.
- Hetzner create is one synchronous POST; the provisioning path records a create-requested mark
  only for durable (NodeLifecycle) attempts, in DO storage, not on the node row.

## Decision: which of (a)–(d)

- **(b) yes** — operator attestation for platform-capacity nodes. Needed regardless: once the
  pinned generation is gone no credential can prove a providerless node absent, so no automatic
  rule can ever clear this class.
- **(c) yes** — name the refusals: `teardown_credential_generation_changed` (row enabled, same
  provider, generation moved), `teardown_credential_unavailable` (row removed/disabled), and
  `teardown_allocation_unresolved` (empty inventory under the exact credential). Do NOT accept a
  re-saved platform credential as absence proof: a Hetzner API token is scoped to one Hetzner
  project and the API exposes no project identity for a token, so an empty list under a re-saved
  token cannot be shown to be the same account (rule 56: absence from a credential that might
  not see the server is not proof).
- **(d) covered** by the existing anomaly once (c) records the reason.
- **(a) no** — accepting list-absence under the pinned credential after a window would not have
  cleared this node (the generation moved), and widening the destructive verdict on a finality
  path is a security-design change the incident does not need. (b) covers the class.

## Implementation checklist

- [x] (c) Diagnose why the pinned credential did not resolve (generation changed vs removed /
      disabled) and throw `NodeTeardownBlockedError` from the providerless path; empty exact
      inventory throws `teardown_allocation_unresolved`. Add both reasons to
      `NODE_TEARDOWN_BLOCKED_REASONS`.
- [x] (b) Service `recordOperatorNodeDeletion` (shared helpers with the owner path, no fork):
      superadmin only, platform capacity only, managed VM only, `destroying` with a recorded
      refusal in `OPERATOR_REMOVABLE_BLOCK_REASONS`, providerless nodes outside the provisioning
      recovery window, provider existence check (pinned, else platform credentials only; any
      returned server → 409; lookup failure → 503; providerless without buildable labels while a
      credential could look → 409; no credential can look → operator's word, recorded).
- [x] Coordinator guardrails: typed node ID + required note; audit row (who/when/note/lookup
      evidence/agentSignIn) written BEFORE the proof, fail-closed; final CAS re-checks the exact
      refusal, no active/pending workspace, no non-terminal task placement claim, stale heartbeat.
      Tests: `node-operator-deletion.test.ts` (claim queued/draft + completed control, active
      workspace, heartbeat, audit-down, reason allowlist, labels, multi-credential, 5xx).
- [x] Record proof as attested (`runtime_termination_attested_at`), audit event
      `deleted_by_operator` / `operator_attested_manual_deletion` in `node_health_events`,
      plus an `operations_audit_log` row naming the superadmin.
- [x] Route `POST /api/admin/nodes/:id/operator-deletion` (`{confirmation, note}`) and
      `GET /api/admin/nodes/stranded` (platform-capacity VM nodes in `destroying` with a recorded
      refusal, capped, with total and per-row `operatorRemovable`).
- [x] Admin UI: "Stuck nodes" panel on Admin → Infrastructure with a confirm dialog naming the
      provider and instance (or "no server ID was recorded"), phone usable.
- [x] Docs: self-hosting / admin docs mention the operator path; api reference.
- [x] Tests (workers, real D1 + migrations): incident reproduction through the real cleanup
      entry point (named reason recorded, full backoff) that fails pre-fix; operator removal of
      the incident node; live-server controls (providerless labelled server via current
      platform credential; instance ID still exists) refuse and change nothing; non-superadmin
      and owner refused; user-capacity node refused (owner path control); recovery window
      refused; proven discriminating.
- [x] Playwright visual audit of the panel (375 / 1280), diverse data.

## Acceptance criteria

- [x] The incident node shape is removed through the admin path, audited as operator-attested.
- [x] A node whose server still exists at the provider is refused (409) with nothing changed.
- [x] Non-superadmins cannot list or act; user-capacity nodes are refused by the admin path.
- [x] The providerless refusal names its condition in `cleanup_blocked_reason` and keeps the full
      failure backoff (`keeps the full failure backoff…` drives `handleCleanupFailure` with the
      real error).
- [ ] Staging2 node `01M7MTMV89F5ZV23VSF0ZVPJPS` cleared through the new UI path.

## Implementation notes

- Proof writers moved to `services/strict-node-termination-proof.ts` (strict-node-deletion.ts was at
  499 lines); `markRuntimeTerminationConfirmed` gained an optional `admission` SQL for the operator
  path's reciprocal predicate. `requireStrictNodeProvider` was removed (its only caller now uses
  `requirePinnedProviderlessCredential`).
- Coordinator guardrails (2026-11-19): only `destroying` with a recorded block; refuse fresh
  heartbeat / active workspace / task placement claim in the final CAS; typed node ID + note stored
  with who/when (operations_audit_log, task_id `admin-ui`); security review; visual audit.
- Discrimination (workers test `node-operator-deletion.test.ts`): no admission SQL → active
  workspace + fresh heartbeat tests red; no provider lookup → both live-server controls + incident
  (liveness) red; no superadmin middleware → authz test red; pre-fix reconcile → three naming tests
  + incident red.
- Known edge: an operator removal interrupted after the proof write and finished later by the
  owner's Delete is audited as `owner_attested_manual_deletion` (still attested, never strict).
- Docs updated: admin-settings (new section), session-troubleshooting, security.md, api.md. The
  task file was committed on the branch, not main.

## Follow-up: agent sign-in default (owner decision)

PR #2900 merged with agent sign-in sessions refused by default (safe default while the question
was open). The owner answered ask `01M7RX9S6DG1NDNKPPHARGBT96` at 07:45Z: "Allow agents (audited)
everywhere". Follow-up branch `sam/operator-node-deletion-allow-agents`:

- [x] `operations.operatorNodeDeletionAllowAgentSessions` defaults to ON; a superadmin can turn it off.
- [x] Workers test resolves the default through the real resolver (no stored value → admitted and
      audited with `agentSignIn`), and the explicit OFF state refuses with 403 before any provider
      call or audit write.
- [x] Docs updated (admin-settings, configuration, api).

## Reconciliation (2026-11-23, weekly queue reconciliation)

- Shipped in [#2900](https://github.com/raphaeltm/simple-agent-manager/pull/2900) and [#2904](https://github.com/raphaeltm/simple-agent-manager/pull/2904) (merged 2026-11-19).
- Production deploys from `main` have succeeded continuously since then (latest `7d40cfb2d`, 2026-11-23).
- 1 line(s) stay unticked. They are verification or reporting steps that were not re-checked here; this record does not claim them.
