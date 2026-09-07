# Complete canonical node-pool placement and safe legacy upgrades

## Problem

Provider-native pools work, but legacy VM tiers still influence request writers,
provider configuration and displays. Some allocation paths bypass pool selection,
empty pools can disappear from precedence, catalog refresh can change selection
intent, and saved policies are not consistently enforced. Existing clients,
configuration and active/sleeping workloads must survive the transition.

Deliver all fixes together in one PR. Implementation branches are integration
inputs only: no separate child PRs, staging deployments or merges. The parent
coordinates the final local review, staging sweep, CI and CodeRabbit review.

## Preflight and source evidence

- Baseline: `31a07235babf3f25ecd42db3ef077f003c664245`.
- Classes: external-api-change, cross-component-change, business-logic-change,
  public-surface-change, docs-sync-change, security-sensitive-change, ui-change,
  infra-change.
- Data flow: request/profile/skill/project input ->
  `services/placement-resolver.ts` -> `placement-resolver-capacity.ts` ->
  `durable-objects/task-runner/node-selection.ts` ->
  `services/workspace-placement.ts` and `services/nodes.ts` -> provider
  `createVM()` -> workspace, recovery and usage consumers.
- Direct writers: workspace CRUD, node CRUD and deployment provisioning must use
  the same canonical authority or an explicit role-specific adapter.
- Existing tests pass while asserting some incorrect compatibility behavior;
  preserve discriminating regressions rather than merely updating snapshots.
- PR #2021 (`d067b8d73f3f342db03372d35a3a78b6ffb01ff5`) has reusable aggregate
  reservation implementation and real-D1 races. Incorporate its relevant work
  into this branch, reconcile with current main and modern workload semantics,
  and rerun its tests. Do not mutate, merge or close the existing PR.
- PR #1980 (`c98c863dce374b4feb11db86a6362364347bf198`) has host headroom,
  resource telemetry and eviction work. Reuse relevant proven primitives after
  reviewing them; do not import an unverified eviction/rescheduling workflow as
  an incidental dependency. This change must protect host headroom and use
  measured signals without adding destructive automatic eviction by default.
- Read incident lessons in rules 23, 28, 31, 35, 44, 47, 51, 57 and relevant
  archived pool/resolver/provider migration tasks. Prior catalog fixes failed
  to distinguish deliberate removal from temporary provider disappearance.
- Public docs describe implemented behavior and cite code paths. The private
  audit and production observations remain in the project library.
- No destructive schema rebuilds, credential copies or manual deployment-owned
  secret prerequisites. Retain exact-credential and deletion fences from main.
- Check official provider/API documentation before changing request contracts.

## Shared contract and invariants

The canonical request carries validated, field-layered workload requirements,
runtime and role, hard constraints separately from preferences, and provenance.
One versioned compatibility module translates old sizes at their original
precedence layer. Modern fields win at the same layer, then missing fields
inherit; no layer silently invents a new request on retry/recovery. Legacy sizes
mean workload slices, not entire legacy VMs. Mapping/default values and scoring
settings are centrally configurable with persisted settings and environment
fallbacks. Record original legacy intent and mapping version; preserve explicit
modern values through migrations.

The immutable placement plan carries request/provenance, pool identity/revision,
source and exact credential identity/generation, concrete offering, runtime,
role, resource reservation, decision reasons and verification state. Old
persisted TaskRunner plans have an explicit compatibility reader. Revalidate
current authorization at paid allocation and final admission; a stale plan must
re-resolve or fail visibly, never widen scope.

Unconfigured pool state can inherit project -> user -> installation. A configured
empty pool, disabled source, unavailable catalog or pending migration cannot
silently inherit. Exactly one effective pool is selected; exhaustion tries only
its permissible offerings. User/installation nodes remain same-user and may be
shared across that user's projects. Project pool nodes require same user AND
same project. Explicit node IDs obey identical rules.

Native provisioning must work for an arbitrary supported SKU without a legacy
alias. The provider contract is an additive concrete request (instance type,
storage and image/architecture where needed); legacy callers use one adapter.
Changing a deprecated size hint cannot change a native payload or accounting.

## Implementation checklist

