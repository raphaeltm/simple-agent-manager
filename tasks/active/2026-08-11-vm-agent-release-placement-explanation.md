# Preserve VM-agent releases and explain reusable-node placement

## Problem Statement

Production deploy run `31492102025` set `VM_AGENT_REQUIRED_VERSION` to
`fc1e394217248c3bd004b2e6619cf2344eade7e3` even though `packages/vm-agent` had not
changed since the build reported by healthy node `01KZR2JAP92AK3SKW951E4H21M`
(`23e7adc23954d2b3a231b942edbb3195a6442301`). The exact compatibility gate correctly
rejected that node, so task `01KZRHQ4PVD1V55YP18H3BWKBF` provisioned another VM even
though the old medium/hel1 node had only 2/5 workspaces and low load. Both the task and
workspace had null `placement_explanation_json`, so the reason was not directly
observable.

The fix must separate a VM-agent release identity from an unrelated application deploy
identity without weakening exact compatibility, and it must make every reusable-node
decision durable and explainable.

## Hard-Gate Review

The plan from SAM Idea `01KZRMP0J6ZEXT5KEGCSKFSPMH` is technically sound and is approved
for implementation with these safety-preserving refinements:

1. A `skip_agent` request is allowed to carry a release only when the deterministic
   build fingerprint is unchanged. If inputs changed or no prior release is provable,
   the deploy fails closed instead of deploying controller changes against an
   unpublished agent.
2. The fingerprint is stored as deploy-owned Worker metadata next to the required
   release. Its first rollout attempts to recompute the prior fingerprint from the
   deployed commit SHA, treating the initial compatibility marker value as the legacy
   baseline; an ambiguous state publishes a fresh release.
3. Trials have no task row. To persist failed trial placement before workspace creation,
   `trials.placement_explanation_json` is required in addition to the existing task and
   workspace columns.
4. Placement evidence is built only from allowlisted identifiers, enums, booleans, and
   bounded numeric snapshots. Raw metrics JSON, agent versions, provider errors,
   prompts, repository data, environment values, and secrets are never copied.

The normal `/do` task-file push to `main` is intentionally not used: pushing `main` can
trigger a production deployment, while this task explicitly prohibits every deployment.
The task file and all implementation changes stay on the SAM-provided output branch and
will be reviewed in one draft PR.

## Research Findings

1. `.github/workflows/deploy-reusable.yml:Resolve and Verify Deployment SHA` assigns the
   deployment SHA to `agent_version` on every normal run and emits an empty value for
   `skip_agent`; build/upload conditions are based only on `skip_agent`. This directly
   causes unrelated release churn and can clear enforcement. Addressed by checklist A.
2. `scripts/deploy/sync-wrangler-config.ts:getApiWorkerVars` copies
   `VM_AGENT_REQUIRED_VERSION` only when non-empty. The deployment already has a
   fail-closed Cloudflare settings-read precedent in
   `scripts/deploy/durable-object-migrations.ts`; the release resolver must similarly
   avoid logging the settings payload because it contains plaintext bindings such as
   `SETUP_TOKEN`. Addressed by checklist A and security tests.
3. `packages/vm-agent/**` contains the Go module/toolchain declaration, dependency lock,
   source, and Makefile. Using `go-version-file: packages/vm-agent/go.mod` and hashing the
   tracked package tree plus an explicit compatibility marker creates a historical,
   deterministic input contract. Addressed by checklist A.
4. `isNodeAgentVersionCompatible` is the exact gate shared by preferred, warm,
   capacity, trial, manual, readiness, and cleanup paths. It intentionally permits an
   unset requirement for local/manual development. The implementation must keep this
   function's semantics unchanged and ensure official deployments never emit an empty
   requirement. Addressed by checklists A, B, and tests.
5. Reusable selection is duplicated between
   `apps/api/src/durable-objects/task-runner/node-selection.ts`,
   `apps/api/src/services/node-selector.ts`, the trial orchestrator, and manual workspace
   creation. Several SQL filters discard candidates before any typed rejection can be
   recorded, and TaskRunner verifies heartbeat only after choosing one candidate.
   Addressed by checklist B with a central typed evaluator/selector.
