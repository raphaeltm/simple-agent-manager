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
