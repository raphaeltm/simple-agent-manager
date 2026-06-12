# Wire Environment Volumes: Provider Volume Ops → Deployment Environments + Compose Renderer

## Problem Statement

PR #1295 added provider-agnostic block-storage volume operations (create/attach/detach/resize) to `packages/providers` for Hetzner and Scaleway. PR #1296 added environment-scoped secrets with render-time injection in `compose-renderer.ts`. Deployment environments exist as D1 rows. Nothing currently connects the volume ops to environments or to rendered compose output.

The resiliency model (research doc 04): "node is rebuildable, data is detachable" — app data lives on attached provider volumes so it survives both redeploy and node replacement.

## Research Findings

### Existing Provider Volume Interface
- `packages/providers/src/types.ts` exports `VolumeConfig`, `VolumeInstance`, `VolumeAttachmentConfig`, `VolumeDetachConfig`, etc.
- Provider interface has: `createVolume`, `attachVolume`, `detachVolume`, `resizeVolume`, `deleteVolume`, `getVolume`, `listVolumes`
- Constants: `SAM_VOLUME_MOUNT_PATH_TEMPLATE = '/mnt/sam-env-{environmentId}/'`, `SAM_VOLUME_FILESYSTEM_FORMAT = 'ext4'`, `SAM_VOLUME_FSTAB_OPTIONS = ['nofail']`
- Both Hetzner and Scaleway implementations exist
- `volumeCapabilities.requiresSameLocation = true` — co-location constraint

### Existing Schema Pattern
- `deployment_environments` table: `id, projectId, name, status, createdAt, updatedAt, secretsUpdatedAt`
- `deployment_secrets` table: cascades on environment delete, scoped by `environmentId`
- Latest migration: `0068_deployment_secrets.sql`

### Compose Renderer
- `apps/api/src/services/compose-renderer.ts` renders `DeploymentManifest` → Compose YAML
- Current volume rendering: `service.volumes = svc.volumes.map(v => \`${volumeRoot}/${v.name}:${v.mountPath}\`)`
- `DEFAULT_VOLUME_ROOT = '/mnt/data/volumes'` — needs to change to use env-specific mount path from provider conventions
- Context takes `volumeRoot?: string` — can be set per-render

### Route Pattern
- `deployment-environments.ts`, `deployment-secrets.ts` use `requireAuth() + requireApproved() + requireOwnedProject()`
- Routes scoped under `/api/projects/:projectId/environments/...`
- `requireOwnedEnvironment()` helper in secrets validates env belongs to project

### Credential Resolution
- `createProviderForUser()` in `services/provider-credentials.ts` resolves user → platform credential fallback
- `getCredentialEncryptionKey(env)` from `lib/secrets`
- Provider supports Hetzner, Scaleway, GCP

### Volume Mount Path Convention (from research doc 04)
```
/mnt/sam-env-{environmentId}/
  volumes/{volumeName}/   <- Docker named volumes bound here
```

## Implementation Checklist

### Phase 1: D1 Migration
- [ ] Create `0069_deployment_volumes.sql` — additive migration with `deployment_volumes` table
  - Columns: `id, environment_id (FK cascade), name, provider_volume_id, size_gb, location, status, provider_name, attached_server_id, linux_device, created_at, updated_at`
  - Unique index on `(environment_id, name)`
  - Index on `environment_id`
- [ ] Add `deploymentVolumes` Drizzle schema in `schema.ts`
- [ ] Export types `DeploymentVolumeRow`, `NewDeploymentVolumeRow`

### Phase 2: Volume Lifecycle Service
- [ ] Create `apps/api/src/services/deployment-volumes.ts`
  - `createEnvironmentVolume(db, env, userId, environmentId, opts)` — creates provider volume via Provider interface, inserts D1 row
  - `deleteEnvironmentVolume(db, env, userId, volumeId)` — deletes provider volume, removes D1 row
  - `listEnvironmentVolumes(db, environmentId)` — reads D1 rows
  - `attachEnvironmentVolumes(db, env, userId, environmentId, serverId, location)` — attaches all env volumes to a server
  - `detachEnvironmentVolumes(db, env, userId, environmentId, serverId)` — detaches all env volumes from a server
- [ ] Co-location validation: record location on volume row, validate server location matches

### Phase 3: API Routes
- [ ] Create `apps/api/src/routes/deployment-volumes.ts`
  - `POST /:projectId/environments/:envId/volumes` — create volume
  - `GET /:projectId/environments/:envId/volumes` — list volumes
  - `DELETE /:projectId/environments/:envId/volumes/:volumeId` — delete volume
  - `POST /:projectId/environments/:envId/volumes/attach` — attach all env volumes to a server (takes `serverId` + `location`)
  - `POST /:projectId/environments/:envId/volumes/detach` — detach all env volumes from a server (takes `serverId`)
- [ ] Register routes in `apps/api/src/index.ts`

### Phase 4: Compose Renderer Integration
- [ ] Update `ComposeRenderContext` to accept `environmentId` for volume mount path resolution
- [ ] Change volume root derivation: use `SAM_VOLUME_MOUNT_PATH_TEMPLATE.replace('{environmentId}', ctx.environmentId) + 'volumes'` when volumes are attached
- [ ] The existing `volumeRoot` override remains for backward compat; environment-based path takes precedence when `environmentId` is present

### Phase 5: Tests
- [ ] Vertical-slice test: create volume → attach → render compose → verify mount paths use env-specific root
- [ ] API route integration tests with Miniflare (D1 mocked): create/list/delete volumes
- [ ] Compose renderer test: volumes render with correct env-scoped paths
- [ ] Service tests: attach/detach orchestration with realistic provider boundary mocks
- [ ] Co-location validation test: reject attach when location mismatch

### Phase 6: Shared Types
- [ ] Add volume status type and any needed shared types to `packages/shared`

## Acceptance Criteria
- [ ] Environment volumes table exists with proper FK cascade from deployment_environments
- [ ] Volume CRUD API endpoints work with session-cookie auth + project ownership
- [ ] Volume create goes through Provider interface (provider-agnostic)
- [ ] Location is recorded on volume and validated on attach
- [ ] Compose renderer uses environment-specific mount path `/mnt/sam-env-{envId}/volumes/{name}`
- [ ] Attach/detach service takes nodeId as parameter (no env→node link)
- [ ] Both Hetzner and Scaleway supported via shared Provider interface
- [ ] Vertical-slice tests with realistic provider mocks
- [ ] No hardcoded values (Constitution Principle XI)

## References
- Research doc: `.library/04-data-volumes-and-resiliency.md`
- Provider volume types: `packages/providers/src/types.ts`
- Compose renderer: `apps/api/src/services/compose-renderer.ts`
- Schema: `apps/api/src/db/schema.ts` (deployment_environments at line 1833)
- Route pattern: `apps/api/src/routes/deployment-secrets.ts`
- Credential resolution: `apps/api/src/services/provider-credentials.ts`
