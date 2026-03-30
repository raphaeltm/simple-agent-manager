# Per-Project Scaling Parameters + Provider-Aware Location Model

## Problem Statement

Two related issues:

1. **Broken location/provider coupling**: Locations are free-form strings decoupled from providers. Submitting `provider: 'gcp', location: 'nbg1'` (a Hetzner location) silently fails at VM creation time. No validation exists between provider and location at any layer.

2. **No per-project scaling config**: All scaling parameters (task timeout, concurrent tasks, warm node timeout, CPU/memory thresholds, etc.) are global platform env vars. Multi-tenant projects cannot customize these values.

## Research Findings

### Key Files
- `packages/shared/src/constants.ts` — `VM_LOCATIONS` maps location IDs to display names/countries but has NO provider grouping. `PROVIDER_LABELS` lists providers.
- `apps/api/src/db/schema.ts` — projects table has `defaultProvider`, `nodeIdleTimeoutMs` (dead column), `workspaceIdleTimeoutMs`
- `packages/shared/src/types.ts` — `Project` interface, `CredentialProvider` type, `VMLocation` type
- `apps/api/src/durable-objects/task-runner.ts` — reads config via `parseEnvInt()`, `findNodeWithCapacity()` uses CPU/memory/workspace thresholds
- `apps/api/src/durable-objects/node-lifecycle.ts` — `getWarmTimeoutMs()` reads `NODE_WARM_TIMEOUT_MS` globally
- `apps/api/src/routes/mcp/_helpers.ts` — `getMcpLimits()` reads dispatch limits from env
- `apps/api/src/routes/projects/crud.ts` — PATCH handler validates fields individually
- `apps/api/src/routes/tasks/run.ts` and `submit.ts` — vmLocation passed through without provider validation
- `apps/web/src/pages/ProjectSettings.tsx` — button groups, range sliders, toggle patterns
- `apps/web/src/pages/Nodes.tsx` — provider→location dropdown pattern to reuse

### Patterns
- Config reading: `parseEnvInt(env.VAR_NAME, DEFAULT_VALUE)` or `parsePositiveInt()`
- Validation: check `!== undefined && !== null` before numeric bounds check
- DB update: `undefined ? existing : (value ?? null)` pattern for optional clearing
- UI: button groups for enums, range sliders for timeouts, select dropdowns for provider/location

## Implementation Checklist

### Phase 1: Provider-Location Validation (Foundation)

- [ ] 1.1 Add provider-location registry to `packages/shared/src/constants.ts`:
  - `PROVIDER_LOCATIONS` map keyed by provider, containing arrays of `LocationMeta`
  - Refactor `VM_LOCATIONS` to be derived from `PROVIDER_LOCATIONS`
- [ ] 1.2 Add validation functions to `packages/shared`:
  - `isValidLocationForProvider(provider, location): boolean`
  - `getLocationsForProvider(provider): LocationMeta[]`
  - `getDefaultLocationForProvider(provider): string`
- [ ] 1.3 Add `defaultLocation` TEXT column (nullable) to projects table schema
- [ ] 1.4 Add `defaultLocation` to `Project` interface in shared types
- [ ] 1.5 API validation — PATCH `/api/projects/:id`:
  - If `defaultLocation` is set, validate against selected provider's location list
  - If `defaultProvider` changes, clear or re-validate `defaultLocation`
- [ ] 1.6 API validation — POST `/api/nodes`:
  - Validate `vmLocation` against provider before calling `createVM()`
  - Return 422 with valid locations listed on mismatch
- [ ] 1.7 API validation — POST `/api/projects/:id/tasks` (submit.ts and run.ts):
  - If `vmLocation` override provided, validate against the effective provider
- [ ] 1.8 Task runner provisioning validation:
  - Validate location before creating a node, fail the task with clear error
- [ ] 1.9 Location resolution: explicit override → project `defaultLocation` → provider's default location
- [ ] 1.10 Write tests for provider-location validation functions

### Phase 2: Per-Project Scaling Parameters

- [ ] 2.1 Add 8 nullable INTEGER columns to projects table:
  - `taskExecutionTimeoutMs`, `maxConcurrentTasks`, `maxDispatchDepth`, `maxSubTasksPerTask`
  - `warmNodeTimeoutMs`, `maxWorkspacesPerNode`, `nodeCpuThresholdPercent`, `nodeMemoryThresholdPercent`
- [ ] 2.2 Add new columns to `Project` interface in shared types
- [ ] 2.3 Add min/max/default constants to `packages/shared/src/constants.ts`
- [ ] 2.4 Create `resolveProjectConfig(project, env, key)` helper in shared package
- [ ] 2.5 Update `PATCH /api/projects/:id` to accept and validate all 8 new fields
- [ ] 2.6 Update TaskRunner DO — use project config for:
  - Task execution timeout (max execution alarm)
  - Node CPU/memory thresholds in `findNodeWithCapacity()`
  - Max workspaces per node in `findNodeWithCapacity()` and `tryClaimWarmNode()`
- [ ] 2.7 Update MCP dispatch tools — use project config for:
  - Max concurrent tasks (`getMcpLimits()` → project override)
  - Dispatch depth
  - Sub-tasks per task
- [ ] 2.8 Update NodeLifecycle DO — use project config for warm node timeout
- [ ] 2.9 Wire up existing dead `nodeIdleTimeoutMs` column — make it actually consumed
- [ ] 2.10 Write tests for `resolveProjectConfig` and consumer updates

### Phase 3: Settings UI

- [ ] 3.1 Add "Scaling & Scheduling" section to ProjectSettings.tsx:
  - Provider & Location dropdowns (reuse Nodes.tsx pattern)
  - Task Limits: execution timeout, max concurrent, max depth, max sub-tasks
  - Node Scheduling: warm timeout, max workspaces/node, CPU/memory thresholds
  - Expose `nodeIdleTimeoutMs` alongside existing `workspaceIdleTimeoutMs`
- [ ] 3.2 Each field shows platform default as placeholder text
- [ ] 3.3 Include "Reset to default" action per field (set to null)
- [ ] 3.4 Wire up API calls to save/load all new fields
- [ ] 3.5 Write tests for settings UI components

### Cross-Cutting

- [ ] 4.1 Update CLAUDE.md recent changes section
- [ ] 4.2 Lint, typecheck, test pass

## Acceptance Criteria

- [ ] Submitting a Hetzner location for a GCP provider returns a 422 error with valid locations
- [ ] Project settings page shows provider-filtered location dropdown
- [ ] Per-project scaling parameters override platform defaults when set
- [ ] Clearing a per-project parameter (null) falls back to platform default
- [ ] Task runner uses project-specific timeouts and thresholds
- [ ] MCP dispatch respects per-project limits
- [ ] NodeLifecycle DO uses project-specific warm timeout
- [ ] nodeIdleTimeoutMs is consumed by the system (not dead)
- [ ] All new columns have validation with min/max bounds
- [ ] Settings UI shows platform defaults as placeholders
- [ ] "Reset to default" clears per-project overrides
