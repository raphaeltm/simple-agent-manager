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
**Original delivery was draft-only. That hold was released for PR #2853 on 2026-11-17; normal CI, review, staging and release gates apply. No GitHub issues.**
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
- [x] Keep the composed placeholder-attach statement within D1's expression-depth cap of 100
      (staging finding below): parenthesize the authority `EXISTS` WHERE into pool, source,
      candidate and credential groups in `placement-authority.ts`. Same terms, same binds.
- [x] Prove it on Miniflare's D1, which enforces the cap: composable user/project plus legacy
      and platform controls, through plan guard, reuse, `attachPrecreatedWorkspacePlacement`,
      `reserveWorkspacePlacement` and `reserveWorkspaceRestart`
      (`tests/workers/composable-authority-d1-expression-depth.test.ts`).
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
  Tracked as `tasks/backlog/2026-11-18-pinned-workspace-stale-allocation-plan-returns-500.md`
  (deferred: pre-existing, outside this fix's scope; the guard still refuses).

No production deployment, readiness action, merge or GitHub issue creation occurred.

- Final task-completion validation: **WARN**, with no blocking implementation findings.
  Checks A/B/E passed, D not applicable, F passed locally; C warns only for the explicitly
  deferred live provider lifecycle. Security, Cloudflare, test, docs and constitution
  reviews pass within scope. Keep the active task and unchecked live criterion intact.

## Authorized continuation (2026-11-18)

Continuation task `01M7P016JSFBA9W3KJD6J9JTD3` resumes the original branch and PR,
preserving every predecessor commit. Human release was reconciled directly against answered
review `ask:01M7NBFXVS6DWHVAA2JXA2WY8B` and role=user message
`inbox-ask:01M7NBFXVS6DWHVAA2JXA2WY8B` in session
`chat_cron-b6c03fab39c6107918849d45b0d6619f679ff18639e628f605c04eae2048cd3a`
at **2026-11-17T19:13:35.515Z**, answering the request to release the draft-only hold:
“it looks good.” This releases this PR only; no validation gate is waived.
The draft-only statements above describe the predecessor delivery, not a current hold.

Fresh reconciliation read all 225 association records, 101 active agents, the exact URL/branch
ownership filter, PR files, reviews, comments and all review threads. No competing owner or
review findings were found; original head was `35826a9546302e8a1dcf4f890abe82c4983738c8`.
The original terminal task's held association remains immutable historical evidence.
`associate_pull_request` with its exact `previousTaskId` refused with MCP `-32602` because
its SQL unconditionally rejects another held association, even for a terminal predecessor.
The coordinator independently confirmed this metadata limitation; release authority comes
from the verified human response and explicit continuation assignment. No SQL bypass,
impersonation, guard changes or duplicate implementation is involved.

Current main `4fc4cb99a` integrated through a normal merge without source/test conflicts.
The exact-anchor production correction remains unchanged. Fresh combined-tree validation,
independent reviews and real leased staging remain pending. Canonical idea stays open.

## Staging finding: D1 expression depth (2026-11-19)

Takeover task `01M7PX4F5CPXBW4TEZCHCRAGC6`. Merged main (123 commits, clean) as `2e1a89550` and
deployed it to primary staging (run `44427672139`). The live kit's first attempt stopped at a
pre-existing fixture conflict: the smoke user already owns a project on
`serverspresentation2025/deploy-test` (one project per user, installation and repository since
#2030), so the kit now uses the unlinked `serverspresentation2025/VoyajApp`.

The second attempt reconciled the composable pool, selected the exact anchor and created node
`01M7RMD7ADHMD443V4QAEQ7S1N`, which booted, sent `/ready` at 00:52:50Z and heartbeated. Workspace
`01M7RMD7HA25QMYFMACB8Q2788` was never linked. Workers observability showed the NodeLifecycle alarm
retrying `node_provisioning.durable_attempt_failed` every 30 s, and the matching span for the
placeholder attach (`attachPrecreatedWorkspacePlacement`, 79 binds) failed with
`Expression tree is too large (maximum depth 100): SQLITE_ERROR`.

- SQLite nests `a AND b AND …` one level per term; D1 caps depth at 100. The captured statement
  needs depth 102 with or without this PR's `OR` (Python `sqlite3.setlimit` on the migrated
  schema), so the cap blocked composable fresh allocation independently of the anchor fix.
  Removing the composable `EXISTS` drops it to 87, which is why legacy/platform pools work.
- better-sqlite3 allows depth 1000, so the unit suite could not see it. Miniflare's D1 reports
  the production error, so the regression lives in `tests/workers/`.
- Grouping the authority `EXISTS` WHERE takes the captured statement from 102 to 76.
- Discrimination: with the grouping reverted, exactly the four composable attach and restart cases
  fail with the D1 depth error; legacy/platform controls and reuse pass. With it, 12/12 pass.
- Cloudflare review measured every composable caller (pre → post): attach 102/103 → 76/79,
  restart 106/107 → 80/83, reserve 95/96 → 69/72, relay select 95/97 → 78/81, deployment
  link/relocation 96–97 → 64–74, reuse 94/95 → 66/69. Query plans identical (24/24).
  Restart was also over the cap before the fix, so it is now covered on Miniflare.
- Deferred LOW (review): no padding canary enforces the ~17-level margin; any new `node_scope`
  term lowers it. The Miniflare suite still fails at the cap itself.
- No D1 depth errors in this account in the previous 7 days, so this path had not run before.

Cleanup: the kit deleted the node (HTTP 200, row gone, no provider instance recorded on the
workspace). The project and attachment were deleted afterwards (200). The never-placed
workspace row stays `stopping` with `runtime_deletion_unconfirmed`, like four older staging rows;
it has no node or VM.
