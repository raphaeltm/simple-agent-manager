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

Execution: SAM task `01M7MC07CGE5SRFY9JF58R09RB`, canonical idea
`01M3D3P0A05ED6EKM1K2QGF1FH`, branch `sam/fix-composable-credential-pool-8r09rb`.
**DRAFT PR ONLY: do not mark ready, merge, or deploy production. No GitHub issues.**
Use the existing SAM-isolated workspace and keep task state on this branch.

Preflight (2026-11-17): business-logic-change, cross-component-change,
security-sensitive-change. Confirmed on `e5c5aa4f77e6adf389a24b25b9470a69c24acbff`.
Smallest correction: derive the exact versioned anchor with the existing helper; retain
the null compatibility branch and all real credential/configuration/attachment predicates.
No migration, new configuration, provider behavior, or public interface change is needed.
Public docs already describe composable compute credentials; no public docs change needed.

Shared predicate consumers (all require the same current credential authority):

- `node-allocation-validation.ts:assertNodeAllocationPlanCurrent`: permit valid reconciled plans.
- `reusable-node-authority.ts:filterReusableNodesByCurrentAuthority`: permit valid running nodes;
  existing-node mode still requires a provider instance and ignores only historical pool revision.
- `workspace-admission-sql.ts:buildWorkspaceAdmissionSql`: same correction in final reservation.
- `deployment-node-admission.ts:linkEnvironmentToNode` and
  `claimDeploymentEnvironmentRelocation`: same correction, retaining deployment role/capability.
- `session-snapshot-upload-relay.ts:findSnapshotUploadRelayNode` and
  `assertSnapshotUploadRelayAuthorized`: same correction, retaining relay and source identity.

The shared helper is an admission trigger; its meaning stays current credential authority.
Only the contradictory anchor-shape guard changes. One added bind per composable predicate;
verify composed workspace admission and reuse chunking stay within `D1_MAX_BOUND_PARAMETERS`.

Contributor attribution: Léonce Aklin (`leonceaklin`) reported upstream issue #2843 and
provided the exact-anchor approach in zebra-pig/simple-agent-manager#9 (commit `ca39313299`).
Reviewed as untrusted evidence. Do not import its unrelated node-limit or ACP changes.
Regression coverage here must drive the real writer rather than hand-seed the anchor.

- [x] Reconcile the composable allocation predicate with the required secret-free anchor,
      retaining one authority for exact credential, attachment, ownership, provider, scope,
      activity, and version checks. Do not copy secrets or weaken stale-plan rejection.
- [x] Add a real-SQLite regression covering attachment creation → pool reconciliation →
      selected node allocation, using the production schema and generated anchor. Stub only
      external provider boundaries. It must fail on the current null-anchor predicate and
      pass the immediate pre-provider allocation guard after the fix without fabricating a null
      anchor. Automated tests stop at that guard; provider creation is part of staging validation.
- [x] Add discriminating rejection cases for a revoked/detached attachment, changed credential
      version, foreign owner/project, and an unrelated credential anchor. Keep legacy user and
      platform credential allocation passing; cover both user and project composable sources.
- [ ] Verify the same public API/UI flow on staging with an isolated project and remove every
      created node, workspace, project, and attachment. Record evidence that stable plans pass
      while changed authority is rejected; do not mutate shared pool policy to reproduce it.

## Validation progress (2026-11-17)

- `pnpm install --frozen-lockfile` succeeded. Root build: 18 tasks passed;
  lint: 22 passed (existing warnings); typecheck: 36 passed.
- New migrated-SQLite suite: 40/40 passed. Exact user/project anchors both failed before
  the fix at `assertNodeAllocationPlanCurrent` with the incident error; the initial run's
  legacy/platform controls passed. Focused red run: 2 failed, 33 filtered out.
- The happy path drives credential/configuration/attachment inserts → real reconciliation →
  real pool editing → real placement selection → `createNodeRecord` → allocation guard →
  existing-node reuse (101 entries, exercising bind-budget chunking) → final workspace insert.
  All statements enforce `D1_MAX_BOUND_PARAMETERS`; schema is the complete shipped D1 chain.