### A. Canonical requirements, pool state and migration (F1, F2, F3, F6, F7, F9, F11)

- [ ] Implement one shared versioned legacy-to-workload adapter, validation,
  per-field precedence and provenance. Cover task/profile/skill/project/platform
  values, defaults, queued plans, retry and recovery. Reject nonfinite/negative
  resources and malformed compatibility constraints consistently.
- [ ] Persist configurable defaults/mapping and strategy weights with validated
  environment fallbacks; expose their effective nonsecret values to clients.
- [ ] Separate pool configuration state from current eligibility. Preserve a
  configured pool when all selections are removed or a source is disabled.
- [ ] Add bounded, resumable, idempotent migration/ensure independent of visiting
  settings; integrate credential create/attach/rotate/disable/delete/re-enable
  lifecycle. Backfill missing modern values with CAS and preserve concurrent
  edits, removals, original values and migration provenance.
- [ ] Separate selected membership from catalog availability/staleness/retirement.
  Cache credential-scoped snapshots with bounded refresh; provider failure or
  incomplete pagination cannot replace a valid catalog with a narrow fallback.
  Returning inventory becomes available without reselecting removed inventory.
- [ ] Make policy edits atomic and revisioned, including effective reconciliation
  changes. Carry exhaustion policy and ranking settings in versioned plans.
  Define queue/fail/intra-pool fallback behavior; do not expose unsupported
  cross-pool semantics or claim settings execute when they do not.
- [ ] Normalize comparable prices to one time unit and same currency; explicitly
  rank unknown/noncomparable prices and preserve owner-defined priority order.
- [ ] Distinguish explicit provider/location/architecture/image/network constraints
  from inherited preferences. Return actionable incompatibility reasons.
  Slice A exports the plan/snapshot/settings fields and provider/location hard
  checks used by pool selection; full architecture/image/network writer wiring
  remains in downstream allocation/runtime slices.

### B. Provider-native contracts and actual hardware (F8)

- [ ] Make legacy size optional for exact-SKU provisioning via a well-defined
  native contract; centralize legacy provider mapping outside native core.
- [ ] Every supported provider uses concrete instance identity and requested or
  included storage/image semantics. Fix UpCloud disk dependence and GCP disk
  mismatch; validate provider limits before paid calls. Test all provider payloads.
- [ ] Persist observed returned provider type/resources when available and label
  unknown observations truthfully. Metering never treats a compatibility tier as
  authoritative hardware metadata.
- [ ] Test arbitrary native SKUs, absent/contradictory legacy hints, storage above
  defaults, image/architecture compatibility, malformed responses and fallback
  legacy requests. Keep provider API contract citations with validation evidence.

### C. All allocation writers and final admission (F4, F5, F6, F10, F11)

- [ ] Incorporate and adapt #2021 aggregate reservation implementation. One shared
  policy accounts for active reservations at advisory selection AND final atomic
  D1 insertion. Enforce finite memory/headroom, CPU-share budgets, storage and
  exclusivity. Preserve old count caps only as compatibility safety settings;
  do not introduce a co-tenant-count product model.
- [ ] Wire canonical requirements through submit/run/MCP/chat/trigger/dispatch,
  retry/recovery and direct workspace/node APIs. Enumerate every node/workspace
  insert/provision writer and route it through shared scope/admission contracts.
- [ ] Direct node IDs validate user/project/pool/source/role/capacity atomically;
  deployment nodes cannot become task hosts accidentally. Deployment provisioning
  uses an explicit canonical role adapter and preserves provider/location/volume
  affinity for existing stateful services; incompatible moves fail visibly.
- [ ] Safely classify/adopt legacy unpooled nodes from verified provider/account
  metadata or mark them grandfathered/draining without interrupting active work.
  Unknown provider/source/type must not masquerade as the chosen pool candidate.
- [ ] Apply pack/smallest-fit/balanced/spread semantics to reuse and provisioning;
  test each supported strategy's distinct behavior. Normalize CPU/load units and
  memory signals; use disk pressure as a veto and configurable host headroom.
