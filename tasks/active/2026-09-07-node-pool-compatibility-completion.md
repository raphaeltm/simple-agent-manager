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

## E1 boundary-gate checkpoint — 2026-09-07 (corrected after adversarial review)

This checkpoint adds an executable architecture gate for section E without
checking off section E acceptance. The first cut (`93bfa4246`) was reviewed
adversarially with injected fixtures and found evadable in eight ways; the
corrections are recorded in
`tasks/active/2026-09-07-e1-node-pool-boundary-scanner-corrections.md`.

The gate lives in `scripts/quality/node-pool-boundary.ts` (modules under
`scripts/quality/node-pool-boundary/`), is runnable with
`pnpm quality:node-pool-boundary` (`:report` for a non-failing listing), and is
exercised by `apps/api/tests/unit/services/node-pool-legacy-boundary.test.ts`.

What the gate enforces:

1. **Legacy VM-tier authority** — importing, aliasing, namespacing or calling
   `getVcpuCount`, `canSatisfyVmSize` or `vmSizeFallbackChain`; READING the
   `PROVIDER_VM_CAPACITY`, `PLATFORM_RESOURCE_DEFAULTS` or `VM_SIZE_ORDER` tables
   through any name or namespace; using a legacy size as a catalog lookup key or
   an eligibility/ranking comparison; and writing a legacy size into a
   provider-native SKU or resource/accounting field. Reported anywhere in
   `apps/api/src` and `packages/providers/src`. Legacy-size aliases are resolved
   lexically, with parameter shadowing, and statically computed field names
   (`const key = 'vm' + 'Size'`) resolve.
2. **Legacy size reads inside canonical authority scope** — matched by canonical
   directory and by family token in the module name, so a newly created
   `services/placement-ranking.ts` is in scope on creation rather than needing a
   filename-list edit.
3. **Allocation writers** — every `INSERT` into `tasks` / `nodes` / `workspaces`
   / `compute_usage`, owned per enclosing function.
4. **Allocation and provisioning entrypoints** — `createNodeRecord`,
   `provisionNode`, `reserveWorkspacePlacement`, `createWorkspaceOnNode`,
   `provider.createVM` and `startComputeTracking` call sites, resolved through
   import aliases, each carrying an explicit scope, role and admission contract.
   Only genuine self-recursion of a symbol the module itself declares is exempt.

Accepted exclusions are narrow, source-parsed and paired with tests:

- named compatibility modules:
  `apps/api/src/services/legacy-node-pool-compatibility.ts`,
  `packages/shared/src/constants/vm-sizes.ts`,
  `packages/shared/src/constants/resource-defaults.ts`,
  `packages/providers/src/native-vm-config.ts`,
  `packages/providers/src/instance-offerings.ts`, and
  `packages/providers/src/types.ts`
- structural classifications that are never authority: type positions, persisted
  transport (`.bind(...)`, `.values({...})`), audit/diagnostic metadata
  properties, legacy→legacy propagation, and presence guards on deprecated
  request fields. Old persisted legacy columns are NOT required to be removed.
- five reviewed deprecated-request-field validators declared in
  `REVIEWED_LEGACY_REQUEST_VALIDATORS`, keyed by file plus owning function, each
  with a written reason. The exception covers comparison classifications only; a
  catalog lookup or authority call in the same function is still reported.
- **There is no free-form source-comment bypass.** The previous
  `node-pool-boundary: historical display` neighbouring-line escape hatch is
  removed, because it suppressed a real `offers[node.vmSize]` allocation read.
- historical migrations and test fixtures are excluded by the scanner roots;
  injected fixture tests still run through the real scanner functions.

Checked allocation writer inventory (24 entries, owner-scoped):

