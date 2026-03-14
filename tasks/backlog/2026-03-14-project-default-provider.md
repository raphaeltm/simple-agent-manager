# Project Default Provider Selection

**Created**: 2026-03-14
**Priority**: Medium
**Context**: User request — when multiple cloud providers are configured, there's no way to set a default provider per project. The task runner picks whichever credential it finds first.

## Problem

Users with multiple cloud provider credentials (e.g., Hetzner + Scaleway) have no control over which provider is used for auto-provisioned nodes. The current behavior is non-deterministic — it depends on database insertion order.

### Current Behavior (Research Findings)

#### 1. Manual Node Creation — Provider IS Selectable
- `CreateNodeRequest` has an optional `provider?: CredentialProvider` field (`packages/shared/src/types.ts:778`)
- The Nodes UI shows a provider dropdown when multiple catalogs exist (`apps/web/src/pages/Nodes.tsx:151-166`)
- The API stores `cloudProvider` on the node record (`apps/api/src/routes/nodes.ts:168`)

#### 2. Task Runner (Auto-Provision) — Provider NOT Considered
- `SubmitTaskRequest` has NO `provider` field (`packages/shared/src/types.ts:550-565`)
- Task runner's `createNodeRecord()` call does NOT pass `cloudProvider` (`apps/api/src/durable-objects/task-runner.ts:442-448`)
- At provisioning time, `getUserCloudProviderConfig(db, userId, key, undefined)` returns the FIRST credential found (`apps/api/src/services/provider-credentials.ts:62-92`) — non-deterministic

#### 3. Warm Node Pool — No Provider Filtering
- `tryClaimWarmNode()` queries by `vm_size` and `vm_location` only (`apps/api/src/durable-objects/task-runner.ts:1278-1325`)
- A warm Scaleway node could be claimed for a user who prefers Hetzner

#### 4. Project Defaults — No Provider Field
- Projects table has `defaultVmSize`, `defaultAgentType`, `defaultWorkspaceProfile` (`apps/api/src/db/schema.ts:190-192`)
- There is NO `defaultProvider` column

#### 5. Credential Lookup Fallback
- `getUserCloudProviderConfig()` with `targetProvider=undefined` returns `LIMIT 1` with no ORDER BY (`apps/api/src/services/provider-credentials.ts:76-80`)
- Result depends on D1 row ordering — effectively random for the user

## Proposed Solution

### Phase 1: Project Default Provider
1. Add `defaultProvider` column to `projects` table (nullable text, same as `defaultVmSize`)
2. Expose in project settings UI alongside existing VM size default
3. Task runner reads `project.defaultProvider` and passes it to `createNodeRecord()`
4. Warm node pool filters by `cloud_provider` when project has a default

### Phase 2: Smart Fallback (Cheapest Option)
When no project default is set and user has multiple credentials:
1. Query provider catalogs for the requested `vmSize`
2. Compare pricing across available providers
3. Select the cheapest option
4. Fall back to first available if catalog query fails

### Data Flow (Phase 1)
```
User submits task → task-runner reads project.defaultProvider
  → if set: createNodeRecord(cloudProvider=defaultProvider)
  → if null: current behavior (first available credential)

Warm node claim → WHERE cloud_provider = project.defaultProvider (if set)
  → if null: current behavior (any provider)
```

## Implementation Checklist

- [ ] Add D1 migration: `ALTER TABLE projects ADD COLUMN default_provider TEXT`
- [ ] Update Drizzle schema: add `defaultProvider` to `projects` table
- [ ] Update `packages/shared/src/types.ts`: add `defaultProvider` to project types
- [ ] Update project settings API (`PATCH /api/projects/:id`): accept and persist `defaultProvider`
- [ ] Update project settings UI: add provider dropdown (similar to VM size selector)
- [ ] Update task runner: read `project.defaultProvider` and pass to `createNodeRecord()`
- [ ] Update `tryClaimWarmNode()`: filter by `cloud_provider` when project has default
- [ ] Update `findNodeWithCapacity()`: prefer nodes matching project default provider
- [ ] Add `provider` field to `SubmitTaskRequest` for per-task override
- [ ] Add tests: task runner respects project default provider
- [ ] Add tests: warm node pool filters by provider
- [ ] Add tests: per-task provider override takes precedence over project default
- [ ] (Phase 2) Add cheapest-provider fallback logic
- [ ] (Phase 2) Add tests: cheapest provider selected when no default set

## Acceptance Criteria

- [ ] User can set a default provider in project settings
- [ ] Auto-provisioned nodes use the project's default provider
- [ ] Warm node reuse respects the project's default provider
- [ ] Per-task provider override is possible and takes precedence
- [ ] When no default is set, current behavior is preserved (first available)
- [ ] (Phase 2) When no default is set, cheapest provider is selected