- [ ] Preserve shared admission/backpressure across sizes/offerings. Distinguish
  source/account capacity cooldown from SKU/region scarcity. Queue age, reuse,
  resource headroom, compatibility translation and rejection reasons are observable.
- [ ] Recheck pool revision, candidate membership, source credential generation,
  deletion/lifecycle state and aggregate capacity before paid allocation/final
  placement. Race tests cover last capacity, concurrent edits, source revocation,
  credential rotation and simultaneous different-size requests.
- [ ] Keep Cloudflare Containers an explicit runtime or configured last resort;
  never silently change runtime or project credential authority on exhaustion.
- [ ] Delete uncalled size-based selector code and obsolete tests after inventory.

### D. All supported writers/displays and upgrade documentation (F12)

- [ ] Replace legacy-only controls in ChatInput profile setup, ProfileFormDialog,
  SkillFormDialog, ProjectSettings, TaskSubmitForm, TriggerAdvancedOptions,
  CreateWorkspace and Nodes with workload requirements/inheritance and appropriate
  native offerings. Old values remain understandable and editable safely.
- [ ] Session infrastructure, workspace sidebar, deployment detail, node/usage
  pages show actual provider/type/resources; unknown historical identity is marked
  as a compatibility estimate. Never put a SKU in a vmSize field.
- [ ] Add a concise safe effective-pool summary, including installation-funded
  capacity, and why-this-node information from the canonical plan without exposing
  administrator credentials. Show queue, empty/unavailable pool and migration states.
- [ ] Update MCP dispatch/profile/trigger schemas and handlers together, plus CLI
  modern resource inputs and native output. Retain deprecated --vm-size and old
  API fields with deterministic translation and appropriate deprecation guidance.
- [ ] Update public workspace/idea-execution/configuration/provider docs, API/env
  references and provider AGENTS guidance. Add user-facing upgrade/rollback and
  compatibility-window instructions tied to actual code and migration diagnostics.
- [ ] Capture/review Playwright screenshots of every changed surface at 375x667
  and 1280x800 with normal, long, empty, many-item and error states; assert no
  horizontal overflow. Post evidence to the single final PR.

### E. No-leakage gates and release validation

- [ ] Add a tested boundary/architecture gate banning legacy-size authority in
  canonical placement/provider/metering code outside named compatibility modules.
  Inventory allocation writers in a checked contract. Allow historical migrations,
  adapter fixtures, labeled historical displays and unrelated responsive CSS.
- [ ] Add upgrade fixtures for pre-pool, abstract-candidate, native-with-removals,
  and queued/current-plan states. Test clean installation-only, personal and
  multi-member project credentials. Assert row/FK preservation and resumable CAS.
- [ ] Add shadow comparison/rollout diagnostics with structured difference reasons
  and configurable cohort/behavior rollout; authorization fences stay unconditional.
  Retain additive data and compatible plan readers through rollback.
- [ ] Cover old browser/API/CLI/MCP payloads, old agents, sleeping-session wake,
  queued retry, credential/provider change and explicit modern precedence in
  capability tests through the actual entry point to provider/atomic reservation.
- [ ] Run lint, typecheck, test, build and real Workers/D1 race/migration suites,
  provider payload tests, CLI Go scenario tests/coverage and visual checks.
- [ ] Complete all local /do specialist reviews, fix every correctness finding,
  and run task-completion validation before archive.
- [ ] Coordinate shared staging; deploy one pinned integrated candidate. Exercise
  fresh/legacy requests, default credentials, native catalog edits, empty-pool
  failure, reuse/burst admission, direct workspace and safe recovery on real VMs.
  Verify heartbeat, requested resources, persisted plan and observed hardware;
  clean staging to zero VMs immediately afterward.
- [ ] Open the single PR, attach concrete validation/review/screenshot evidence,
  obtain green checks, trigger CodeRabbit with coderabbit-review label and resolve
  all feedback. Leave open for user review; no merge requested in this task.

## Acceptance

Every checklist item above is required. Each implementation slice returns commit
SHAs, exact commands/results, tests linked to its criteria and remaining integration
requirements. Completion requires evidence on the integrated final candidate,
not only the child branch or an earlier PR. No criterion may be silently deferred
to another PR or replaced by documentation claiming unimplemented behavior.

