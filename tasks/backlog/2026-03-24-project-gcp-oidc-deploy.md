# Project-Level GCP OIDC for Defang Deployments

## Problem Statement

SAM projects need the ability to deploy to GCP via Defang using OIDC — no stored GCP credentials. This is a **project-level** GCP connection (separate from user-level VM provisioning credentials), where agents request short-lived deployment credentials via an MCP tool.

The system returns a standard GCP `external_account` credential config file. GCP client libraries auto-handle token exchange via SAM's identity token endpoint, so SAM remains the gatekeeper for every token request.

## Research Findings

### Existing Infrastructure to Reuse
- **OAuth flow**: `apps/api/src/routes/google-auth.ts` — Google OAuth with opaque KV handles
- **GCP setup**: `apps/api/src/services/gcp-setup.ts` — WIF pool/provider/SA creation with `runGcpSetup()`
- **JWT signing**: `apps/api/src/services/jwt.ts` — `signIdentityToken()` for OIDC JWTs
- **STS exchange**: `apps/api/src/services/gcp-sts.ts` — token exchange pattern
- **DB schema**: `apps/api/src/db/schema.ts` — credentials table pattern
- **MCP tools**: `apps/api/src/routes/mcp/` — JSON-RPC tool registration
- **UI**: `apps/web/src/components/GcpCredentialForm.tsx` — GCP setup flow pattern

### Key Design Decisions
1. **Separate table** (`project_deployment_credentials`) — not in the user-level `credentials` table because this is project-scoped, not user-scoped
2. **Non-secret data only** — stores GCP project ID, project number, SA email, WIF pool/provider IDs. These are identifiers, not secrets.
3. **external_account config** — returns standard GCP credential config JSON, not raw tokens. GCP libraries auto-refresh via SAM's identity token endpoint.
4. **Identity token endpoint** — auth via workspace callback token (proves workspace identity)

### Migration
- Next migration number: `0031`
- Table: `project_deployment_credentials`

### Environment Variables (new)
- `GCP_DEPLOY_WIF_POOL_ID` (default: `sam-deploy-pool`)
- `GCP_DEPLOY_WIF_PROVIDER_ID` (default: `sam-oidc`)
- `GCP_DEPLOY_SERVICE_ACCOUNT_ID` (default: `sam-deployer`)
- `GCP_DEPLOY_IDENTITY_TOKEN_EXPIRY_SECONDS` (default: `600`)
- `GCP_DEPLOY_TOKEN_CACHE_TTL_SECONDS` (default: `3300`)

## Implementation Checklist

### 1. Database & Shared Types
- [ ] Add `project_deployment_credentials` table to `schema.ts`
- [ ] Create migration `0031_project_deployment_credentials.sql`
- [ ] Add shared types: `ProjectDeploymentCredential`, `ProjectDeploymentCredentialResponse`, `SetupProjectDeploymentRequest`
- [ ] Add new env vars to `Env` interface in `apps/api/src/index.ts`

### 2. GCP Deployment Setup Service
- [ ] Create `apps/api/src/services/gcp-deploy-setup.ts`
- [ ] Reuse helpers from `gcp-setup.ts` (createWifPool, createOidcProvider, etc.)
- [ ] Use deployment-specific params: pool=`sam-deploy-pool`, provider=`sam-oidc`, SA=`sam-deployer`
- [ ] Grant deployment roles: Cloud Run Admin, Storage Admin, Artifact Registry Admin, IAM SA User, Cloud Build Editor
- [ ] Return deployment credential metadata

### 3. API Routes
- [ ] Create `apps/api/src/routes/project-deployment.ts`
- [ ] `GET /api/projects/:id/deployment/gcp/authorize` — OAuth redirect (reuse google-auth pattern)
- [ ] `GET /api/projects/:id/deployment/gcp/callback` — OAuth callback, store handle
- [ ] `POST /api/projects/:id/deployment/gcp/setup` — Run WIF setup, store config
- [ ] `GET /api/projects/:id/deployment/gcp` — Get deployment config
- [ ] `DELETE /api/projects/:id/deployment/gcp` — Disconnect
- [ ] Register routes in `apps/api/src/index.ts`

### 4. Identity Token Endpoint
- [ ] `GET /api/projects/:id/deployment-identity-token` — Returns signed OIDC JWT
- [ ] Auth via workspace callback token (not user session)
- [ ] Validate workspace belongs to project
- [ ] Use `signIdentityToken()` with deployment-scoped claims
- [ ] Configurable expiry via `GCP_DEPLOY_IDENTITY_TOKEN_EXPIRY_SECONDS`

### 5. MCP Tool
- [ ] Add `get_deployment_credentials` tool definition to `tool-definitions.ts`
- [ ] Create handler in `apps/api/src/routes/mcp/deployment-tools.ts`
- [ ] Look up `project_deployment_credentials` for the project
- [ ] Construct `external_account` credential config JSON
- [ ] Point `token_url` to SAM's identity token endpoint
- [ ] Return config + usage instructions
- [ ] Register tool in MCP dispatcher

### 6. UI — Project Settings
- [ ] Add API client functions: `getProjectDeploymentGcp`, `deleteProjectDeploymentGcp`, `setupProjectDeploymentGcp`
- [ ] Create `DeploymentSettings` component in project settings
- [ ] Connected state: show GCP project ID, SA email, disconnect button
- [ ] Disconnected state: "Connect GCP" button → OAuth flow
- [ ] Setup flow: project selection → setup → done
- [ ] Add to ProjectSettings page

### 7. Tests
- [ ] Unit tests for `gcp-deploy-setup.ts` service
- [ ] Integration tests for API routes (setup, get, delete, identity-token)
- [ ] Unit tests for MCP tool handler
- [ ] Unit tests for UI component (render, interaction)

## Acceptance Criteria

- [ ] User can connect GCP to a project for deployments (separate from VM provisioning)
- [ ] WIF pool, OIDC provider, and service account are created with deployment-specific roles
- [ ] Deployment credential config is stored in `project_deployment_credentials` table
- [ ] MCP tool returns valid `external_account` credential config JSON
- [ ] Identity token endpoint returns signed OIDC JWT authenticated via callback token
- [ ] GCP client libraries can use the credential config to auto-exchange tokens
- [ ] UI shows connected/disconnected state in project settings
- [ ] User can disconnect GCP deployment credentials
- [ ] All env vars are configurable (no hardcoded values)
- [ ] Tests cover happy path for setup, get, delete, and token exchange

## References

- `apps/api/src/routes/google-auth.ts`
- `apps/api/src/services/gcp-setup.ts`
- `apps/api/src/services/gcp-sts.ts`
- `apps/api/src/services/jwt.ts`
- `apps/api/src/routes/mcp/`
- `apps/api/src/db/schema.ts`
- `apps/web/src/pages/ProjectSettings.tsx`
- `apps/web/src/components/GcpCredentialForm.tsx`
- `.specify/memory/constitution.md`