6. `PlacementExplanation` exists in `packages/shared/src/types/resource.ts`, and D1
   already has task/workspace JSON columns from migration 0056, but no production path
   writes them. Task responses expose only raw JSON and workspace responses omit it.
   Addressed by checklists B and C.
7. TaskRunner must persist a provisioning decision immediately after reusable selection,
   then append size-fallback/provider-attempt outcomes and copy the finalized explanation
   into the workspace row. `failTask` must preserve a placement failure only when the
   failure belongs to selection/provisioning/readiness, not overwrite a successful
   placement when a later agent step fails. Addressed by checklist B.
8. Trials explicitly have no task row, and manual workspace creation creates its
   conversation task only after selecting/creating the node. Trial persistence therefore
   needs a D1 column; manual persistence can write the same explanation into the new
   task/workspace rows. Addressed by checklist B and migration tests.
9. `get_workspace_info` currently proxies only VM-agent-local metadata. It can safely
   enrich that result from the project-scoped D1 workspace row, while REST mappers can
   expose safely parsed structured data. Addressed by checklist C.
10. `WorkspaceSidebar` is an existing compact workspace detail surface. A default-
    collapsed placement section satisfies the UI objective without a new top-level page,
    but requires unit/accessibility coverage and local Playwright audits at 375px and
    1280px. Addressed by checklists C and D.
11. Prior rollout incidents show that artifact publication must precede Worker
    enforcement and that busy incompatible VMs, active provisioning claims, and fresh
    unversioned nodes must remain protected. Existing cleanup/readiness behavior is not
    being redesigned. Addressed by checklist A and regression suite D.
12. Existing selection tests contain many source-string contracts alongside behavioral
    tests. Refactoring must replace brittle contracts that encode duplication with
    behavioral coverage of typed decisions and persisted vertical slices. Addressed by
    checklist D.

## Implementation Checklist

### A. Deterministic VM-agent release resolution

- [x] Add a versioned compatibility marker with a documented legacy baseline.
- [x] Add a tested release-resolution module that deterministically fingerprints the
      tracked VM-agent package inputs at a Git ref and emits `build_agent`,
      `required_version`, `fingerprint`, and a machine-readable reason.
- [x] Read only the allowlisted deployed Worker bindings needed for resolution; treat
      missing Worker state as first install and fail closed on unreadable/invalid state.
- [x] Infer an absent first-rollout fingerprint from the prior required Git SHA when
      possible; publish when equivalence cannot be proven.
- [x] Carry the prior required release and skip R2 build/upload when the fingerprint is
      unchanged.
- [x] Publish and advance to the target deployment SHA when inputs or the explicit marker
      changed.
- [x] Preserve the prior release for unchanged `skip_agent`; reject changed-input or
      first-deploy `skip_agent`.
- [x] Use the release outputs for every Wrangler sync invocation and ensure official
      deployed environments never receive an empty requirement.
- [x] Keep the separate Cloudflare Container image build/version boundary intact.

### B. Typed placement evaluation and persistence

- [ ] Evolve the shared placement model to a versioned v2 shape with outcome, selection
      path, request/limit snapshot, evaluated candidates, typed rejection reasons,
      provisioning attempts, timestamps, and concise summary.
- [ ] Add safe parsing for v2 and the legacy unversioned shape.
- [ ] Centralize reusable-node evaluation for preferred, warm, capacity, trial, manual,
      and compatibility-wrapper paths while retaining exact agent-version comparison.
- [ ] Record deterministic typed reasons including agent mismatch, unhealthy, stale
      heartbeat, wrong runtime, undersized VM, workspace limit, CPU/memory thresholds,
      and lost warm claim.
- [ ] Persist TaskRunner selection immediately, update provisioning/fallback attempts,
      preserve selection/provisioning failures, and copy/finalize the explanation on
      workspace creation.
- [ ] Add a safe migration and schema field for trial placement, and persist trial reuse,
      provisioning, and failure decisions.
- [ ] Persist manual selected-node and provision-new decisions on its conversation task
      and workspace.
- [ ] Emit structured placement log events with only the allowlisted explanation.

### C. API, MCP, and compact UI exposure

- [ ] Return parsed placement data from task and workspace mappers while retaining the
      legacy raw task JSON field for compatibility.
