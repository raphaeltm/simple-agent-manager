# Deployment Agent Core: Restart-Safe Apply Engine + Pull-Based Release Channel

**Created**: 2026-06-11
**SAM Task ID**: 01KTWCZ1JB1H5VXW1VX96PKXH5
**Branch**: sam/implement-deployment-agent-core-01ktwc

## Problem Statement

SAM is building an app-deployment feature where agents deploy containerized apps to dedicated single-node environments. The vm-agent needs a `deployment` role that:

1. Skips workspace/PTY/ACP endpoints (only health, heartbeat, deploy engine)
2. Manages desired state on disk for restart-safety
3. Pulls releases via heartbeat-signaled command channel
4. Verifies signed apply payloads (Ed25519, dedicated deploy-signing key)
5. Applies Docker Compose changes idempotently with rollback on failure
6. Reports observed state back to control plane via heartbeat

Already merged: manifest schema (#1281), node_role column + reaper exemptions (#1282), D1 tables + CRUD routes + Compose renderer (#1290).

## Research Findings

### Go vm-agent Architecture
- `main.go`: lifecycle is config.Load() -> server.New() -> provision.Run() -> bootstrap.Run(). Deployment mode needs alternate path skipping provision/bootstrap.
- `config/config.go`: ~237 fields, no `Role` field yet. Needs `Role`, `EnvironmentID`, `DeployBaseDir`, `DeploySigningPubKey`.
- `server/server.go`: `setupRoutes()` registers workspace/terminal/git/file routes. `New()` creates JWT validator, session manager, PTY manager. Deployment mode should skip most of this.
- `server/health.go`: `sendNodeHeartbeat()` POSTs to `/api/nodes/{nodeID}/heartbeat` with callback JWT. Response has `Status`, `LastHeartbeatAt`, `HealthStatus`, `RefreshedToken`. Must extend for deployment state.

### API Architecture
- `node-lifecycle.ts`: heartbeat endpoint at `/:id/heartbeat` uses `verifyNodeCallbackAuth()` + `extractBearerToken()`. Schema: `NodeHeartbeatSchema` (activeWorkspaces, nodeId, metrics).
- Callback JWT auth pattern (rule 34): own route file, `extractBearerToken()` + `verifyCallbackToken()`, mounted before `projectsRoutes` in index.ts.
- Route mounting order in `index.ts`: callback JWT routes at lines 563-566, then `projectsRoutes` at 567.
- `deployment-releases.ts`: CRUD routes with session auth, has `renderCompose()`, validates manifest, assigns monotonic `version`.
- `compose-renderer.ts`: already sets `restart: 'unless-stopped'`, adds sam-internal network, resource limits.

### Heartbeat Extension Strategy
- Current `NodeHeartbeatSchema` is `v.object({activeWorkspaces, nodeId, metrics})` — all optional.
- Extend with optional `deployment` field for deployment nodes.
- Heartbeat response needs `pendingReleaseSeq` field for pull signal.
- The node-lifecycle heartbeat handler needs to check if node is deployment role and include pending release info in response.

### Signing Strategy
- Dedicated Ed25519 key pair (NOT the callback-JWT key).
- Public key: delivered at provision time via cloud-init env var AND refreshable via heartbeat response.
- Payload signs: environmentID + nodeID + releaseSeq + expiry + composeTarGz.
- Node rejects: wrong env, wrong node, seq <= last applied, expired.

## Implementation Checklist

### Phase A: Go Config & Role Switching (packages/vm-agent)

- [ ] A1. Add `Role` field to Config (env: `NODE_ROLE`, values: "workspace"|"deployment", default: "workspace")
- [ ] A2. Add deployment config fields: `EnvironmentID`, `DeployBaseDir` (default: `/var/lib/sam-deploy`), `DeploySigningPubKey`
- [ ] A3. Update `Validate()` in helpers.go: if Role=deployment, require EnvironmentID; skip workspace-specific validations
- [ ] A4. Update `main.go`: when Role=deployment, skip provision/bootstrap, call new `deploy.Run()` loop instead
- [ ] A5. Update `server.New()`: when Role=deployment, skip PTY/ACP/workspace subsystems, only register health + deploy endpoints

### Phase B: Deploy Engine Core (packages/vm-agent/internal/deploy)

- [ ] B1. Create `internal/deploy/` package with types: `ReleaseState`, `ApplyStatus` (applied|applying|failed|reverted|failed-initial), `ObservedState`
- [ ] B2. Implement disk state manager: `desired/` directory layout, `current` symlink, release directories with metadata.json + compose files
- [ ] B3. Implement `reconcileOnStart()`: read disk state, verify running containers match, report observed state — never recreate if containers are healthy
- [ ] B4. Implement apply engine: atomic write to disk -> docker compose pull -> docker compose up -d -> health check -> update `current` pointer
- [ ] B5. Implement revert logic: on apply failure, restore previous `current` pointer, docker compose up -d with old config, mark release `failed`
- [ ] B6. Implement apply mutex: one apply at a time, reject concurrent requests with "apply in progress"
- [ ] B7. Handle first-release failure: no previous release to revert to = `failed-initial`, containers stopped

### Phase C: Signature Verification (packages/vm-agent/internal/deploy)

- [ ] C1. Implement Ed25519 signature verification: parse public key, verify payload signature
- [ ] C2. Implement payload validation: check environmentID matches, nodeID matches, seq > last applied, not expired
- [ ] C3. Support dual-key rotation window: accept signature from either current or previous public key
- [ ] C4. Implement public key refresh from heartbeat response

### Phase D: Pull-Based Command Channel (vm-agent + API)

- [ ] D1. Extend heartbeat payload with deployment observed state: applied release seq, status, per-service container state
- [ ] D2. Extend heartbeat response parsing: extract `pendingReleaseSeq` field
- [ ] D3. Implement pull trigger: when node's applied seq < pending, fetch full apply payload from control plane
- [ ] D4. Create API endpoint: `GET /api/nodes/:id/deploy-release` — callback JWT auth, returns signed apply payload
- [ ] D5. API endpoint: own route file per rule 34, mounted before projectsRoutes, callback JWT auth
- [ ] D6. API endpoint: look up deployment environment for node, find release with matching seq, return signed payload
- [ ] D7. Extend `NodeHeartbeatSchema` with optional deployment fields
- [ ] D8. Extend heartbeat handler to include `pendingReleaseSeq` in response when node is deployment role

### Phase E: Deploy Signing Service (apps/api)

- [ ] E1. Add `DEPLOY_SIGNING_KEY` Worker secret (Ed25519 private key, base64-encoded)
- [ ] E2. Implement signing service: sign apply payloads with deploy key, include env+node+seq+expiry binding
- [ ] E3. Add `Env` type binding for `DEPLOY_SIGNING_KEY`
- [ ] E4. Wire signing into the deploy-release endpoint

### Phase F: Testing

- [ ] F1. Go unit tests: Ed25519 signature verification (valid, wrong key, wrong env, wrong node, seq replay, expired)
- [ ] F2. Go unit tests: reconcileOnStart with various disk states (no state, valid state, stale state)
- [ ] F3. Go unit tests: apply engine (success path, failure + revert, failure + no-revert/failed-initial)
- [ ] F4. Go unit tests: apply mutex (concurrent apply rejection)
- [ ] F5. Go unit tests: heartbeat deployment state serialization
- [ ] F6. API integration tests: deploy-release endpoint (auth, payload shape, seq validation)
- [ ] F7. API integration tests: heartbeat extension with deployment fields
- [ ] F8. Vertical-slice test: heartbeat signals pending -> node pulls -> apply payload verified -> compose rendered on disk

### Phase G: Documentation & Wiring

- [ ] G1. Add TODO stubs for registry credential consumption (parallel work)
- [ ] G2. Update deployment-releases route to sign payloads when creating releases
- [ ] G3. Wire heartbeat handler to check deployment_releases table for pending releases
- [ ] G4. Ensure compose renderer output uses `unless-stopped` restart policy (already done in compose-renderer.ts)

## Acceptance Criteria

1. vm-agent with `--role=deployment` starts without registering workspace/PTY/ACP endpoints
2. Desired state persisted to `/var/lib/sam-deploy/desired/` survives agent restart
3. Agent restart reconciles from disk without recreating healthy containers
4. Heartbeat response carries `pendingReleaseSeq`; agent pulls and applies when seq > current
5. Apply payload signature verified with dedicated deploy key (not callback JWT key)
6. Wrong env, wrong node, seq replay, and expired payloads rejected
7. One apply at a time — concurrent apply rejected
8. Failed apply reverts to last successful release (or `failed-initial` for first release)
9. Heartbeat reports: applied release seq, status, per-service container state
10. Containers use `unless-stopped` restart policy and survive agent restart

## Out of Scope

- Registry credential minting (in-flight on another branch) — add TODO stubs
- Provider volumes (parallel task)
- Routing/Caddy (parallel task)
- Secrets management (parallel task)
- Pre-flight hooks (slice 3)

## References

- Design docs: app-deployment/03-node-lifecycle-and-os-updates.md, 10-release-apply-semantics.md
- Rule 34: vm-agent callback auth pattern
- Rule 35: vertical-slice testing
- Rule 27: staging — delete existing nodes before testing vm-agent changes
- Merged PRs: #1281 (manifest schema), #1282 (node_role), #1290 (D1 + CRUD + Compose renderer)