- Focused allocation/effective-pool suites passed 119/119 across three files. Existing real
  workerd final-admission suite passed 3/3. `quality:file-sizes` and `git diff --check` passed.
- Local security, Cloudflare, completion/test, docs-sync and constitution reviews completed
  without blocking findings. The maximum composed workspace statement uses 97/100 D1 binds;
  deployment admission uses at most 55, relay at most 35, allocation validation 29, and reuse
  chunks at 74 node IDs plus 26 authority binds. No extra database round trips were added.
- CodeRabbit requested once via trusted workflow `44054989276`; it responded rate-limited
  on 2026-11-17 at 09:23:52 UTC. No review; wait ended per policy, no retry.
- Full root tests passed: 39 Turbo tasks; API 16,620 passed / 4 skipped across 1,089 files
  (1,086 passed / 3 skipped), web 5,366 passed. No failed suite summaries.
  Format ratchet passed (2,118/2,180 baseline unformatted files); new test/task format checks pass.
- Full CI `44063465393` passed on `5676a096d6910698025cde49d2d0cba1910f0aa4`: all
  three API shards, seven Workers shards, CLI, aggregate tests, quality, build, typecheck,
  lint and secret scanning. Quick CI, E2E smoke and SonarCloud also passed.
- No production deployment, merge, or readiness action permitted.
- Draft PR: https://github.com/raphaeltm/simple-agent-manager/pull/2853 (held in SAM).

## Draft delivery and deferred live validation

The implementation is delivered as **draft PR #2853 only**. The live staging acceptance
criterion above remains unchecked, and this task record stays active rather than being
archived as fully verified. The canonical idea remains open while the fix is unmerged.

- Primary staging was reserved at 09:18:39 UTC through workflow `44054221451`.
  Turn estimates shifted from 10:43 to 12:08 to 13:26 UTC.
- Final bounded check at **2026-11-17 13:26:52 UTC**: primary was held by
  task `01M7M4PMFV7ATSA5GJNXGKCXDT`, branch `sam/remove-every-path-handles-gkcxdt`,
  SHA `6360a75f9587f4d3635780b99da1b9590aa1a773`, until 14:12:49 UTC. Our position-one
  turn moved to 14:12:49–14:22:49 UTC. Secondary was also held until 14:00:34 UTC
  with three queued reservations. No deployment slot was reached during the four-hour wait.
- Ended the bounded shared-environment attempt and released only our queued reservation
  via successful workflow `44092944005`. Readback at 13:30:43 UTC confirmed our queue
  entry absent and the other holder unchanged; deploy and smoke jobs were skipped. No deployment of this branch, provider VM,
  workspace, project or attachment fixture was created; there is no runtime cleanup debt.
- Authenticated read-only readiness passed at 12:35 UTC: smoke login, accessible small
  repository fixture, three owned active Hetzner configurations and active backing
  credential/configuration. This is environment preflight, **not live fix verification**.
- The reviewed, credential-free staging kit is linked to the canonical idea as library file
  `01M7MQ3EF0MP4K32TEJVDYQBD2`, SHA256
  `8e602139c03e87c5465020d22118ca1feb6c0281e7b2655b2ac201987faaec7b`.
  It includes real project/attachment reconciliation, one `cx23/fsn1` allocation,
  stable pinned reuse, identical pinned source-exclusion control and strict scoped cleanup.
  Contract review corrected asynchronous fresh-workspace node linking and added exact
  selected candidate/source/machine proof. No paid agent session is required.
- Code inspection identified a separate existing error-mapping gap: pinned workspace
  creation calls the plain-error allocation guard directly, so intentionally stale
  authority currently reaches the global HTTP 500 handler. The prepared live check does
  not count a 5xx as a designed refusal. This behavior was **not exercised live** here;
  allocation/reuse and negative HTTP behavior remain explicit staging gaps.

No production deployment, readiness action, merge or GitHub issue creation occurred.

- Final task-completion validation: **WARN**, with no blocking implementation findings.
  Checks A/B/E passed, D not applicable, F passed locally; C warns only for the explicitly
  deferred live provider lifecycle. Security, Cloudflare, test, docs and constitution
  reviews pass within scope. Keep the active task and unchecked live criterion intact.
