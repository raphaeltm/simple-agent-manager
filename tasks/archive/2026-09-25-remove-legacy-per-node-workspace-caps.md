# Remove legacy per-node workspace caps (maxCoTenants, maxWorkspacesPerNode)

**Created**: 2026-09-25
**Priority**: High
**Type**: Scheduler cleanup / dead-concept removal
**SAM task**: 01M3CJ3JYD4ECSH74B1F5J34WF (branch `sam/confused-why-were-scheduling-5j34wf`)

## Problem

The chat session hardware panel prints "up to 2 workspaces per node" next to the requested
resources. Raphaël read that as the scheduler still capping density by count and asked for the
legacy count-based knobs to be removed from the product entirely: placement must depend only on
explicit CPU/memory/disk reservations and `exclusiveNode`.

The scheduler already stopped using the caps as placement gates in PR #2108 (deployed
2026-09-20 ~06:20Z). Evidence from production D1 (read-only, 2026-09-25):

- `workspaces.placement_explanation_json` host refusals with "co-tenant cap reached" wording end at
  2026-09-20T06Z; none since. The strings no longer exist in `apps/api`.
- Node `01M3CHSC2H355J5V6PNGWK3MJK` (cx33) holds 3 running workspaces whose stored reservations say
  `maxCoTenants: 2` / `3`.
- Production has 0 rows across `agent_profiles`, `triggers`, `skills`, `projects`, `tasks` whose
  `resource_requirements_json` contains `maxCoTenants`; 6 projects have `max_workspaces_per_node`
  set, and nothing reads it.

But the concept still lives everywhere else, which is what produced the confusing panel text:

- `resolveResourceReservation` still resolves `maxCoTenants` from `PLATFORM_RESOURCE_DEFAULTS` (4)
  and the legacy small/medium/large mapping (3/2/2) and stamps it into every persisted
  `resolved_reservation_json`.
- `HardwareDetails.tsx` `requestedResources()` renders it as "up to N workspaces per node".
- `WorkspaceAdmissionPolicy.maxWorkspaces` is still resolved from project scaling /
  `MAX_WORKSPACES_PER_NODE` / `DEFAULT_MAX_WORKSPACES_PER_NODE` (only ever logged).
- `ActiveWorkspaceReservationUsage.minMaxCoTenants` is computed and never read.
- SQL validity predicates in `workspace-placement.ts` and `deployment-node-admission.ts` still
  validate the field per reservation version.
- MCP tool schemas, the OpenAPI contract, the CLI `--max-co-tenants` flag, the project update
  route, the marketing placement explorer (`MAX_CO_TENANTS`, `MAX_WORKSPACES_PER_NODE` refusals)
  and public docs all still carry it.

Real underpacking causes recorded since 09-20 (same diagnostics column), for the record:
46 "Host agent version is incompatible", 11 "Host is outside the current pool allocation
authority", 9 "CPU saturation ceiling reached", 6 disk, 5 busy build queue, 4 memory, 4 CPU share.
Pack chooses cx53 first and Hetzner refused 5 cx53 provisions today with
"403 shared core limit exceeded". Those are separate follow-ups, not this task.

## Research findings

| Finding | Action |
| --- | --- |
| `packages/shared/src/resource-requirements.ts` `RESOURCE_REQUIREMENT_FIELDS` includes `maxCoTenants`; `normalizeResourceRequirements` ignores unknown keys, so stored JSON with the field parses fine once removed | Checklist: shared removal |
| `resource-defaults.ts` resolver output comment says "Placement intentionally ignores it" yet still emits it | Checklist: shared removal |
| `RESOURCE_RESERVATION_VERSION = 3` already means "maxCoTenants optional"; no version bump needed. v1/v2 rows keep it and stay valid | Checklist: SQL/TS validity ignore the key |
| `isResolvedResourceReservation` and both SQL `validReservationJsonSql` predicates branch on version to require/allow the field | Checklist: drop the branch; keep every other fail-closed check |
| `resolveWorkspaceAdmissionPolicy.maxWorkspaces` consumers: `workspace-steps.ts` log line, `legacyWorkspaceAdmissionPolicy(number)` overload used only by tests (92 test call sites, 3 production callers pass a policy object) | Checklist: remove field, remove numeric overload, migrate tests to the policy object |
| `projectScaling.maxWorkspacesPerNode` is threaded through 12 files (`task-runner/types.ts`, `task-runner-do.ts`, reserved-submission contracts/intent, tasks submit/run, MCP dispatch/orchestration, sam-session dispatch/retry, orchestrator scheduling, session-recovery) | Checklist: remove from every payload |
| `projects.max_workspaces_per_node` D1 column, `UpdateProjectSchema`, `project-update.ts`, `mappers.ts`, shared `Project`/`UpdateProjectRequest` | Checklist: drop from API/types; keep the physical column (rule 31, policy 95c3329a: "DB fields may remain for migration/audit") with a schema comment |
| `MAX_WORKSPACES_PER_NODE` in `wrangler.toml`, `.env.example`, `env.ts`, configuration docs; not pinned in the production or staging GitHub Environment (verified via `gh api .../environments/*/variables`) | Checklist: remove everywhere |
| `apps/web` `ScalingSettings.tsx` filters SCALING_PARAMS for `maxWorkspacesPerNode`, which is not in the registry (already invisible) | Checklist: remove the dead key |
| `apps/web` `resource-requirements-utils.ts` preserves unknown fields as `_opaqueFields` and re-serializes them; a stored `maxCoTenants` would be written back forever | Checklist: discard the retired key on deserialize |
| CLI: `--max-co-tenants` flag, `ResourceRequirements.MaxCoTenants`, "max co-tenants" output, help text, `run_test.go` cases | Checklist: CLI removal (rule 36 quality bar) |
| `apps/www` placement explorer models both caps as real refusals; `placement-catalog.test.ts` pins them to the upstream constants | Checklist: remove both caps from the model, prose in `choosing-a-placement-strategy.md`, and tests |
| `apps/www` scheduler explorer (`scheduler/model.ts`, `how-sam-scheduler-works.md`) teaches an illustrative 2-slot model; already tracked | Deferred to `tasks/backlog/2026-09-09-scheduler-explorer-slot-count-model.md` (updated so it no longer recommends showing a co-tenant cap) |
| `MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE` in `deployment-node-admission.ts` is a deployment-node count cap for shared deployment nodes | Out of scope; flagged in the PR/summary for a product decision |