| Table           | Entrypoint                                                         | Owning function             | Role / canonical boundary                                                           |
| --------------- | ------------------------------------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------- |
| `tasks`         | `apps/api/src/routes/tasks/submit.ts`                              | `post /submit`              | user task submit route adapter; `resolveTaskStartPlacement*` -> `startTaskRunnerDO` |
| `tasks`         | `apps/api/src/routes/mcp/dispatch-tool.ts`                         | `handleDispatchTask`        | MCP dispatch adapter; same canonical pair                                           |
| `tasks`         | `apps/api/src/routes/mcp/orchestration-tools.ts`                   | `handleRetrySubtask`        | MCP orchestration retry adapter; same canonical pair                                |
| `tasks`         | `apps/api/src/services/trigger-submit.ts`                          | `submitTriggeredTask`       | trigger submission adapter; same canonical pair                                     |
| `tasks`         | `apps/api/src/durable-objects/sam-session/tools/dispatch-task.ts`  | `dispatchTask`              | SAM session dispatch adapter; same canonical pair                                   |
| `tasks`         | `apps/api/src/durable-objects/sam-session/tools/retry-subtask.ts`  | `retrySubtask`              | SAM session retry adapter; same canonical pair                                      |
| `tasks`         | `apps/api/src/services/session-recovery.ts`                        | `createRecoveryTask`        | sleeping wake recovery adapter; same canonical pair                                 |
| `tasks`         | `apps/api/src/routes/workspaces/crud.ts`                           | `post /`                    | explicit legacy direct workspace route adapter                                      |
| `tasks`         | `apps/api/src/routes/tasks/crud.ts`                                | `post /`                    | explicit non-running task metadata adapter                                          |
| `tasks`         | `apps/api/src/routes/chat.ts`                                      | `post /`                    | explicit conversation task compatibility adapter                                    |
| `tasks`         | `apps/api/src/routes/chat-start.ts`                                | `post /start`               | explicit conversation-start compatibility adapter                                   |
| `tasks`         | `apps/api/src/routes/mcp/idea-tools.ts`                            | `handleCreateIdea`          | explicit idea materialization adapter                                               |
| `tasks`         | `apps/api/src/durable-objects/sam-session/tools/create-idea.ts`    | `createIdea`                | explicit idea materialization adapter                                               |
| `tasks`         | `apps/api/src/services/debug-agent.ts`                             | `saveDebugDiagnosisAsIdea`  | explicit diagnostic adapter                                                         |
| `tasks`         | `apps/api/src/services/platform-feedback-triage/runner.ts`         | `runPlatformFeedbackTriage` | explicit feedback triage adapter                                                    |
| `tasks`         | `apps/api/src/services/platform-feedback-incidents/user-report.ts` | `upsertUserReportIncident`  | explicit feedback incident adapter                                                  |
| `tasks`         | `apps/api/src/services/trial/trial-runner.ts`                      | `startDiscoveryAgent`       | explicit trial runtime adapter                                                      |
| `tasks`         | `apps/api/src/services/session-task-repair.ts`                     | `ensureSessionTaskBacked`   | explicit repair adapter                                                             |
| `nodes`         | `apps/api/src/services/nodes.ts`                                   | `createNodeRecord`          | canonical node row writer                                                           |
| `workspaces`    | `apps/api/src/services/workspace-placement.ts`                     | `reserveWorkspacePlacement` | canonical final placement writer                                                    |
| `workspaces`    | `apps/api/src/routes/workspaces/crud.ts`                           | `post /`                    | explicit legacy direct workspace route adapter                                      |
| `workspaces`    | `apps/api/src/services/instant-session.ts`                         | `acceptInstantSession`      | explicit `cf-container` runtime adapter                                             |
| `workspaces`    | `apps/api/src/durable-objects/trial-orchestrator/steps.ts`         | `handleWorkspaceCreation`   | explicit trial runtime adapter                                                      |
| `compute_usage` | `apps/api/src/services/compute-usage.ts`                           | `startComputeTracking`      | canonical metering writer                                                           |

Checked allocation/provision entrypoint inventory (22 call sites, including the
single `provider.createVM` boundary). `status` is an honest classification of what
each call site does today, not an approval:

| Entrypoint                  | Callsite                                                                       | Scope / role             | Status                |
| --------------------------- | ------------------------------------------------------------------------------ | ------------------------ | --------------------- |
| `createNodeRecord`          | `durable-objects/task-runner/node-steps.ts` `handleNodeProvisioning`           | task-runner / workspace  | canonical             |
| `provisionNode`             | `durable-objects/task-runner/node-steps.ts` `handleNodeProvisioning`           | task-runner / workspace  | canonical             |
| `reserveWorkspacePlacement` | `task-runner/workspace-steps.ts` `createAndProvisionWorkspace`                 | task-runner / workspace  | canonical             |
| `startComputeTracking`      | `task-runner/workspace-steps.ts` `startComputeTrackingBestEffort`              | task-runner / metering   | canonical             |
| `createWorkspaceOnNode`     | `task-runner/workspace-steps.ts` `createWorkspaceOnVmAgent`                    | task-runner / workspace  | runtime-dispatch      |
| `createWorkspaceOnNode`     | `routes/workspaces/_helpers.ts` `scheduleWorkspaceCreateOnNode`                | route / workspace        | runtime-dispatch      |
| `createWorkspaceOnNode`     | `routes/node-lifecycle.ts` `post /:id/ready`                                   | route / workspace        | runtime-dispatch      |
| `startComputeTracking`      | `routes/workspaces/crud.ts` `startComputeTrackingForNode`                      | route / metering         | runtime-dispatch      |
| `createNodeRecord`          | `services/deployment-provisioning.ts` `provisionDeploymentNode`                | service / deployment     | role-adapter          |
| `provisionNode`             | `services/deployment-provisioning.ts` `provisionDeploymentNode`                | service / deployment     | role-adapter          |
| `createNodeRecord`          | `services/instant-session.ts` `acceptInstantSession`                           | service / instant        | runtime-adapter       |
| `createWorkspaceOnNode`     | `services/instant-session.ts` `continueInstantSessionLaunch`                   | service / instant        | runtime-dispatch      |
| `createNodeRecord`          | `durable-objects/trial-orchestrator/steps.ts` `handleNodeProvisioning`         | trial / trial            | runtime-adapter       |
| `provisionNode`             | `durable-objects/trial-orchestrator/steps.ts` `handleNodeProvisioning`         | trial / trial            | runtime-adapter       |
| `createWorkspaceOnNode`     | `durable-objects/trial-orchestrator/steps.ts` `handleWorkspaceCreation`        | trial / trial            | runtime-dispatch      |
| `createNodeRecord`          | `routes/nodes.ts` `post /`                                                     | route / workspace        | **unreviewed-bypass** |
| `provisionNode`             | `routes/nodes.ts` `post /`                                                     | route / workspace        | **unreviewed-bypass** |
| `createNodeRecord`          | `routes/workspaces/crud.ts` `post /`                                           | route / workspace        | **unreviewed-bypass** |
| `provisionNode`             | `routes/workspaces/crud.ts` `post /`                                           | route / workspace        | **unreviewed-bypass** |
| `createNodeRecord`          | `services/session-snapshot-upload-relay.ts` `ensureSessionSnapshotUploadRelay` | service / recovery-relay | **unreviewed-bypass** |
| `provisionNode`             | `services/session-snapshot-upload-relay.ts` `ensureSessionSnapshotUploadRelay` | service / recovery-relay | **unreviewed-bypass** |

Remaining upgrade / capability test matrix:

| Scenario                       | Existing tests found                                                                                                                                                                                                                            | Missing before section E can be accepted                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| pre-pool rows                  | `apps/api/tests/unit/db/capacity-pool-migration.test.ts`, `apps/api/tests/integration/workspace-dispatch-race.test.ts`, `packages/shared/tests/unit/resource-defaults.test.ts`                                                                  | end-to-end upgrade fixture proving task/node/workspace row and FK preservation through provider/atomic reservation                              |
| abstract candidate rows        | `packages/shared/tests/unit/capacity-pool.test.ts`, `apps/api/tests/unit/services/capacity-pools.test.ts`, `apps/api/tests/unit/routes/project-capacity-pools.test.ts`                                                                          | migration-stage fixture for abstract candidate -> native candidate resolution and resumable CAS                                                 |
| native removal / catalog drift | `packages/providers/tests/unit/provider-native-vm-contract.test.ts`, `packages/providers/tests/unit/instance-offerings.test.ts`, `apps/api/tests/unit/services/runtime-allocation.test.ts`                                                      | **corrected**: see the dedicated block below — the previous row asserted the wrong contract                                                     |
| old queued plan                | `apps/api/tests/unit/routes/mcp.test.ts`, `apps/api/tests/integration/node-selection.test.ts`, `apps/api/tests/unit/services/trigger-submit-capacity-pools.test.ts`                                                                             | queued-task fixture through actual TaskRunner provider/atomic reservation after pool/settings edits                                             |
| old agent                      | `apps/api/tests/unit/routes/node-lifecycle-byo.test.ts`, `apps/api/tests/unit/node-callback-scope-enforcement.test.ts`, `apps/api/tests/unit/routes/node-acp-heartbeat.test.ts`                                                                 | capability fixture proving old agent payloads preserve native placement snapshots and do not reintroduce legacy authority                       |
| sleeping wake                  | `apps/api/tests/unit/services/session-recovery.test.ts`, `apps/api/tests/unit/services/project-data-snapshot-recovery-wake.test.ts`, `apps/api/tests/unit/wake-progress.test.ts`, `apps/api/tests/integration/session-recovery-handoff.test.ts` | sleeping wake through actual provider/atomic reservation with old plan and source-affinity constraints                                          |
| installation credentials       | `apps/api/tests/workers/composable-credentials-wiring.test.ts`, `apps/api/tests/integration/composable-credentials-routes.test.ts`, `apps/api/tests/unit/resolve-credential-source.test.ts`                                                     | clean installation-only pool fixture through node-pool placement and metering attribution                                                       |
| personal credentials           | `apps/api/tests/unit/routes/credentials.test.ts`, `apps/api/tests/unit/routes/providers-scopes-real-sql.test.ts`, `apps/api/tests/workers/composable-credentials-wiring.test.ts`                                                                | personal pool fixture with no project override, proving old and native payload parity through placement                                         |
| multi-member credentials       | `apps/api/tests/unit/services/workspace-runtime-assets-shared-project.test.ts`, `apps/api/tests/unit/services/project-multiplayer.test.ts`                                                                                                      | multi-member project-scoped pool fixture proving shared project resource access, user-scoped node isolation, and correct credential attribution |