## Integration review status

The canonical policy contracts are integrated for dependent implementation, but
section A is not accepted yet. Independent review found precedence, resumable
backfill, D1 bind accounting, reconciliation concurrency, blocked pool-state,
price comparison, and settings provenance gaps. Corrective implementation and
discriminating regressions are required before these items can be checked off.
The narrow legacy-boundary test is an initial guard; the complete allocation-writer
inventory and cross-boundary no-leakage gate remain part of section E.

## Recovery checkpoint — 2026-09-07

The original coordinator runtime was lost before release validation. Its pushed
integration head `2e6978a8c` was recovered with current main `bef83db2d` onto
`sam/use-sam-mcp-tools-n1hapw`. Completed resource-form changes through
`4aa0c61a4` were integrated at `cb374d6f7`; integration is not acceptance.

The original current-authority/direct-allocation, request-persistence, and
pool-reconciliation agents continue their existing assignments. Their subsequent
checkpoints require inspection and integrated validation. Form browser validation
has a dedicated completion assignment because the prior handoff did not exercise
the actual profile dialog, skill, trigger, task-submit, or profile-wizard surfaces.

Remaining dependent work includes runtime strategy/exhaustion/backpressure and
recovery integration, native resource/effective-pool diagnostics, comprehensive
compatibility/upgrade gates, documentation, final specialist reviews, and one
coordinated staging sweep. Every original criterion remains required. The final
deliverable is one green **open** PR; no merge is authorized by this request.

## E1 boundary-gate checkpoint — 2026-09-07

This checkpoint adds an executable architecture gate for section E without
checking off section E acceptance. The gate lives in
`scripts/quality/node-pool-boundary.ts`, is runnable with
`pnpm quality:node-pool-boundary`, and is exercised by
`apps/api/tests/unit/services/node-pool-legacy-boundary.test.ts`.

Accepted exclusions are narrow and source-parsed:

- named compatibility modules:
  `apps/api/src/services/legacy-node-pool-compatibility.ts`,
  `packages/providers/src/native-vm-config.ts`,
  `packages/providers/src/instance-offerings.ts`, and
  `packages/providers/src/types.ts`
- historical display lines only when the nearby source is explicitly labeled
  `node-pool-boundary: historical display` or
  `node-pool-boundary: compatibility estimate`
- historical migrations and test fixtures are excluded by the scanner roots;
  injected fixture tests still pass through the real scanner
- unrelated responsive CSS is excluded by AST identifier matching rather than a
  broad text scan

Checked allocation writer inventory:

| Table           | Entrypoint                                                         | Role / canonical boundary                                                           |
| --------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `tasks`         | `apps/api/src/routes/tasks/submit.ts`                              | user task submit route adapter; `resolveTaskStartPlacement` -> `startTaskRunnerDO`  |
| `tasks`         | `apps/api/src/routes/mcp/dispatch-tool.ts`                         | MCP dispatch adapter; `resolveTaskStartPlacement` -> `startTaskRunnerDO`            |
| `tasks`         | `apps/api/src/routes/mcp/orchestration-tools.ts`                   | MCP orchestration retry adapter; `resolveTaskStartPlacement` -> `startTaskRunnerDO` |
| `tasks`         | `apps/api/src/services/trigger-submit.ts`                          | trigger submission adapter; `resolveTaskStartPlacement` -> `startTaskRunnerDO`      |
| `tasks`         | `apps/api/src/durable-objects/sam-session/tools/dispatch-task.ts`  | SAM session dispatch adapter; `resolveTaskStartPlacement` -> `startTaskRunnerDO`    |
| `tasks`         | `apps/api/src/durable-objects/sam-session/tools/retry-subtask.ts`  | SAM session retry adapter; `resolveTaskStartPlacement` -> `startTaskRunnerDO`       |
| `tasks`         | `apps/api/src/services/session-recovery.ts`                        | sleeping wake recovery adapter; `resolveTaskStartPlacement` -> `startTaskRunnerDO`  |
| `tasks`         | `apps/api/src/routes/workspaces/crud.ts`                           | explicit legacy direct workspace route adapter                                      |
| `tasks`         | `apps/api/src/routes/tasks/crud.ts`                                | explicit non-running task metadata adapter                                          |
| `tasks`         | `apps/api/src/routes/chat.ts`                                      | explicit conversation task compatibility adapter                                    |
| `tasks`         | `apps/api/src/routes/chat-start.ts`                                | explicit conversation-start compatibility adapter                                   |
| `tasks`         | `apps/api/src/routes/mcp/idea-tools.ts`                            | explicit idea materialization adapter                                               |
| `tasks`         | `apps/api/src/durable-objects/sam-session/tools/create-idea.ts`    | explicit idea materialization adapter                                               |
| `tasks`         | `apps/api/src/services/debug-agent.ts`                             | explicit diagnostic adapter                                                         |
| `tasks`         | `apps/api/src/services/platform-feedback-triage/runner.ts`         | explicit feedback triage adapter                                                    |
| `tasks`         | `apps/api/src/services/platform-feedback-incidents/user-report.ts` | explicit feedback incident adapter                                                  |
| `tasks`         | `apps/api/src/services/trial/trial-runner.ts`                      | explicit trial runtime adapter                                                      |
| `tasks`         | `apps/api/src/services/session-task-repair.ts`                     | explicit repair adapter                                                             |
| `nodes`         | `apps/api/src/services/nodes.ts`                                   | canonical node row writer: `createNodeRecord`                                       |
| `workspaces`    | `apps/api/src/services/workspace-placement.ts`                     | canonical final placement writer: `reserveWorkspacePlacement`                       |
| `workspaces`    | `apps/api/src/routes/workspaces/crud.ts`                           | explicit legacy direct workspace route adapter                                      |
| `workspaces`    | `apps/api/src/services/instant-session.ts`                         | explicit `cf-container` runtime adapter                                             |
| `workspaces`    | `apps/api/src/durable-objects/trial-orchestrator/steps.ts`         | explicit trial runtime adapter                                                      |
| `compute_usage` | `apps/api/src/services/compute-usage.ts`                           | canonical metering writer: `startComputeTracking`                                   |

Remaining upgrade / capability test matrix:

| Scenario                       | Existing tests found                                                                                                                                                                                                                            | Missing before section E can be accepted                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| pre-pool rows                  | `apps/api/tests/unit/db/capacity-pool-migration.test.ts`, `apps/api/tests/integration/workspace-dispatch-race.test.ts`, `packages/shared/tests/unit/resource-defaults.test.ts`                                                                  | end-to-end upgrade fixture proving task/node/workspace row and FK preservation through provider/atomic reservation                              |
| abstract candidate rows        | `packages/shared/tests/unit/capacity-pool.test.ts`, `apps/api/tests/unit/services/capacity-pools.test.ts`, `apps/api/tests/unit/routes/project-capacity-pools.test.ts`                                                                          | migration-stage fixture for abstract candidate -> native candidate resolution and resumable CAS                                                 |
| native removal / catalog drift | `packages/providers/tests/unit/provider-native-vm-contract.test.ts`, `packages/providers/tests/unit/instance-offerings.test.ts`, `apps/api/tests/unit/services/runtime-allocation.test.ts`                                                      | fixture proving old native plan survives when a later catalog removes or renames the offering                                                   |
| old queued plan                | `apps/api/tests/unit/routes/mcp.test.ts`, `apps/api/tests/integration/node-selection.test.ts`, `apps/api/tests/unit/services/trigger-submit-capacity-pools.test.ts`                                                                             | queued-task fixture through actual TaskRunner provider/atomic reservation after pool/settings edits                                             |
| old agent                      | `apps/api/tests/unit/routes/node-lifecycle-byo.test.ts`, `apps/api/tests/unit/node-callback-scope-enforcement.test.ts`, `apps/api/tests/unit/routes/node-acp-heartbeat.test.ts`                                                                 | capability fixture proving old agent payloads preserve native placement snapshots and do not reintroduce legacy authority                       |
| sleeping wake                  | `apps/api/tests/unit/services/session-recovery.test.ts`, `apps/api/tests/unit/services/project-data-snapshot-recovery-wake.test.ts`, `apps/api/tests/unit/wake-progress.test.ts`, `apps/api/tests/integration/session-recovery-handoff.test.ts` | sleeping wake through actual provider/atomic reservation with old plan and source-affinity constraints                                          |
| installation credentials       | `apps/api/tests/workers/composable-credentials-wiring.test.ts`, `apps/api/tests/integration/composable-credentials-routes.test.ts`, `apps/api/tests/unit/resolve-credential-source.test.ts`                                                     | clean installation-only pool fixture through node-pool placement and metering attribution                                                       |
| personal credentials           | `apps/api/tests/unit/routes/credentials.test.ts`, `apps/api/tests/unit/routes/providers-scopes-real-sql.test.ts`, `apps/api/tests/workers/composable-credentials-wiring.test.ts`                                                                | personal pool fixture with no project override, proving old and native payload parity through placement                                         |
| multi-member credentials       | `apps/api/tests/unit/services/workspace-runtime-assets-shared-project.test.ts`, `apps/api/tests/unit/services/project-multiplayer.test.ts`                                                                                                      | multi-member project-scoped pool fixture proving shared project resource access, user-scoped node isolation, and correct credential attribution |