## Implementation checklist

### Shared package
- [x] Remove `maxCoTenants` from `ResourceRequirements`, `ResolvedResourceReservation`, `CreateWorkspaceRequest.resourceRequirements`
- [x] Remove `maxCoTenants` from `RESOURCE_REQUIREMENT_FIELDS`, validators, defaults, legacy size mapping, resolver output
- [x] Remove `maxWorkspacesPerNode` from `Project` / `UpdateProjectRequest`
- [x] Remove `DEFAULT_MAX_WORKSPACES_PER_NODE`, `MIN_/MAX_MAX_WORKSPACES_PER_NODE` and their exports
- [x] Update shared tests

### API
- [x] `env.ts`: drop `MAX_WORKSPACES_PER_NODE`; `wrangler.toml` + `.env.example`: drop the var
- [x] `workspace-resource-capacity.ts`: drop `maxWorkspaces`, `minMaxCoTenants`, the maxCoTenants validity branch, and the `maxWorkspacesPerNode` scaling input
- [x] `workspace-placement.ts`: drop the maxCoTenants SQL branch and the numeric `reserveWorkspacePlacement` overload
- [x] `deployment-node-admission.ts`: drop the maxCoTenants SQL branch
- [x] `resource-requirements-input.ts`, `schemas/resource-requirements.ts`: drop parsing/provenance of the field
- [x] MCP tool definitions + sam-session dispatch schema: drop the property and the "deprecated compatibility metadata" wording
- [x] `openapi/sam-cli.ts`: drop the property; regenerate `openapi/sam-cli.openapi.json`
- [x] Remove `projectScaling.maxWorkspacesPerNode` from every payload/contract and the `workspace-steps.ts` log
- [x] `schemas/projects.ts`, `project-update.ts`, `mappers.ts`: drop the field; annotate the retained D1 column in `db/schema.ts`
- [x] Update API tests (unit, workers, simulation) so no test hand-feeds or asserts on the removed fields; keep a discriminating test that a reservation without `maxCoTenants` and a legacy v1/v2 row with it are both admitted purely on resources

### Web
- [x] `HardwareDetails.tsx`: remove the "up to N workspaces per node" segment
- [x] `resource-requirements-utils.ts`: remove the field from state, validation and serialization; discard a stored `maxCoTenants` instead of round-tripping it
- [x] `ScalingSettings.tsx`: remove the dead `maxWorkspacesPerNode` key
- [x] Update web unit tests and Playwright fixtures; run the Playwright visual audit for the changed panel (mobile + desktop)

### CLI
- [x] Remove `--max-co-tenants`, `MaxCoTenants`, output segment, help text; update `run_test.go`; `go test -race` + `go vet`

### Marketing site and docs
- [x] Placement explorer: remove `MAX_CO_TENANTS` / `MAX_WORKSPACES_PER_NODE` and their refusals; node meta shows the co-tenant count without a cap
- [x] Update `placement-catalog.test.ts`, `placement-model.test.ts`
- [x] Docs: `guides/compute-pools.md`, `reference/configuration.md`, `reference/api.md`; blog `choosing-a-placement-strategy.md` sentences that call the caps real
- [x] Update `tasks/backlog/2026-09-09-scheduler-explorer-slot-count-model.md` so it no longer proposes a co-tenant cap

### Validation
- [x] `pnpm typecheck && pnpm lint && pnpm test && pnpm build`, `openapi:check`, `quality:file-sizes` (unit suites green; worker files touched by this PR green on re-run, one known flaky dedup timing test passes alone; full worker suite is CI's gate)
- [ ] Specialist reviews, staging verification, PR, CodeRabbit gate, merge, production deploy monitoring

## Acceptance criteria

- [x] No source file outside `tasks/archive`, `specs/` and dated journal posts mentions `maxCoTenants`, `maxWorkspacesPerNode`, or `MAX_WORKSPACES_PER_NODE` except the retired-field guard, the annotated D1 column, and legacy-row test fixtures (repo grep, all file types)
- [x] A freshly resolved reservation has no `maxCoTenants` key; legacy v1/v2 reservation rows that carry it are still admitted on resources alone (unit + real-SQL tests)
- [x] The chat session hardware panel shows requested resources and exclusivity only (unit test + screenshots)
- [x] `PATCH /projects/:id` no longer accepts or returns `maxWorkspacesPerNode` (schema/route/mapper; live check on staging)
- [x] CLI `run --help` no longer lists `--max-co-tenants`; passing it fails with a clear `--max-co-tenants was removed` error (table-tested, with and without a value)
- [x] Marketing explorer refuses hosts only on resources/exclusivity; its tests no longer read a cap constant from the API source

## References

- Policy 95c3329a "Migrate legacy scheduler knobs to explicit resource allocation"
- `tasks/archive/2026-09-20-resource-based-scheduler-packing.md` (PR #2108)
- `.claude/rules/74-proxy-signals-must-match-the-condition.md`, `apps/api/.claude/rules/69-aggregate-capacity-at-final-reservation.md`