- [ ] Enrich `get_workspace_info` with a concise D1-backed placement summary/detail.
- [ ] Add a default-collapsed placement section to the existing workspace sidebar,
      including concise outcome text and typed rejection/attempt detail.
- [ ] Update public configuration/architecture documentation, env references, and
      `.claude/rules/54-vm-agent-rollout-compatibility.md` with release carry-forward
      semantics and explicit compatibility bump guidance.

### D. Verification

- [x] Add release-resolution tests for unchanged inputs, source/toolchain/build-script
      changes, compatibility-marker changes, first install, first-rollout inference,
      changed/unchanged `skip_agent`, invalid metadata, and no empty enforcement.
- [x] Update workflow/sync safety tests for release outputs, step ordering, and
      conditional R2 build/upload.
- [ ] Add behavioral selector tests covering reuse, exact incompatibility on every path,
      deterministic reasons/metrics, healthy-versus-better-incompatible ranking, and
      concurrent warm claim loss.
- [ ] Add TaskRunner/trial/manual vertical slices proving reused, provisioned, and failed
      decisions persist and copy to workspaces.
- [ ] Seed canary secrets in raw metrics, agent version/provider errors, and unrelated DB
      fields; prove stored, REST, log, and MCP placement payloads exclude them.
- [ ] Add mapper/MCP/UI tests and run local Playwright visual/accessibility audits with
      normal, long, empty/legacy, many-rejection, error, and special-character scenarios
      at mobile and desktop widths with no horizontal overflow.
- [ ] Run focused suites, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- [ ] Run required task-completion, Cloudflare, environment, security, UI/UX,
      documentation, constitution, and test-engineering specialist reviews; address all
      findings.
- [ ] Push the output branch, open a draft PR explicitly stating “not deployed to
      staging” and “do not merge”, wait for applicable CI, and leave it open/unmerged.

## Acceptance Criteria

- An unrelated deployment with unchanged build inputs carries forward the last actually
  published required version and does not build/upload reusable-VM binaries.
- Any tracked VM-agent input or compatibility-marker change publishes and advances the
  exact required version; `skip_agent` cannot bypass that transition.
- First-deploy or unreadable/invalid prior state never empties compatibility enforcement.
- The compatibility predicate remains exact when a deployed requirement exists; busy
  incompatible nodes retain work but receive no new work.
- A healthy matching medium/hel1 node with 2/5 workspaces and low load is selected, and
  both task/workspace placement records say it was reused.
- Every preferred, warm, capacity, trial, and manual reusable-node evaluation records
  typed rejection reasons and allowlisted limit/metric snapshots.
- Provisioning and failure paths retain a versioned explanation, including warm-claim
  loss and size-fallback attempts where applicable.
- REST task/workspace responses, `get_workspace_info`, and the compact workspace detail
  UI expose the placement explanation without credentials, env values, prompts,
  repositories, process data, raw provider errors, raw agent versions, or seeded canary
  secrets.
- Local quality gates, applicable specialist reviews, and CI complete without deploying
  to any environment. The final PR remains draft and unmerged for human review.

## References

- SAM Idea `01KZRMP0J6ZEXT5KEGCSKFSPMH`
- `.claude/rules/54-vm-agent-rollout-compatibility.md`
- `.claude/rules/07-env-and-urls.md`
- `.claude/rules/10-e2e-verification.md`
- `.claude/rules/17-ui-visual-testing.md`
- `tasks/archive/2026-08-06-fix-node-reaping-orphan-reconciliation.md`
- `tasks/archive/2026-08-07-fix-provisioning-node-cleanup-race.md`
- `.github/workflows/deploy-reusable.yml`
- `scripts/deploy/sync-wrangler-config.ts`
- `apps/api/src/durable-objects/task-runner/node-selection.ts`
- `apps/api/src/services/node-selector.ts`
- `packages/shared/src/types/resource.ts`

## Execution Constraints

- Do not deploy to staging or any other environment.
- Do not merge.
- Do not weaken or bypass exact VM-agent compatibility for unknown/genuinely
  incompatible agents.
- Validate locally, through static analysis, CI, and specialist reviews.
- Finish with the implementation branch pushed and a clearly marked draft PR open.