### Corrected native-offering-removal row

The previous row required a fixture "proving the old native plan survives when a
later catalog removes or renames the offering". That is the wrong contract and
would have enshrined a bug. The required behaviour is:

- **Historical metadata survives.** Already-provisioned nodes, workspaces,
  metering rows and persisted placement plans keep their recorded offering
  identity and observed hardware, and remain readable and displayable after the
  offering leaves the catalog. Nothing is rewritten or blanked.
- **A NEW allocation must revalidate selected membership.** Before a paid
  allocation or final admission, the plan's offering must still be a member of
  the effective pool at the current pool revision. A stale plan may not allocate
  on the strength of its recorded offering alone.
- **Temporary catalog disappearance is distinguished from deliberate removal.**
  A provider outage, a failed refresh or an incomplete/paginated inventory is
  _unknown_, not _removed_: it must not deselect the offering, and returning
  inventory must become available again without reselection. Only an explicit
  owner removal (or a provider-confirmed retirement) deselects it.
- **The expected outcome is fail or re-resolve, never broadening.** On confirmed
  removal, a new allocation either re-resolves within the same effective pool's
  remaining permissible offerings or fails visibly with an actionable reason. It
  must never widen to another pool, another credential source, another provider
  or another region to find capacity.
- **Required fixtures**: (a) removal then re-allocation → fail or in-pool
  re-resolve, with the historical rows unchanged; (b) transient catalog
  disappearance then recovery → no deselection, allocation resumes; (c) an
  assertion that neither path changes pool, source, credential or runtime.

E2 remains dependent work: full capability instrumentation, shadow rollout and
structured difference diagnostics, public/operator documentation, final local
specialist review evidence, full quality suite, and one coordinated staging
sweep on the integrated candidate.

### Current gate state

`pnpm quality:node-pool-boundary` exits 1 with **60 violations**; the scanner's
own regression suite is 50/50 green. These are reported separately on purpose.
The corrected composition, with per-file detail and the triage rationale for
every class that is now correctly NOT reported, is in
`tasks/active/2026-09-07-e1-node-pool-boundary-scanner-corrections.md`.

| Class                                            | Count |
| ------------------------------------------------ | ----: |
| legacy capacity-helper import / call / argument  |    21 |
| legacy size ranking or eligibility comparison    |    20 |
| legacy size read in canonical authority scope    |    13 |
| allocation entrypoint bypassing shared admission |     6 |
| unexpected or unowned allocation writer          |     0 |

The earlier checkpoint reported "76 legacy-authority findings". That number was
not 76 confirmed leaks: it included blanket `.vmSize` matches on types, persisted
columns, audit metadata and deprecated-field presence checks, while missing every
aliased, namespaced, destructured and non-`INSERT` allocation path. It should not
be compared with the 60 above as a before/after improvement.

Affected application files, for the owning slices:
`durable-objects/task-runner/node-selection.ts` (12),
`durable-objects/task-runner/node-steps.ts` (11),
`services/node-selector.ts` (9), `services/node-usage.ts` (7),
`services/deployment-provisioning.ts` (4), `services/placement-resolver.ts` (3),
`services/default-capacity-pool-candidates.ts` (3),
`services/compute-usage.ts` (3),
`services/session-snapshot-upload-relay.ts` (2),
`services/placement-resolver-capacity.ts` (2), `routes/workspaces/crud.ts` (2),
`routes/nodes.ts` (2).
