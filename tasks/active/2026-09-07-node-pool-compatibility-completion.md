# Complete canonical node-pool placement and safe legacy upgrades

## Problem

Provider-native pools work, but legacy VM tiers still influence request writers,
provider configuration and displays. Some allocation paths bypass pool selection,
empty pools can disappear from precedence, catalog refresh can change selection
intent, and saved policies are not consistently enforced. Existing clients,
configuration and active/sleeping workloads must survive the transition.

Deliver all fixes together in one PR. Implementation branches are integration
inputs only; final release work stays in this parent session. On September 8,
the user authorized staging verification, cleanup, iteration, and merge after
successful validation, followed by production deployment monitoring.
No SAM task dispatches. CodeRabbit is waived for this PR under its file limit.

## Historical local-only reconciliation checkpoint — 2026-09-08

Resumed PR #2030 from `7ba09bb9d` under a three-hour local-work window. The
previous repair CI run `34136000309` completed successfully with every executed
job passing. The remaining GitHub blocker was the merge with current `main`.
All 15 conflicts with `main` at `6895aacd5` are now reconciled locally. Native
pool/credential authority, observed hardware, telemetry admission and D1 bind
batching remain authoritative; upstream aggregate-capacity simulations and
lifecycle/race assertions are adapted to those contracts. Persisted warm-node
claims now repeat the capacity check before reuse.

Initial reconciliation validation: API typecheck passes; 260 focused API tests
across seven files pass; all 13 aggregate-capacity simulation cases pass. The
first Workers run identified a ported lifecycle fixture whose positive controls
omitted the explicit reservation/policy. The fixture is corrected and the final
four-suite Workers run is pending. These results are local, with no live-cloud
or staging claim.

Sonar findings are being addressed with explicit binary-order string comparison,
boolean bit-flag checks, trusted Git executable locations and the existing Docker
executable resolver. Scanner trust regressions pass 4/4; Go sysinfo/container
tests pass, including a regression that fails before honoring the configured
Docker executable. Automatic-analysis CPD exclusions are aligned for 15 reviewed
test-fixture paths already covered by the canonical test-only policy. Production
SQL remains analyzed and its duplicate admission CTE/eligibility predicates are
shared without changing either atomic mutation's query or ordered bindings.

