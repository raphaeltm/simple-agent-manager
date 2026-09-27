# Composable capacity sources fail allocation because their required anchor violates the guard

## Problem and attribution

A project pool backed by a composable credential reconciles successfully and selects an
available offering, but its first task fails with `Node allocation plan is no longer current`
before a provider VM is created. The composable-credential branch of the allocation authority
requires a null credential anchor; the schema and reconciler require a non-null anchor.

Found during PR #2145 staging verification on candidate `b0989c9b2`, 2026-09-25.
This is a preexisting main-branch defect: `git diff origin/main --` was empty for all three
authority/anchor/migration files below. The authority file's latest commit was
`1d21cb8e1` (canonical node pools, PR #2030). It is unrelated to the failed-task preservation,
wake retry, quota fallback, and region-affinity changes being verified. The earlier backlog
task `2026-09-25-staging-allocation-plan-no-longer-current.md` records the same error text,
but its root cause has not been established as this defect.

## Captured staging evidence

- Project: `01M3D00WDCV4NEFPXDW90Q3GZT`; attachment:
  `cc-att-01M3D00ZWJ7HVFTMA7VG0Z700J`, created through `POST /api/cc/attachments`
  referencing an existing Hetzner configuration without copying credentials.
- First UI task: `01M3D0NTFN9P5N0WR4HA9CJJM7`, submitted about 19:29:05Z;
  placement decision `2026-09-25T19:29:06.981Z`; task status `failed`.
- Node: `01M3D0P0T19VPHV27Z1CH6EZKF`, status `error`, `provider_instance_id = NULL`.
  No agent started and no user work was created. Failure originated in
  `apps/api/src/services/node-allocation-validation.ts:184`.
- Pool: `cap-pool-default:project:01M3D00WDCV4NEFPXDW90Q3GZT`, revision **3**,
  `configured-ready`, migration `complete`, last reconciled `2026-09-25T19:28:22.631Z`.
  The public defaults API configured `smallest-fit`, `maxNodes: 1`, and only
  `cx23` / `fsn1` active for workspace use before submission. No explicit task region pin.
- Source: `cap-source-default:project:external:cc_attachments%3Acc-att-01M3D00ZWJ7HVFTMA7VG0Z700J`.
  Task/node source generation **181884762**, overall authority generation **311847119**;
  candidate generation **2370110024**, selection settings version **456366403**.
- Credential reference: `cc_credentials:cc-legacy-cloud-cred-01KWRXEJH4RXW2NC5T8WCCQFTV`;
  source `project`, version **1783247620644**. External source reference:
  `cc_attachments:cc-att-01M3D00ZWJ7HVFTMA7VG0Z700J`.
- Source `credential_id`:
  `cap-source-external-credential:cc_attachments%3Acc-att-01M3D00ZWJ7HVFTMA7VG0Z700J:1783247620644`;
  `platform_credential_id = NULL`. Anchor type `capacity-source-external-ref`, active.
- Read-only D1 joins confirmed reference, credential version, source generation, pool
  revision, location, and instance type all matched the node's plan; candidate was
  `active` / `available`. The contradictory `s.credential_id IS NULL` evaluated **0**.
  Secret columns were not read. Raw safe placement metadata was captured locally in
  `/tmp/2145-placement-failure.json`; the durable facts needed after fixture cleanup are above.

## Contradictory authorities

- `apps/api/src/services/placement-authority.ts:431`, `buildCredentialAuthoritySql`:
  the composable branch demands `s.credential_id IS NULL` as well as a null platform
  credential and the exact active credential/configuration/attachment relationship.
- `apps/api/src/services/default-capacity-source-credentials.ts:61`,
  `ensureCapacitySourceCredentialAnchor`: deliberately creates a secret-free, unusable
  credential anchor for external sources. Its comment explains the schema requirement.
- `apps/api/src/db/migrations/0125_compute_pool_foundation.sql:41`: user/project
  cloud-provider sources require `credential_id IS NOT NULL`. Removing the anchor is
  therefore not a valid fix; neither is treating it as usable credential authority.

## Implementation checklist and acceptance criteria

- [ ] Reconcile the composable allocation predicate with the required secret-free anchor,
      retaining one authority for exact credential, attachment, ownership, provider, scope,
      activity, and version checks. Do not copy secrets or weaken stale-plan rejection.
- [ ] Add a real-SQLite regression covering attachment creation → pool reconciliation →
      selected node allocation, using the production schema and generated anchor. Stub only
      external provider boundaries. It must fail on the current null-anchor predicate and
      reach provider allocation after the fix without manually fabricating a null anchor.
- [ ] Add discriminating rejection cases for a revoked/detached attachment, changed credential
      version, foreign owner/project, and an unrelated credential anchor. Keep legacy user and
      platform credential allocation passing; cover both user and project composable sources.
- [ ] Verify the same public API/UI flow on staging with an isolated project and remove every
      created node, workspace, project, and attachment. Record evidence that stable plans pass
      while changed authority is rejected; do not mutate shared pool policy to reproduce it.
