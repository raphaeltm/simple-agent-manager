# Reject Callback Tokens at Identity Token Endpoint

## Problem

The identity token endpoint (`GET /api/projects/:id/deployment-identity-token`) in `apps/api/src/routes/project-deployment.ts` accepts callback tokens as a fallback when MCP token validation fails (lines 294-318). This is a privilege escalation vulnerability:

- Callback tokens are operational credentials for node-to-API communication (heartbeats, message reporting, boot logs)
- They have a 24-hour TTL
- Accepting them at the identity token endpoint means a compromised callback token grants GCP deployment access to all projects on that node

The MCP `get_deployment_credentials` tool already uses the MCP token in the credential config (line 77 of `deployment-tools.ts`), so there is no legitimate path where a callback token would be used for identity tokens.

## Research Findings

### Key Files
- `apps/api/src/routes/project-deployment.ts` — identity token endpoint (line 272-361)
- `apps/api/src/services/jwt.ts` — token types: callback (workspace/node scoped, 24h TTL), identity tokens
- `apps/api/src/services/mcp-token.ts` — MCP token validation (task-scoped, KV-based)
- `apps/api/src/routes/mcp/deployment-tools.ts` — `get_deployment_credentials` MCP tool (uses MCP token in credential config)
- `apps/api/tests/unit/routes/project-deployment.test.ts` — existing tests including callback token fallback test

### Auth Flow
1. Agent calls `get_deployment_credentials` MCP tool → gets `external_account` credential config with MCP token in headers
2. GCP client libraries call identity token endpoint with that MCP token
3. Endpoint returns signed OIDC JWT → GCP STS exchanges it for temporary access token

### Vulnerability
The fallback path (lines 294-318) accepts ANY callback token, looks up the workspace, and issues an identity token. This should be removed — MCP tokens are the only legitimate auth for this endpoint.

### Existing Test Impact
- Test "falls back to callback token when MCP token is invalid" (line 237) currently asserts this behavior works — it must be changed to assert rejection instead

## Implementation Checklist

- [ ] Remove callback token fallback from identity token endpoint in `project-deployment.ts`
- [ ] Return 403 when a non-MCP token is presented (MCP validation returns null)
- [ ] Update existing test "falls back to callback token" to assert 403 rejection
- [ ] Add explicit test: callback token with workspace scope is rejected
- [ ] Add explicit test: callback token with node scope is rejected
- [ ] Verify MCP token path still works (existing test covers this)
- [ ] Run lint, typecheck, test

## Acceptance Criteria

- [ ] Callback tokens are rejected by the identity token endpoint with 403
- [ ] A properly scoped credential (MCP token) is required for deployment token requests
- [ ] Normal deployment flow still works (agent can still get GCP tokens through MCP token)
- [ ] Tests verify that callback tokens are rejected at the identity token endpoint
- [ ] Tests verify that the correct credential type (MCP token) is accepted
