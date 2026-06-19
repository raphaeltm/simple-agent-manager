# Multi-environment Deployment Node Bin-packing

## Problem

Deployment environments currently behave as if each environment owns a dedicated deployment node. First release provisioning always creates a new node, heartbeat reporting is scalar per node, and environment destroy always tears down the node. This makes small app deployments wasteful and makes environment destroy too destructive when multiple environments should be able to share one VM.

## Constraints

- Work only on `app-deployment-phase-d-control-surface` and update draft PR #1356.
- Do not create a new PR, do not merge to `main`, and do not trigger production deploy.
- Preserve callback auth IDOR protections: node heartbeat may use body-supplied environment IDs only as watermarks after independently resolving placements by `nodeId`.
- Follow Constitution Principle XI for configurable limits.

## Research Findings

- `apps/api/src/services/deployment-provisioning.ts` always calls `createNodeRecord()` and then conditionally links `deployment_environments.node_id`; this is the placement seam for pack-or-provision behavior.
- `apps/api/src/durable-objects/task-runner/node-steps.ts` has the workspace selector pattern to mirror: batch counts, hard count ceiling, CPU/memory thresholds, and location/size/load sorting.
- `apps/api/src/routes/deployment-environments.ts` currently deletes node resources before deleting the environment, so shared-node teardown must delete the environment first, then conditionally deprovision only if no other environments remain.
- `apps/api/src/routes/node-lifecycle.ts` heartbeat currently resolves one environment with `LIMIT 1`, updates one observed state, and returns scalar `pendingReleaseSeq`.
- `apps/api/src/routes/deploy-release-callback.ts` already validates `environmentId` is placed on the authenticated `nodeId`; add coverage for two environments on one node getting distinct payloads.
- `apps/api/src/services/compose-renderer.ts` uses per-environment host port bands already, but the network name is still `sam-internal`.
- `packages/vm-agent/internal/server/health.go` has one `deployEngine`; multi-environment fan-out belongs here and in `main.go` bootstrap.
- `packages/vm-agent/internal/deploy/engine.go` overwrites the global Caddyfile and runs Compose without project names; both collide under co-tenancy.
- `packages/vm-agent/internal/deploy/diskstate.go` can be isolated by creating one `DiskState` rooted under `DEPLOY_BASE_DIR/{environmentId}` per engine.
- `apps/web/src/pages/ProjectDeployments.tsx`, `Node.tsx`, `Nodes.tsx`, and `NodeCard.tsx` need copy/count updates for shared deployment nodes.
- No DB migration is required: `deployment_environments.node_id` is already many-to-one and indexed.

## Implementation Checklist

- [x] Add configurable deployment-node environment ceiling with `DEFAULT_MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE` and env override.
- [x] Implement deployment-node placement selector that mirrors workspace bin-packing for healthy `nodeRole='deployment'` nodes owned by the user and compatible provider/location/size.
- [x] Update provisioning to try placement first, provision only on overflow, preserve optimistic `WHERE nodeId IS NULL`, and roll back only fresh-node placement failures.
- [x] Update environment destroy to remove the environment and its DNS/volumes while only deprovisioning the node when no remaining environments are attached.
- [x] Update heartbeat request/response protocol to per-environment observed state and pending releases with IDOR-safe placement resolution.
- [x] Add callback test coverage for two environments on one node receiving distinct compose/routes/signatures.
- [x] Namespace Compose networks per environment and verify port bands stay distinct.
- [x] Refactor vm-agent Caddy handling to root Caddyfile plus per-environment snippets.
- [x] Add Compose `--project-name sam-env-{environmentId}` isolation to all Compose commands.
- [x] Add per-environment deploy engine management in vm-agent server/runtime with one `Engine` and disk root per placed environment.
- [x] Update UI copy and node cards/detail warnings to show shared deployment node consequences and hosted environment counts/names.
- [x] Update schema comment for many-environment-to-one-node placement.
- [ ] Add automated API, contract, Go, and UI tests for placement, overflow, destroy, heartbeat IDOR, callback payloads, Caddy snippets, Compose project names, base dirs, and multi-engine fan-out.
- [ ] Run local quality gates and Playwright visual audit for changed UI surfaces.
- [ ] Run specialist review set and address CRITICAL/HIGH findings.
- [ ] Deploy to staging, delete existing staging deployment nodes first, provision two environments onto one node, verify both serve, destroy one and then the last.
- [ ] Push to `app-deployment-phase-d-control-surface` and report draft PR #1356 status without merging.

## Acceptance Criteria

- Two deployment environments for the same user/provider/location/size pack onto the same healthy deployment node until the configured ceiling is reached.
- A node at capacity causes a new deployment node to be provisioned.
- Destroying one of multiple co-tenant environments preserves the node and the other environment; destroying the last environment deprovisions the node.
- Heartbeat accepts/reports per-environment deployment state and cannot be tricked into reporting or receiving releases for environments not placed on the node.
- vm-agent can apply releases for multiple environments without Caddy, Compose project, network, or disk-state collisions.
- UI accurately communicates that deployment node deletion affects all hosted environments and that environment destroy only deletes the node for the last hosted environment.
- Draft PR #1356 is updated, remains draft, and is not merged.