E2 remains dependent work: full capability instrumentation, shadow rollout and
structured difference diagnostics, public/operator documentation, final local
specialist review evidence, full quality suite, and one coordinated staging
sweep on the integrated candidate.

Current `pnpm quality:node-pool-boundary` violations at this checkpoint: 76
legacy-authority findings, no unexpected allocation-writer findings.

- `apps/api/src/durable-objects/task-runner/node-provisioning-admission.ts`:
  line 63 reads `state.config.vmSize` in provisioning admission diagnostics.
- `apps/api/src/durable-objects/task-runner/node-provisioning-target.ts`: line
  15 reads/writes `state.config.vmSize` while adapting a selected candidate.
- `apps/api/src/durable-objects/task-runner/node-selection.ts`: line 8 imports
  `canSatisfyVmSize`; lines 295, 296, 503, 525, 526, 566 and 597 read
  `vmSize`; line 597 calls `canSatisfyVmSize`.
- `apps/api/src/durable-objects/task-runner/node-steps.ts`: line 9 imports
  `vmSizeFallbackChain`; lines 185, 250, 313, 314, 322 and 766 read/write
  `vmSize`; line 535 calls `vmSizeFallbackChain`.
- `apps/api/src/durable-objects/task-runner/workspace-steps.ts`: lines 227 and
  388 read `state.config.vmSize` for workspace placement/metering handoff.
- `apps/api/src/services/compute-usage.ts`: line 8 imports `getVcpuCount`;
  line 55 calls `getVcpuCount` and reads `input.vmSize`; line 63 stores
  `serverType` from `input.vmSize`.
- `apps/api/src/services/deployment-provisioning.ts`: lines 131, 177, 178,
  239 and 395 read `placement.vmSize` / candidate `vmSize` in deployment
  placement/provisioning.
- `apps/api/src/services/node-selector.ts`: line 3 imports
  `canSatisfyVmSize`; lines 164, 185, 187, 188, 243, 281, 309, 332 and 333
  read `vmSize`; lines 185 and 281 call `canSatisfyVmSize`.
- `apps/api/src/services/node-usage.ts`: line 9 imports `getVcpuCount`; line
  123 includes `vmSize` in the selected node type; lines 156, 233, 275, 312,
  313, 317, 346 and 350 read `vmSize`; lines 156, 317 and 350 call
  `getVcpuCount`.
- `apps/api/src/services/nodes.ts`: lines 272, 298, 527, 674 and 693 read
  `vmSize` in canonical node/provisioning code.
- `apps/api/src/services/placement-resolver-capacity.ts`: lines 421, 424 and
  449 read node `vmSize` as fallback capacity evidence.
- `apps/api/src/services/placement-resolver.ts`: lines 139, 140, 225 and 526
  read explicit/profile/project `vmSize` values in the canonical resolver.
- `apps/api/src/services/workspace-placement.ts`: line 224 writes
  `input.vmSize` into the workspace placement insert.