**The later September 8 release instruction supersedes the local-only scope.**
The user authorizes staging, cleanup and merge after successful verification.
[PR #2030](https://github.com/raphaeltm/simple-agent-manager/pull/2030) records the
current release candidate, live evidence, checks and deployment outcome.

## Previous continuation status — 2026-09-07

This section records the September 7 checkpoint and its then-current scope.
Recovered head: `8ccc610d6`; integrated corrections: `27a7a1abe`,
`4196ad57f`, `fabce54a7`, and `9524491af`. The deliverable then was a green OPEN PR.
Merge and SAM-agent dispatch were not authorized at that checkpoint. The earlier
local-only instruction was interpreted as excluding staging, without a waiver
of the original staging criterion. The September 8 instruction above now governs.
Implementation and verification continue in this parent session.

**Gate at that checkpoint: implementation and local specialist corrections were integrated;
final release verification and PR/CI/CodeRabbit remain incomplete.** Checked
implementation boxes mean the code and relevant regression coverage exist;
they do not substitute for the still-open final validation items in section E.
The task stays active and must not be archived on this checkpoint.

### Verification evidence recorded at the September 7 checkpoint

| Check                                                                              | Current result                                       | Evidence / remaining action                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full repository build                                                              | PASS                                                 | Initial full build: 9 tasks, 451 seconds. Latest full rebuild passed in 149 seconds; `pnpm exec turbo run build --concurrency=1`.                                                                                                                                                                                 |
| Full lint | PASS | All 13 tasks passed; final full run took 351 seconds. |
| Full typecheck | PASS, final test edits need rerun | Full repository typecheck passed in 233 seconds after hardware display typing fix. |
| Joined upgrade/admission matrix                                                    | PASS, 12/12                                          | `node-pool-upgrade-admission.test.ts` and `node-pool-upgrade-boundaries.test.ts`; real task/wake routes and DO serialization through SQL admission, real migration chain with enforced FKs, old JWT heartbeat, real provisioning with provider/DNS HTTP mocked. Log `/tmp/node-pool-upgrade-boundaries-test.log`. |
| Allocation/cleanup neighbors                                                       | PASS, 100 tests across 9 files on final focused runs | Shared current-authority reuse gate, occupied-node cleanup barrier, warm/preferred selection, and runtime/role regressions; final affected rerun 37/37.                                                                                                                                                           |
| Native Hetzner region contract                                                     | PASS, 63/63                                          | Native allocation cannot leave selected region; regression failed before fix even when another region would succeed.                                                                                                                                                                                              |
| Direct-workspace inheritance                                                       | PASS, 3/3 API scenarios                              | Real registered route/SQLite: blank and partial fields inherit project resources; explicit old size still translates deterministically.                                                                                                                                                                           |
| Focused web components                                                             | PASS, 51/51                                          | `project-chat` and `create-workspace` files; `/tmp/node-pools-web-focus.log`. This is not the full web suite.                                                                                                                                                                                                     |
| Wizard Chromium regression                                                         | PASS, 2/2                                            | Actual profile wizard rejects invalid resources and permits correction at 375x667 and 1280x800. Screenshots visually reviewed by coordinator; `/tmp/node-pools-wizard-browser.log`.                                                                                                                               |
| Native hardware Chromium suite | PASS, 104 passed / 40 skipped; usage focus 4/4 | Eight surfaces at mobile/desktop, plus 320px normal cases; unsupported combinations intentionally skipped. Coordinator reviewed normal pairs and focused Usage captures, plus representative stress/error images. |
| Boundary scanner | PASS | Node-pool boundary (48 seconds), migration safety/order, DO migrations, file sizes, wrangler bindings, type boundaries, runtime semantics all passed in final serialized run. |
| Broad API/web/provider/shared/cloud-init tests; Workers/D1 races; Go race/coverage | Full CI found fixtures requiring correction | All eight local API shards completed; affected files being rerun. Web affected suites 143/143 passed. CI CLI and VM Agent suites passed; Workers focused rerun pending. |
| Final PR, CI, CodeRabbit | PR #2030 OPEN against main; final CI/review pending | Consolidated ancestry at f8f204c68; checkpoint 01bf15186 pushed to both branches. Current-tree and PR-range secret scans pass with exact expiring reviewed fixture digests. No merge. |
| Staging                                                                            | NOT PERFORMED — unverified gap                       | Current user says “Keep everything local”; the continuation interprets this as excluding staging deployment. This is not an explicit user waiver. No real-cloud smoke test is claimed; local provider tests mock external HTTP.                                                                                   |

The 4 GB shared host exhausted memory when heavy checks ran concurrently. Those
killed runs are not test results. Heavy verification is now serialized with
bounded workers; exact commands/results are recorded in
`.codex/tmp/node-pools/results.jsonl` and `.do-state.md`.

### Specialist findings and disposition

Local allocation/security/Cloudflare/constitution review found and fixed two
additional races: advisory selection could repeatedly choose nodes rejected by
final authority, and fresh-node cleanup could delete compute after a workspace
attached. Reuse now applies the shared current-authority SQL before ranking;
cleanup atomically claims an unoccupied runtime before strict deletion. Positive,
negative, and mutation/barrier regressions are green.

Local provider/client/Go review fixed native Hetzner cross-region fallback and
fabricated `medium` authority in blank direct-workspace requests. The coordinator
fixed invalid-resource handling in the profile wizard and verified both viewport
regressions with Chromium. Reviewed CLI/VM-agent/configuration paths have no
remaining concrete correctness finding; broad Go execution remains pending.

All seven later A4 findings are resolved with direct publication-interleaving
regressions: orphan-anchor deletion race, mirror membership resurrection,
content/source-bound publication cursor, first NULL selection digest, secret
scrub starvation, concurrent native configuration edits, and same-millisecond
pool edit result ambiguity. The earlier six-finding A4 checkpoint is historical,
not evidence of an unresolved issue. Successful empty API inventory also stays
authoritative through a later static fallback/outage. Fractional backfill batch
sizes are clamped again at `9524491af`; the focused real-SQLite regression passed
(1 passed, 90 skipped by the test-name filter), with the full suite still pending.

Completion validation joined the previously separate upgrade and allocation
proofs. The 12 passing cases cover pre-pool and abstract-candidate upgrades with
actual SQL migrations and enforced foreign keys; installation-only, personal,
and multi-member project credentials; modern precedence; stale queued removal;
sleeping wake after defaults change; old-agent heartbeat preserving native
metadata; paid provisioning payload/observed hardware; and revocation before a
paid request. Existing CLI/browser/MCP input-contract tests converge on the same
resolver and TaskRunner bridge exercised by these joined tests; no claim is made
that every client adapter was repeated against a provider HTTP fixture.

Supporting local reports: `/tmp/node-pools-allocation-review.md`,
`/tmp/node-pools-client-provider-review.md`, and
`/tmp/node-pools-completion-review.md`. Their key outcomes are retained here so
loss of temporary files cannot turn the old checkpoints back into current state.

### Constraint scope and remaining acceptance gaps

Provider/location overrides are hard placement constraints; supported native
image/architecture/disk fields reach exact candidate matching and provider
validation. There was no public per-workload network/VPC/subnet input in the
baseline node/workspace/VM request contracts, and none is introduced here.
Existing provider network configuration is retained: Infomaniak's
`INFOMANIAK_NETWORK_NAME` flows through `provider-credential-codecs.ts` and the
provider factory to the resolved network UUID; GCP retains its existing default
network. Deployment's internal Docker network is a separate compose concern.
The checklist's network wording means preserving those supported paths, not
promising a new network-selection product or silently dropping an existing input.
Deployment provider/location/native identity and persistent-volume affinity keep
their explicit role/authorization adapters.

The upgrade operations documentation is now in public
`reference/configuration.md` under “Upgrading existing compute pools”: additive
migration, pending/empty/disabled/catalog state diagnosis, D1 completion/cursors,
grandfathered nodes, compatible clients, and ranking-only rollback.

No additional concrete runtime implementation omission was established by these
local reviews. The stale VM-size chooser in `guides/idea-execution.md` is corrected
to workload requirements and inheritance, with modern MCP field names and links
to actual upgrade/rollback guidance. This was checked against `TaskSubmitForm`
and MCP parameter normalization; no new API behavior is claimed. Outstanding
acceptance work is the final integrated quality and visual evidence, final
task-completion review against that candidate, and open-PR CI/CodeRabbit completion. The full screenshot matrix still needs its final
pass/skip and reviewed-artifact accounting; the two wizard screenshots alone do
not satisfy every changed surface/state. Staging remains an unverified acceptance gap under the current interpretation
of local-only scope. It must be disclosed in the PR and must not be represented
as an explicit user waiver or a validation pass.

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

- [x] Implement one shared versioned legacy-to-workload adapter, validation,
      per-field precedence and provenance. Cover task/profile/skill/project/platform
      values, defaults, queued plans, retry and recovery. Reject nonfinite/negative
      resources and malformed compatibility constraints consistently.
- [x] Persist configurable defaults/mapping and strategy weights with validated
      environment fallbacks; expose their effective nonsecret values to clients.
- [x] Separate pool configuration state from current eligibility. Preserve a
      configured pool when all selections are removed or a source is disabled.
- [x] Add bounded, resumable, idempotent migration/ensure independent of visiting
      settings; integrate credential create/attach/rotate/disable/delete/re-enable
      lifecycle. Backfill missing modern values with CAS and preserve concurrent
      edits, removals, original values and migration provenance.
- [x] Separate selected membership from catalog availability/staleness/retirement.
      Cache credential-scoped snapshots with bounded refresh; provider failure or
      incomplete pagination cannot replace a valid catalog with a narrow fallback.
      Returning inventory becomes available without reselecting removed inventory.
- [x] Make policy edits atomic and revisioned, including effective reconciliation
      changes. Carry exhaustion policy and ranking settings in versioned plans.
      Define queue/fail/intra-pool fallback behavior; do not expose unsupported
      cross-pool semantics or claim settings execute when they do not.
- [x] Normalize comparable prices to one time unit and same currency; explicitly
      rank unknown/noncomparable prices and preserve owner-defined priority order.
- [x] Distinguish explicit provider/location/architecture/image/network constraints
      from inherited preferences. Return actionable incompatibility reasons.
      The supported native image/architecture/disk fields are wired through direct
      allocation and provider validation. Network scope is the preserved provider
      setup described in the current-status section; no new workload network selector
      is claimed.

### B. Provider-native contracts and actual hardware (F8)

- [x] Make legacy size optional for exact-SKU provisioning via a well-defined
      native contract; centralize legacy provider mapping outside native core.
- [x] Every supported provider uses concrete instance identity and requested or
      included storage/image semantics. Fix UpCloud disk dependence and GCP disk
      mismatch; validate provider limits before paid calls. Test all provider payloads.
- [x] Persist observed returned provider type/resources when available and label
      unknown observations truthfully. Metering never treats a compatibility tier as
      authoritative hardware metadata.
- [x] Test arbitrary native SKUs, absent/contradictory legacy hints, storage above
      defaults, image/architecture compatibility, malformed responses and fallback
      legacy requests. Keep provider API contract citations with validation evidence.

### C. All allocation writers and final admission (F4, F5, F6, F10, F11)

- [x] Incorporate and adapt #2021 aggregate reservation implementation. One shared
      policy accounts for active reservations at advisory selection AND final atomic
      D1 insertion. Enforce finite memory/headroom, CPU-share budgets, storage and
      exclusivity. Preserve old count caps only as compatibility safety settings;
      do not introduce a co-tenant-count product model.
- [x] Wire canonical requirements through submit/run/MCP/chat/trigger/dispatch,
      retry/recovery and direct workspace/node APIs. Enumerate every node/workspace
      insert/provision writer and route it through shared scope/admission contracts.
- [x] Direct node IDs validate user/project/pool/source/role/capacity atomically;
      deployment nodes cannot become task hosts accidentally. Deployment provisioning
      uses an explicit canonical role adapter and preserves provider/location/volume
      affinity for existing stateful services; incompatible moves fail visibly.
- [x] Safely classify/adopt legacy unpooled nodes from verified provider/account
      metadata or mark them grandfathered/draining without interrupting active work.
      Unknown provider/source/type must not masquerade as the chosen pool candidate.
- [x] Apply pack/smallest-fit/balanced/spread semantics to reuse and provisioning;
      test each supported strategy's distinct behavior. Normalize CPU/load units and
      memory signals; use disk pressure as a veto and configurable host headroom.
- [x] Preserve shared admission/backpressure across sizes/offerings. Distinguish
      source/account capacity cooldown from SKU/region scarcity. Queue age, reuse,
      resource headroom, compatibility translation and rejection reasons are observable.
- [x] Recheck pool revision, candidate membership, source credential generation,
      deletion/lifecycle state and aggregate capacity before paid allocation/final
      placement. Race tests cover last capacity, concurrent edits, source revocation,
      credential rotation and simultaneous different-size requests.
- [x] Keep Cloudflare Containers an explicit runtime or configured last resort;
      never silently change runtime or project credential authority on exhaustion.
- [x] Delete uncalled size-based selector code and obsolete tests after inventory.

### D. All supported writers/displays and upgrade documentation (F12)

- [x] Replace legacy-only controls in ChatInput profile setup, ProfileFormDialog,
      SkillFormDialog, ProjectSettings, TaskSubmitForm, TriggerAdvancedOptions,
      CreateWorkspace and Nodes with workload requirements/inheritance and appropriate
      native offerings. Old values remain understandable and editable safely.
- [x] Session infrastructure, workspace sidebar, deployment detail, node/usage
      pages show actual provider/type/resources; unknown historical identity is marked
      as a compatibility estimate. Never put a SKU in a vmSize field.
- [x] Add a concise safe effective-pool summary, including installation-funded
      capacity, and why-this-node information from the canonical plan without exposing
      administrator credentials. Show queue, empty/unavailable pool and migration states.
- [x] Update MCP dispatch/profile/trigger schemas and handlers together, plus CLI
      modern resource inputs and native output. Retain deprecated --vm-size and old
      API fields with deterministic translation and appropriate deprecation guidance.
- [x] Update public workspace/idea-execution/configuration/provider docs, API/env
      references and provider AGENTS guidance. Add user-facing upgrade/rollback and
      compatibility-window instructions tied to actual code and migration diagnostics.
      Upgrade/configuration/provider references and the stale run-dialog VM-size
      row in `guides/idea-execution.md` are updated and source-checked.
- [ ] Capture/review Playwright screenshots of every changed surface at 375x667
      and 1280x800 with normal, long, empty, many-item and error states; assert no
      horizontal overflow. Post evidence to the single final PR.

### E. No-leakage gates and release validation

- [x] Add a tested boundary/architecture gate banning legacy-size authority in
      canonical placement/provider/metering code outside named compatibility modules.
      Inventory allocation writers in a checked contract. Allow historical migrations,
      adapter fixtures, labeled historical displays and unrelated responsive CSS.
- [x] Add upgrade fixtures for pre-pool, abstract-candidate, native-with-removals,
      and queued/current-plan states. Test clean installation-only, personal and
      multi-member project credentials. Assert row/FK preservation and resumable CAS.
- [x] Add shadow comparison/rollout diagnostics with structured difference reasons
      and configurable cohort/behavior rollout; authorization fences stay unconditional.
      Retain additive data and compatible plan readers through rollback.
- [x] Cover old browser/API/CLI/MCP payloads, old agents, sleeping-session wake,
      queued retry, credential/provider change and explicit modern precedence in
      capability tests through the actual entry point to provider/atomic reservation.
- [ ] Run lint, typecheck, test, build and real Workers/D1 race/migration suites,
      provider payload tests, CLI Go scenario tests/coverage and visual checks.
- [x] Complete local /do specialist reviews and correct identified implementation
      findings through `c6d1a987f`, including independent review of snapshot
      context retention on node deletion. Completion and documentation audits
      identified the remaining live validation and release gates below.
- [ ] Reconcile final validation evidence and run task-completion validation
      before archive.
- [ ] Coordinate shared staging; deploy one pinned integrated candidate. Exercise
      fresh/legacy requests, default credentials, native catalog edits, empty-pool
      failure, reuse/burst admission, direct workspace and safe recovery on real VMs.
      Verify heartbeat, requested resources, persisted plan and observed hardware;
      clean staging to zero VMs immediately afterward.
      The September 8 user instruction explicitly authorizes this live gate.
      Record the pinned deployment, actual runtime behavior and confirmed cleanup
      in PR #2030. Earlier local or partially successful staging iterations do
      not substitute for the corrected candidate's complete live verification.
- [ ] Complete the single PR with concrete validation/review/screenshot evidence,
      obtain green current-head checks, then merge and monitor production deployment.
      CodeRabbit is explicitly waived for PR #2030 because of its 100-file limit.

## Acceptance

Every checklist item above records the acceptance criteria. Staging and merge
are authorized by the September 8 continuation; successful live validation and
confirmed cleanup are required before merge. No staging waiver is claimed.
Local verification, CI, and review remain required. Each implementation slice returns commit
SHAs, exact commands/results, tests linked to its criteria and remaining integration
requirements. Completion requires evidence on the integrated final candidate,
not only the child branch or an earlier PR. No criterion may be silently deferred
to another PR or replaced by documentation claiming unimplemented behavior.

## Historical integration review status

This pre-recovery checkpoint is retained for provenance; see Current continuation
status for corrected implementation and outstanding release gates.

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

### Recovery validation and review follow-up

Request-persistence corrective commits are integrated at `eb89a8370`. API typecheck
and 20 focused request-plan, retry, trigger-schema, dispatch-authority, and migration
tests passed. The real Workers/D1 capacity-race suite also passed all six tests.
These checkpoint checks do not replace final integrated acceptance.

The allocation-authority and pool-reconciliation continuations stopped on provider
usage limits. Their pushed application checkpoints were preserved, including
meaningful autosaves. Replacement agents are recovering the remaining changes and
addressing independent review findings on their own branches; failed workspaces
remain untouched. Request authorization and form browser completion continue.

The first executable boundary scanner is available at `93bfa4246` but remains
unaccepted. Independent injected-fixture review found bypasses, metadata false
positives, and incomplete allocation inventory evidence. A dedicated correction
assignment owns those scanner defects. Its initial count of 76 findings is not a
verified count of forbidden authority paths. Runtime, display, rollout, and final
validation requirements remain unchanged.

### Historical recovery ownership

These remote task assignments belong to earlier sessions. They are not active
work instructions for this local-only continuation.

The three original backend continuations terminated on provider usage limits.
Their published checkpoints are preserved; unpublished filesystem recovery has
not been verified. Replacement assignments use those checkpoints and reconstruct
only missing changes, with independent review still required.

| Scope                                       | Current SAM task             | Checkpoint or dependency                                                                 |
| ------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| Allocation authority and direct adapters    | `01M1XFH3SHTKP79YDJ0DMC4CQ2` | Starts from `4e1d67565`; current-default and relay compensation findings remain required |
| Pool reconciliation and settings            | `01M1XFJSHZV180T9WTWDQZJGQC` | Merge `18054bfc3` reviewed; reserves additive migration `0153`                           |
| Request persistence and execution authority | `01M1XH4423TCTD979QVXH4G4WH` | Starts from root `fba14b605`; four independent review findings remain required           |
| Actual resource-form browser proof          | `01M1XDFEQT2VD51Z5XC5CTHH0C` | Completing real component interactions and screenshots                                   |
| Boundary scanner | PASS | Node-pool boundary (48 seconds), migration safety/order, DO migrations, file sizes, wrangler bindings, type boundaries, runtime semantics all passed in final serialized run. |

The pool-reconciliation child's initial baseline typecheck claim was withdrawn:
its command wrapper masked a nonzero exit status. It must rerun after installing
dependencies. This correction does not invalidate the independently executed
root checks on `eb89a8370` described above. No replacement checkpoint is accepted
merely because it is pushed or its task is marked complete.

## A4 resume checkpoint — 2026-09-07 (branch `sam/resume-failed-pool-reconciliation-qzjgqc`)

Replacement for the terminal A4 task `01M1X7ZB3XMVY1C037FGH1FJZ9` (Codex
`usageLimitExceeded`). Its final unpublished delta was never committed anywhere — the last
remote head was `4a21532a5` and the workspace belongs to another host — so the
role-materialization/coupling work was re-implemented from the two coordination messages
rather than recovered. Root `eb89a8370` is merged into this branch (`18054bfc3`).

### Disposition of the six independent findings against `4a21532a5`

| #   | Finding                                          | Disposition | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Discriminating proof                                                                                                                                                                                                               |
| --- | ------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P1 non-atomic membership/policy/revision edit    | Fixed       | `default-capacity-pool-updates.ts` `publishPoolEditAtomically`: one D1 batch, every statement fenced on the same pre-read `revision`, grouped by target status and chunked under the bind ceiling; read-back on `(revision, updatedAt)` closes the ABA window; losing editors return `conflict` → HTTP 409                                                                                                                                                                                       | Mid-batch failure rolls back; stale concurrent edit cannot overwrite the winner; both proven red when the fence or the batch is removed                                                                                            |
| 2   | P2 empty successful API catalog misclassified    | Fixed       | `Provider.instanceOfferingApiBacked` (Hetzner declares it); `refreshStatusForOfferings` carries transport provenance instead of inferring from members. Empty static lists stay incomplete (fail-safe)                                                                                                                                                                                                                                                                                           | Real `HetznerProvider` + mocked `/server_types` returning `[]`; plus a full credential-backed reconciliation proving prior offerings become `last-known-unavailable` while membership survives                                     |
| 3   | P2 price-only ranking change kept plan authority | Fixed       | Price currency/monthly/hourly added to `capacityCandidateAuthorityGeneration` (`:v2`); new `capacity_pools.selection_digest` (migration **0153**, additive) drives a revision bump from `reconcileDefaultPoolStatus` only when selection-affecting state changed                                                                                                                                                                                                                                 | Identical refresh keeps the revision stable; two comparable offerings swapping cheapest position bumps it                                                                                                                          |
| 4   | P2 refresh cleared persisted native config       | Fixed       | Effective boot disk/image/architecture read from the persisted row and re-published, plus `COALESCE(excluded.…, current)` in both upsert paths                                                                                                                                                                                                                                                                                                                                                   | Same-inventory refresh preserves all three fields AND the authority generation                                                                                                                                                     |
| 5   | No-credential-copy invariant                     | Fixed       | `materializeCapacitySourceCredential` removed. The source binds by exact reference (`credential_source` + `cc_credentials:<id>` + `cc_attachments:<id>` + version). A **secret-free** anchor row remains only because migration 0125's shipped `capacity_sources` CHECK requires a non-null `credential_id` and the table is an FK CASCADE parent (rule 31 forbids the rebuild). `scrubCapacitySourceCredentialSecrets` erases previously copied ciphertext and prunes only unreferenced anchors | Canary ciphertext never reaches `credentials`; upgraded copies are scrubbed; the referenced anchor is never deleted and no capacity source is cascaded away                                                                        |
| 6   | Bounded/resumable catalog publication            | Fixed       | Durable per-(pool, source) publication cursor in `platform_settings`, keyed by a digest of the ordered candidate set; missing-offering cleanup requires BOTH a complete catalog and a complete publication. Per-isolate credential-scoped catalog cache (`CAPACITY_POOL_CATALOG_CACHE_TTL_MS`), successful+complete refreshes only                                                                                                                                                               | Multi-pass publication with a NEW db handle per pass proves durable resumption; partial passes never mark missing; a failed refresh never marks missing; one provider request per credential per TTL, with a cleared-cache control |

### Deployment workload-role regression (message `01M1XA6V7V35Y51P6R8GJK71QX`)

Reconciliation materialized only `workload_role='workspace'`, so every deployment placement was
rejected. Reconciliation now materializes a coupled pair per offering: the editor-visible
`workspace` row keeps the unchanged candidate id (upgrade-safe) and a hidden
`…#role=deployment` mirror carries the same provider-native identity. Editor surfaces and all
user-visible counts stay per-offering; `readDefaultPoolSummary`/
`resolveEffectiveDefaultCapacityPoolSummary` accept `workloadRoles: 'all'` for placement.
Status edits propagate to the mirror **only** on exact provider-native identity; legacy rows
with a NULL `provider_instance_type` are addressable by exact id and never fuzzy-coupled.
`capacity-pool-workload-roles.ts` is the single shared contract C3a's final fence consumes.

### Known non-regressions inherited from the merge base

Three tests already fail at `18054bfc3` (verified by checking that commit out and re-running):
`capacity-pools.test.ts > maps nullable placement snapshots for legacy rows` and two
`placement-resolver.test.ts > capacity-aware reusable node resolution` cases, the latter from
`placement-resolver-capacity.ts:707 selectionCapacityAuthorityGeneration` dereferencing
`selection.selectionSettings` without a guard. Both files are outside A4's ownership; reported
to the coordinator rather than edited here.

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
   `getVcpuCount`, `canSatisfyVmSize`, `vmSizeFallbackChain`,
   `PROVIDER_VM_CAPACITY`, `PLATFORM_RESOURCE_DEFAULTS` or `VM_SIZE_ORDER`, and
   using a legacy size as a catalog lookup key or an eligibility/ranking
   comparison. Reported anywhere in `apps/api/src` and `packages/providers/src`.
2. **Legacy size reads inside canonical authority scope** — matched by canonical
   directory and by family token in the module name, so a newly created
   `services/placement-ranking.ts` is in scope on creation rather than needing a
   filename-list edit.
3. **Allocation writers** — every `INSERT` into `tasks` / `nodes` / `workspaces`
   / `compute_usage`, owned per enclosing function.
4. **Allocation and provisioning entrypoints** — `createNodeRecord`,
   `provisionNode`, `reserveWorkspacePlacement`, `createWorkspaceOnNode` and
   `startComputeTracking` call sites, each carrying an explicit scope, role and
   admission contract.

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

Checked allocation/provision entrypoint inventory (21 call sites). `status` is an
honest classification of what each call site does today, not an approval:

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

Historical remaining upgrade / capability test matrix (superseded by the current
12-case joined matrix above):

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

### Historical E1 gate state

The scanner counts below describe the E1 checkpoint only. The current-session
scanner invocation was killed and requires a new successful run; use the current
verification table rather than interpreting these historical counts as current.

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

## Historical final local repair checkpoint — 2026-09-07

PR #2030 remains OPEN against main; no merge, SAM dispatch, or staging deployment. All eight API shards completed and exposed 27 files requiring fixture/source-contract repairs. The combined repair run passed 790 cases, with two callback import timeouts. Moving the two callback-route imports into collection produced 10/10 passing callback tests (606 ms behavior, 14.72 seconds module imports). The five-second test deadline is unchanged. Four affected web unit suites passed 143/143; trigger/MCP 57/57; full MCP 241/241; affected Workers 28/28; deployment/resolver 120/120. The source scanner passed across 1,331 files.

The deployment-role test exposed a missing internal lookup option: editor summaries correctly hide deployment mirrors, but allocation needs both roles before exact-role filtering. `placement-resolver.ts` now requests all roles internally; public summaries and final SQL role/authority checks remain unchanged. The regression failed before and passed after the fix; independent allocation review passed.

The screenshot archive in `tasks/evidence/2026-09-07-node-pools` contains 44 reviewed mock images across 22 paired surfaces, with manifest hashes. The mobile composer gap is closed by a focused Chromium test asserting the exact 2.5 vCPU / 6 GB submit payload. Browser totals remain 104 native hardware + 4 Usage + 46 resource forms + 6 pool scopes + 14 creation + 2 wizard cases, with 40 intentional 320px stress skips. Focused reruns overlap and are not extra distinct cases.

Full lint passed all 13 tasks. Final typecheck and build are running. Both current-tree and PR-range secret scans pass; the final PR body passes the local preflight checker. Screenshot evidence is published at https://github.com/raphaeltm/simple-agent-manager/pull/2030#issuecomment-5572028105. Integration head `c745cab56` is pushed to the task output branch and the preserved PR head. Final CI and CodeRabbit remain required; the task stays active until their actual disposition is known.

## Bounded CI repair checkpoint — 2026-09-07

CI run 34132885635 at `40ee92602` completed with two failing jobs. Web passed all 3,730 tests; API passed 9,325 tests but had two shared-module mock collection errors and a full-repository scanner timeout under coverage. The two mocks now retain actual shared exports (59/59 focused tests pass). The repository audit invokes the same scanner in an isolated Node process, preserving full source discovery and assertions while avoiding V8 coverage overhead on TypeScript AST traversal; its 82-test suite passes with coverage enabled in 51 seconds, including a 35-second scan/test phase. Coverage percentage thresholds were disabled only for this focused single-file command; CI thresholds remain unchanged. Targeted formatting and lint are checked before commit.

The other failure was the devcontainer Docker Compose download checksum, before mount checks. The same job passed previously and the upstream checksum subsequently downloaded in valid format; the next CI run will retry it. Full lint, typecheck and build passed on the previous integrated head, as did Workers, Go, visual, security and quality CI jobs.

Raphaël explicitly confirmed CodeRabbit cannot run on this PR because of its 100-file limit. CodeRabbit is therefore a task-specific unavailable review, not a pending action or a claimed pass. He authorized only 20 more minutes, ending approximately 15:12 UTC; pause then if final CI is not green. The PR remains open, no merge is authorized, and live staging verification remains unperformed.

## September 8 staging corrections and release record

The first two staging deployments passed their deployment and smoke jobs. A real
native CX33 in fsn1 ran through an installation credential for a user with no
personal cloud credential. Its healthy VM agent reported four CPUs and actual
physical memory. Resource-default edits persisted through desktop/mobile UI
reloads. The workspace and VM were deleted through confirmed API cleanup, and
Cloudflare showed no remaining DNS records for either resource.

That iteration exposed release blockers: concurrent refresh could overwrite a
completed pool publication, the expanded workspace/node join exceeded D1's
result-column limit, and direct-workspace usage began too late in a long
background readiness wait. The corrections at `08fc90df2` fence publication and
readiness writes with their source generations, select only consumed joined
fields, and start native usage after successful attachment with guarded failure
cleanup. Independent reviews and red-before/green-after regressions pass. Full
CI at that head passed 9,436 API, 3,746 web and 936 Workers tests, plus Sonar.
The screenshot upload job passed on retry after a GitHub upload stalled.

The follow-up at `be8fa2f3d` removes an integer-only duplicate workspace resource
validator. A real route test now preserves fractional workload reservations
using the same canonical schema as other request writers; invalid co-tenant
counts fail before allocation. Its 20 focused route/schema/metering tests,
API typecheck, lint, current-tree and PR-range secret scans pass. Full CI and
Sonar subsequently passed on that code head, including the API test job,
3,746 web tests and 936 Workers tests. All executed GitHub checks were green.

The corrected candidate still requires the final live provisioning, reuse,
admission, empty-pool, sleep/recovery and cleanup pass. Shared staging is used
by other release tasks and must be handed off before deployment. This file
records the implementation and dated checkpoints; the final release results,
current checks, cleanup evidence and production deployment outcome are maintained
in [PR #2030](https://github.com/raphaeltm/simple-agent-manager/pull/2030).

## September 8 continued live verification — allocation lifetime finding

The current integrated code passed CI and Sonar after merging archive PR #2034.
Live verification then exposed two additional product gaps: the Nodes creator still
submitted only legacy sizes, and a successful D1 node DELETE returned 409 when
foreign-key SET NULL updates made `meta.changes` greater than one. Native selection
(including installation-funded users without personal credentials) and the exact
positive-change deletion check are being validated with actual-page request tests
and real Workers/D1 foreign keys respectively.

A slow direct CX23 creation exposed a separate allocation-lifetime gap. Node
`01M20KQDHX8M3YP89Q6QTQP6S1` claimed its provider credential at 13:36:11 UTC,
but the matching Hetzner server was created at 13:37:19. The VM booted and sent
heartbeats while D1 still lacked its provider ID and workspace attachment.
The authenticated heartbeat supplied IPv6, which could not satisfy the existing
IPv4 DNS write. An isolated read-only provider inventory verified the exact server,
staging installation/environment/node labels and public addresses; no absence was
inferred. Direct Nodes and workspace creation currently run provisioning under
request `waitUntil`, unlike the durable task runner. The clone/streaming-response
hypothesis was independently rejected by real workerd HTTP and DO probes.

- [x] Move direct allocation and its attachment/metering continuation to durable
      per-intent execution, retaining exact pool/credential/incarnation authority.
- [x] Correlate uncertain external creation with its persisted incarnation and
      reconcile an exact provider match before any subsequent paid side effect.
      Empty or ambiguous inventory must not imply absence or authorize duplicate creation.
- [x] Verify slow response, restart after provider acceptance, concurrent deletion,
      authority revocation and ambiguous inventory through joined DO/provider/D1 tests.
- [x] Repair only the exact live test runtime's missing metadata after reviewed
      provider evidence, then verify the original snapshot's restoration, terminal
      and pricing. The September 8 15:00 UTC checkpoint records this parent-session
      result; it is not a restoration on the final continuation build.
- [ ] Remove every owned runtime, artifact, DNS record and test project after
      the final candidate's supported lifecycle verification.

These are release gates. The task remains active; maintenance operations and earlier
passing checks do not constitute a successful final recovery or release.


### September 8 verification checkpoint at 15:00 UTC

The exact live CX23 metadata repair passed its identity-fenced preview and changed
one node record (workflow 34238659733); the normal heartbeat then repaired DNS.
The fresh recovery workspace retained its saved 1024 MB reservation after the
project default changed to 2048 MB. Snapshot restoration preserved the original
repository and home marker contents, and the resumed agent reported both through
the original conversation with `RESTORED-READ-OK-1788878933077`. Its native CX23
usage record retained the known hourly price of 8800 micros. Desktop and mobile
terminal commands returned their expected output through one connection with four
resize events and no errors or disconnects during the measured window.

The first recovery prompt also exposed a pre-send delivery preparation overrun:
target recovery could outlive the delivery lease and be treated as an uncertain
send while the runtime was still creating. Preparation now has its own deadline
and safe retry result, separate from prompt submission. Late preparation cannot
send a prompt. The existing uncertain-send and receipt safeguards remain intact;
52 focused tests passed, including delayed recovery and delayed capability checks.
The successful live file read used one fresh prompt after runtime readiness; the
new deadline fix still requires verification in the final deployed build.

Durable allocation review found and resolved interruption checkpoints around
post-provider authority, dispatch acknowledgement, metering idempotency and
terminal diagnostic publication. Normal providers with delayed IP assignment
retain their successful allocation checkpoint and wait for heartbeat. Four joined
Workers/D1 cases and 36 actual-route/SQL cases passed; counts overlap neighboring
coverage. Independent Cloudflare/security review passed. File-size and type-boundary
checks passed, and the current-tree secret scan found 52 reviewed findings and no
new findings. Final combined CI/Sonar, staging, cleanup and merge remain pending.

### September 8 continuation after parent runtime loss

The parent session `ee16af66-6c80-4a98-a119-f5d0b5a88912` timed out at
16:05 UTC. Its production workspace and node are deleted. The PR's pushed head
`200978160` passed all executed CI and Sonar checks, but the final host-startup,
durable prompt-preparation phase, and snapshot-restore retry corrections were
not pushed. The transcript records local commits `70103f417` (host setup barrier)
and `8893ab18a` (prompt preparation), followed by an uncommitted restore patch.
The continuation is reconstructing these changes from the persisted SAM tool
transcript and rerunning tests; it does not claim the missing workspace or its
unpublished screenshots were recovered.

At continuation baseline, staging has one owned running helper workspace
`01M20V4KH101DA7M6CE42DGG7H` on node `01M20SKTFTHPNBS5APTRVNF5RM`, under test
project `01M201HEKK895BY9Q7TYSJA4WY`. The installation pool is balanced/queue
with nine active offerings. The original test snapshot remains available for
session `ef07c74a-54c5-444a-a2ee-54d4ce21d939`. Pre-existing sleeping workspaces
`01M1N2MGWMA0BYCRB250FT1907` and `01M1N3BWQJH10DQW564SV7BB65` are excluded
from cleanup. The earlier combined deployment failed on a Cloudflare AI binding
internal validation error (10021); no final combined deployment success is claimed.

- [x] Reconstruct the three unpublished corrections and obtain independent review.
      Preserved in `c1ab101da` and `475bb732c`; independent adversarial review passed.
- [ ] Verify final candidate cold provisioning and a fresh capture/wake cycle.
      The original snapshot restored in the parent session, then became ineligible
      after successful restoration; it was removed through the supported API.
      Do not attribute a new final-build restore to that original artifact.
- [ ] Remove owned helper/test resources, preserve pre-existing sleeping sessions,
      and verify pool settings remain at the baseline.
- [ ] Update PR evidence, pass final CI/staging, merge, and verify production deployment.


### Historical continuation checkpoint: `99a620928`

Staging deployment `34255654245` and its smoke tests passed at this checkpoint.
All PR checks including SonarCloud passed at `49987bf97`; its only difference
from staged `99a620928` is import whitespace. The fresh VM reported that exact
staged binary. First-choice native allocation selected `cx23` at 8,800 hourly
micros; observed hardware is 2 vCPU / 4 GB / 40 GB, while the saved reservation
is 0.25 vCPU / 1 GB with profile provenance. Cold host setup and devcontainer
startup passed. Actual terminal WebSocket output `PR2030-PTY-RETURNED` passed.

Live verification exposed a false shortage banner caused solely by differing
legacy size aliases despite a first-choice native allocation. Removed that
obsolete inference; real provisioning errors and native hardware/placement
surfaces remain. 18 focused tests, ESLint, and reviewed desktop/mobile mock
screenshots passed. The first agent startup rejected the smoke user's inherited
Codex model `gpt-5.4-mini` before executing the marker prompt. Its workspace was
removed via the supported API; the bounded profile now selects the already
configured Claude agent without changing user defaults. Live lifecycle testing
continued on the same owned VM. This configuration failure is not a sleep/wake
pass, and no duplicate active test workspace is retained.


The fresh Claude conversation created and read both `PR2030-FINAL-1788889363195`
markers. UI sleep returned 200, snapshot `01M211XXWT1ME9VGR2YVN77XE6` became
available with no degradation and home/WIP hashes. The empty VM was deleted via
SAM, preserving the snapshot artifacts but, as the subsequent failed wake proved,
destroying required workspace context. The profile default was changed to 2 GB
for the wake test of the saved 1 GB reservation. All 13 owned session R2 prefixes
were checked: only this fresh snapshot had objects. The original snapshot prefix was
empty, and the unused primary-user test project was deleted via SAM.

### Superseded sleep-header experiment: `722997457`

A refreshed sleeping screen showed an old task's Runtime lost card despite its
canonical Sleeping state and zero recovery attempts. An experimental UI change
suppressed that historical runtime-loss error. Seven actual-header regressions
and reviewed desktop/mobile mock screenshots covered the proposed display rule,
but did not establish live recoverability. The change was subsequently reverted;
its captures are investigation evidence, not final UI acceptance. Latest main's
dependency updates and subsequent blog update were also merged.

### Node deletion correction: `c6d1a987f`

The wake attempt exposed the actual deletion defect: `removeManagedNodeRecords`
physically removed the sleeping workspace after preserving the snapshot, and D1
nulled `snapshot.workspace_id`. `loadRecoveryContext` requires that row, so the
snapshot was no longer recoverable. The UI-only suppression in `722997457` was
therefore reverted: Sleeping alone is not proof of recoverability. The fix in
`c6d1a987f` preserves same-owner snapshot-referenced workspace context when deleting
a node, including pending, failed and in-flight snapshots; retention does not
assert recovery eligibility. Explicit workspace deletion remains destructive.
A new supported capture/delete/wake cycle is required; the orphaned test snapshot is not repaired
by manually recreating metadata and does not count as a successful recovery.


The node cleanup fix now retains same-owner snapshot-referenced workspaces
atomically in both managed and BYO deletion paths. It does not weaken runtime
termination or incarnation proof. Ten real Workers/D1 tests passed, including
available/degraded snapshots, pending capture, waking at the attempt limit,
cleared chat pointer during recovery handoff, BYO, and explicit workspace
snapshot/R2 deletion. The original failure was reproduced before the fix;
independent review, API typecheck and scoped ESLint passed.
