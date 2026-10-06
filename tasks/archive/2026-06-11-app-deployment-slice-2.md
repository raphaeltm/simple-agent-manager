# App Deployment Slice 2: D1 Schema, API Routes, and Manifest Rendering

## Problem Statement

The normalized deployment manifest schema v1 (Zod, strict, digest-pinned) was merged in PR #1281 to `packages/shared/src/deployment-manifest/`. The `node_role` groundwork shipped in PR #1282 (migration 0066). Nothing consumes the manifest yet — this slice creates the D1 storage, API routes, and server-side Compose rendering that make it a real contract.

## Research Findings

### Existing Code
- **Manifest schema**: `packages/shared/src/deployment-manifest/schema.ts` — Zod `.strict()`, `DeploymentManifestSchema`, types exported via `packages/shared/src/index.ts`
- **Manifest validator**: `packages/shared/src/deployment-manifest/validate.ts` — `validateManifest()` with 3-phase validation (dangerous fields, Zod, cross-references)
- **DB schema**: `apps/api/src/db/schema.ts` — Drizzle ORM, text timestamps with `DEFAULT CURRENT_TIMESTAMP`, `ulid()` for IDs
- **Latest migration**: `0066_node_role.sql`
- **Route patterns**: Hono, per-route auth middleware (`requireAuth()`, `requireApproved()`), `requireOwnedProject()`, `errors.*` for error responses, `getUserId(c)` for user ID
- **Validation**: `jsonValidator()` uses Valibot. Manifest uses Zod. Will validate manifest body manually via `validateManifest()` from shared package.
- **YAML library**: `yaml` 2.9.0 available in `packages/cloud-init/`. Need to add to `apps/api/` for Compose rendering.

### Design Decisions (from doc 06)
- Manifest is the canonical stored contract
- Server-side Compose rendering via YAML library (never string templates — rule 02)
- Render-time injections: volume bindings, private network, restart policy, default memory limits, container labels
- Secrets by reference only — for this slice, scope to literal values only (reject secret references since secret store doesn't exist yet)
- Constrained to single service; multi-service rejected with clear error

### Tables Needed
- `deployment_environments`: belongs to a project, references a node (nullable for now), has name/status
- `deployment_releases`: immutable accepted manifest, references environment, stores validated manifest JSON, version, status

## Implementation Checklist

### 1. D1 Migration (0067)
- [ ] Create `apps/api/src/db/migrations/0067_deployment_environments.sql`
- [ ] `deployment_environments` table: id, project_id (FK cascade), name, status, created_at, updated_at
- [ ] `deployment_releases` table: id, environment_id (FK cascade), manifest (JSON text), version (integer), status, created_by, created_at
- [ ] Add indexes on project_id, environment_id

### 2. Drizzle Schema
- [ ] Add `deploymentEnvironments` table definition to `apps/api/src/db/schema.ts`
- [ ] Add `deploymentReleases` table definition to `apps/api/src/db/schema.ts`
- [ ] Follow existing patterns: text IDs, text timestamps, proper FK references

### 3. API Routes
- [ ] Create `apps/api/src/routes/deployment-environments.ts` with routes:
  - `POST /:projectId/environments` — create environment (name required, unique per project)
  - `GET /:projectId/environments` — list environments for project
  - `GET /:projectId/environments/:envId` — get single environment
- [ ] Create `apps/api/src/routes/deployment-releases.ts` with routes:
  - `POST /:projectId/environments/:envId/releases` — submit manifest to create release (validate via `validateManifest`, enforce single-service constraint, store)
  - `GET /:projectId/environments/:envId/releases` — list releases for environment
  - `GET /:projectId/environments/:envId/releases/:releaseId` — get single release
  - `GET /:projectId/environments/:envId/releases/:releaseId/compose` — render and return Compose YAML
- [ ] Register routes in `apps/api/src/index.ts`
- [ ] Auth: requireAuth + requireApproved per-route, requireOwnedProject

### 4. Compose Rendering Module
- [ ] Add `yaml` dependency to `apps/api/package.json`
- [ ] Create `apps/api/src/services/compose-renderer.ts`
- [ ] Implement `renderCompose(manifest, context)` — deterministic manifest→Compose-file rendering
- [ ] Render-time injections per doc 06:
  - Volume bindings under data-volume root (`/mnt/data/volumes/<name>`)
  - Environment-private network (`sam-internal`)
  - Restart policy (`unless-stopped`)
  - Default memory limit when omitted (256MB default, configurable)
  - Container labels: `sam.environmentId`, `sam.releaseId`, `sam.service`
- [ ] Resolve secret refs: for this slice, reject manifests with secret references (document this choice)
- [ ] Build YAML document via `yaml` library, never string templates

### 5. Tests
- [ ] Unit tests for `compose-renderer.ts` — YAML round-trip with realistic multi-line data
- [ ] Unit tests for single-service constraint enforcement
- [ ] Miniflare integration tests for all routes (create env, create release, list, get, render)
- [ ] Vertical-slice test: create environment → submit manifest → fetch rendered compose → parse YAML → verify structure

### 6. Shared Package Update
- [ ] Verify deployment-manifest types are already exported (they are via index.ts)

## Acceptance Criteria
- [ ] Migration 0067 adds deployment_environments and deployment_releases tables
- [ ] API routes create/list/get environments scoped to authenticated project owner
- [ ] API routes create/list/get releases with manifest validation
- [ ] Multi-service manifests are rejected with a clear error message
- [ ] Secret references in manifests are rejected with a clear error (secret store deferred)
- [ ] GET .../releases/:id/compose returns valid Compose YAML rendered from the stored manifest
- [ ] Rendered Compose includes all doc-06 injections (labels, network, restart, volumes)
- [ ] YAML round-trip tests parse output and verify content integrity
- [ ] All tests pass locally

## References
- Library doc 06: Compose Safety Boundary and the Normalized Manifest
- Library doc 02: Phased Delivery Plan (slice 2)
- `packages/shared/src/deployment-manifest/` — schema + validator
- `.claude/rules/31-migration-safety.md` — no DROP TABLE
- `.claude/rules/02-quality-gates.md` — template output verification
- `.claude/rules/35-vertical-slice-testing.md` — cross-boundary tests
