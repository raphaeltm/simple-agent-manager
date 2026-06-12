# Deployment Node Provisioning + End-to-End Release Apply

**Created:** 2026-06-13
**Status:** Backlog

## Problem Statement

All app-deployment building blocks are merged (registry credentials, compose-subset parser, provider volume ops, environment secrets, deployment agent core with `--role=deployment` + signed pull-based release channel). The API has deployment-environments, deployment-releases, deployment-secrets routes, deploy-signing service, and MCP tools. The heartbeat already returns `pendingReleaseSeq` + `deployPubKey` for deployment nodes.

**But nothing ever creates a deployment node.** There is no provisioning path, no environment-to-node placement link, and `packages/cloud-init/` has no deployment-role support. No part of the flow has been exercised end-to-end.

## Research Findings

### Schema State
- `nodes` table has `nodeRole` column (`text('node_role').notNull().default('workspace')`) — migration 0066
- `deploymentEnvironments` table exists (migration 0067) with id, projectId, name, status, timestamps, secretsUpdatedAt
- `deploymentEnvironments` is **missing** nodeId, provider, and location columns — must be added via migration 0069
- `deploymentReleases` table exists (migration 0068) with manifest, version, status

### Cloud-Init State
- `packages/cloud-init/src/generate.ts` — `CloudInitVariables` interface lacks `role` and `environmentId` fields
- `packages/cloud-init/src/template.ts` — VM agent systemd unit lacks `ROLE` and `ENVIRONMENT_ID` env vars
- Template is ultra-minimal: downloads binary from R2 and starts vm-agent via systemd

### Node Provisioning State
- `apps/api/src/services/nodes.ts` — `provisionNode()` handles workspace provisioning (creates provider, generates cloud-init, calls provider.createVM(), sets DNS)
- `ProvisionTaskContext` is workspace-specific (projectId, chatSessionId, taskId, taskMode)
- Need to add deployment-specific context and modify provisionNode() to handle deployment nodes

### Heartbeat/Release Channel State
- `apps/api/src/routes/node-lifecycle.ts:259-290` — heartbeat already handles deployment nodes (checks `nodeRole === 'deployment'`, returns `pendingReleaseSeq` + `deployPubKey`)
- `apps/api/src/routes/deploy-release-callback.ts` — GET endpoint for signed release payload already exists

### Cleanup Exemption State
- `apps/api/src/scheduled/node-cleanup.ts` — All 4 cleanup sweep queries already filter `AND n.node_role = 'workspace'` (lines 157, 240, 295, 430)
- Deployment nodes are already excluded from cleanup sweeps in code
- **No tests** prove these exemptions — tests must be added

### Provider Interface
- All infra operations must go through `packages/providers/` Provider interface — no provider-specific branches in `apps/api`
- PR #1295 (provider volume ops) established the pattern

### Design Decisions (from research docs)
- **Doc 03**: Same binary with `--role=deployment` flag (not separate binary). Deployment agent must be restart-safe. `live-restore: true` in Docker daemon.
- **Doc 04**: Environment placement must record provider + location. One environment per node for MVP.

## Implementation Checklist

### 1. Additive D1 Migration (0069)
- [ ] Create `0069_deployment_environment_placement.sql`
  - Add `node_id TEXT REFERENCES nodes(id)` to `deployment_environments`
  - Add `provider TEXT` to `deployment_environments` (placement constraint)
  - Add `location TEXT` to `deployment_environments` (placement constraint)
- [ ] Update Drizzle schema (`apps/api/src/db/schema.ts`) — add nodeId, provider, location columns to deploymentEnvironments

### 2. Cloud-Init Deployment Role Support
- [ ] Add `role` and `environmentId` to `CloudInitVariables` interface in `packages/cloud-init/src/generate.ts`
- [ ] Add `ROLE` and `ENVIRONMENT_ID` environment variables to vm-agent systemd unit in `packages/cloud-init/src/template.ts`
- [ ] Update `validateCloudInitVariables()` to handle new optional fields
- [ ] Update `generateCloudInit()` to substitute new variables (conditional — only present for deployment role)
- [ ] Add/update cloud-init tests for deployment role template generation
- [ ] Verify generated YAML parses correctly with realistic data (rule: template output verification)

### 3. Provisioning Trigger
- [ ] Add deployment provisioning context type alongside `ProvisionTaskContext` in `apps/api/src/services/nodes.ts`
- [ ] Modify `createNodeRecord()` to accept `nodeRole` parameter
- [ ] Modify `provisionNode()` to pass role and environmentId to cloud-init generation
- [ ] Add `provisionDeploymentNode()` function or extend existing flow to handle deployment nodes (no DNS record needed for deployment nodes — they use pull-based channel)
- [ ] In `apps/api/src/routes/deployment-releases.ts` POST handler: when creating first release for an environment without a placed node, trigger provisioning
- [ ] Update environment record with nodeId, provider, location after provisioning
- [ ] Add tests for provisioning trigger logic

### 4. Lifecycle Exemption Tests
- [ ] Add test: deployment nodes excluded from idle-timeout sweep
- [ ] Add test: deployment nodes excluded from warm-pool transition
- [ ] Add test: deployment nodes excluded from max-lifetime reaper
- [ ] Add test: deployment nodes excluded from stale-node cleanup
- [ ] Verify NodeLifecycle DO doesn't arm alarms for deployment nodes (or verify deployment nodes don't use NodeLifecycle DO)

### 5. Integration Tests
- [ ] Test: creating a release for an env without a node triggers provisioning
- [ ] Test: provisioned deployment node gets correct cloud-init (role=deployment, environmentId set)
- [ ] Test: heartbeat for deployment node returns pending release info
- [ ] Test: deploy-release-callback returns signed payload for deployment node

### 6. End-to-End Staging Verification (Infrastructure Change)
- [ ] Deploy branch to staging
- [ ] Create a deployment environment via API
- [ ] Submit a release to trigger node provisioning
- [ ] Verify VM boots with --role=deployment
- [ ] Verify heartbeat arrives at control plane
- [ ] Verify pendingReleaseSeq returned in heartbeat response
- [ ] Verify deployment agent fetches and applies signed release
- [ ] Clean up test environment and node
- [ ] Record evidence of verification

## Acceptance Criteria

1. A deployment environment can have a node placed on it (migration + schema)
2. Cloud-init generates correct template for deployment role (role + environmentId in vm-agent env)
3. First release submission to an unplaced environment triggers node provisioning
4. Deployment nodes are provably exempt from all workspace cleanup sweeps (tests)
5. The full release apply flow works end-to-end on staging (real VM, real heartbeat, real signed payload)
6. All infra operations use the Provider interface (no provider-specific branches in apps/api)

## References

- Library docs: 03-node-lifecycle-and-os-updates.md, 04-data-volumes-and-resiliency.md
- PR #1297: deployment agent core (--role=deployment + signed pull-based release channel)
- apps/api/src/routes/node-lifecycle.ts:259-290 (heartbeat release channel)
- apps/api/src/routes/deploy-release-callback.ts (signed release payload)
- apps/api/src/scheduled/node-cleanup.ts (cleanup exemptions)
- packages/cloud-init/src/template.ts (cloud-init template)
- Parallel task: environment volumes (won't touch placement schema)
