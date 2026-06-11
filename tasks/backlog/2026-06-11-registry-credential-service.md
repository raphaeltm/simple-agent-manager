# Registry Credential Service (Pivot Option 1)

## Problem Statement

The app-deployment feature needs agents to push container images to `registry.cloudflare.com`. The in-path Workers registry proxy (PR #1280) hit CF's 100MB edge body limit — blocking docker push for any real image. Pivot option 2 (upload-session Location passthrough) also failed (CF registry returns relative Location paths). The decided path is **pivot option 1**: SAM control plane mints short-lived CF registry credentials server-side, agent uses `docker push` directly against `registry.cloudflare.com`.

## Research Findings

### Existing Code to Reuse
- **`apps/api/src/services/devcontainer-cache.ts`**: Contains `mintCloudflareRegistryCredentials()` — calls `POST /accounts/{accountId}/containers/registries/{host}/credentials` with `expiration_minutes` + `permissions: ['pull', 'push']`. Returns `{ registry, username, password }`. Uses `CacheConfig` with `accountId`, `apiToken`, `registryHost`, `expirationMinutes`, `timeoutMs`.
- **`getCacheConfig(env)`** resolves config from env vars: `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `DEVCONTAINER_CACHE_*` overrides.
- **MCP tool pattern**: Tool definitions in `tool-definitions-session-idea-tools.ts` or `tool-definitions-workspace-tools.ts`, handler in a separate file (e.g. `deployment-tools.ts`), dispatch in `mcp/index.ts`.
- **`McpTokenData`**: Provides `projectId`, `userId`, `taskId`, `workspaceId`.

### Namespace Convention
- Deployment manifest `ImageSchema` has `{ registry, repository, digest }`.
- Project namespace prefix: `sam-{projectId}` (sanitized). All images for a project must live under this prefix.
- CF credential API likely does NOT support per-path scoping (it's push/pull for the whole account registry). Enforce namespace at manifest-validation time instead.

### Key Constraints
- Minting must use platform `CF_API_TOKEN` (workspace tokens got 403).
- Never log/persist credential values — audit metadata only.
- Rate-limit the mint endpoint per `rules/28`.
- Configurable TTL via env var (default ≤60 min).

## Implementation Checklist

- [ ] 1. Extract a shared `mintRegistryCredentials()` from `devcontainer-cache.ts` that both devcontainer cache and the new endpoint can call
- [ ] 2. Add `REGISTRY_CREDENTIAL_EXPIRATION_MINUTES` env var to `env.ts` (default: 60)
- [ ] 3. Create `apps/api/src/services/registry-credentials.ts` — service function that mints credentials, builds project namespace prefix, returns `{ registry, username, password, namespace, expiresAt }` without logging sensitive values
- [ ] 4. Create MCP tool definition for `get_registry_credentials` with `environment` input param in tool-definitions file
- [ ] 5. Create `apps/api/src/routes/mcp/registry-credential-tools.ts` — handler that validates project ownership, checks environment exists and belongs to project (if param provided), mints credential via service, records audit metadata (userId, projectId, taskId, environment), returns credential info
- [ ] 6. Wire handler into `mcp/index.ts` dispatch
- [ ] 7. Add rate limiting for the mint endpoint (per-project, configurable via env var)
- [ ] 8. Write unit tests for the service (mint call, namespace building, error handling)
- [ ] 9. Write integration tests for the MCP tool (auth, rate limiting, audit metadata)
- [ ] 10. Update SAM library doc 12 with CI run results and pivot decision
- [ ] 11. Update docs if needed (env var reference, etc.)

## Acceptance Criteria

1. `get_registry_credentials` MCP tool returns `{ registry, username, password, namespace, expiresAt }` for a project
2. Credentials are minted via CF API using platform token, not workspace token
3. Credential values are never logged or persisted — only audit metadata (who, when, which project, which environment)
4. Project namespace prefix is enforced (consistent with deployment manifest image validation)
5. Rate limiting prevents credential mint abuse
6. TTL is configurable via env var with sensible default (60 min)
7. Existing devcontainer-cache credential minting still works (shared code path)
8. Library doc 12 updated with experiment results and decision

## References

- `apps/api/src/services/devcontainer-cache.ts` — existing mint code
- `apps/api/src/routes/mcp/deployment-tools.ts` — existing deployment credential handler pattern
- SAM library doc 12 — registry proxy staging findings
- SAM library doc 07 — security policy and secrets
- `.claude/rules/28-credential-resolution-fallback-tests.md` — test requirements
