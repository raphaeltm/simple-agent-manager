# Unify workspace-mcp into sam-mcp — Single MCP Server Architecture

## Problem Statement

SAM has two MCP servers: `sam-mcp` (HTTP, Cloudflare Worker) and `workspace-mcp` (stdio, Node.js in container). **workspace-mcp is not working in production** — the binary distribution pipeline was never built. The VM agent checks for the binary, doesn't find it, and silently skips. Additionally, workspace-mcp only works with Claude Code (stdio); Codex/Vibe connect via HTTP and would never get workspace tools.

**Solution:** Move all 15 workspace-mcp tools into sam-mcp. For tools needing local container access, sam-mcp proxies through the API Worker to the VM agent.

## Research Findings

### Existing MCP Architecture
- **38 tools** already in sam-mcp, defined in `apps/api/src/routes/mcp/tool-definitions.ts`
- JSON-RPC dispatch in `apps/api/src/routes/mcp/index.ts`
- MCP token context provides: `taskId`, `projectId`, `userId`, `workspaceId`
- Tool handlers split across 6 files: `task-tools.ts`, `dispatch-tool.ts`, `session-tools.ts`, `idea-tools.ts`, `instruction-tools.ts`, `deployment-tools.ts`

### Tool Classification (from workspace-mcp analysis)

**Category A — Handle directly in sam-mcp (no VM agent proxy):**
1. `list_project_agents` — queries D1 tasks table (already available)
2. `get_file_locks` — lists active tasks + branches (D1 query + local git via proxy)
3. `get_peer_agent_output` — equivalent to existing `get_task_details`
4. `get_task_dependencies` — D1 query on tasks parent relationships
5. `get_remaining_budget` — D1/KV query on project budget
6. `report_environment_issue` — write to observability D1
7. `get_ci_status` — GitHub API from Worker (needs user's GH token from encrypted creds)
8. `get_deployment_status` — GitHub API from Worker

**Category B — Proxy to VM agent (needs container access):**
9. `get_workspace_info` — needs `/proc/uptime`, git branch, container state
10. `get_credential_status` — needs env var checks inside container
11. `get_network_info` — needs port scanning from host
12. `expose_port` — needs port registration on host
13. `check_cost_estimate` — needs `/proc/uptime` for runtime calculation
14. `get_workspace_diff_summary` — needs git commands inside container

**Category C — Could go either way (doing from Worker):**
15. `check_dns_status` — DNS/TLS checks can be done from Worker side

### Existing Proxy Pattern
- `apps/api/src/routes/projects/files.ts` has `resolveSessionWorkspace()` and `proxyToVmAgent()`
- URL construction: `${protocol}://${nodeId}.vm.${BASE_DOMAIN}:${port}/workspaces/${workspaceId}/...`
- Auth: JWT token passed as `?token=` query param
- `signTerminalToken()` in `apps/api/src/services/jwt.ts` generates workspace-scoped JWT

### VM Agent Patterns
- Routes registered via `http.ServeMux` with `HandleFunc("METHOD /path/{param}", handler)`
- Auth: `requireWorkspaceRequestAuth()` checks header/cookie/bearer/query-token
- Docker exec: array-based args (safe, no shell interpolation) via `execInContainer()`
- Container resolution: `resolveContainerForWorkspace()` returns containerID, workDir, user

### Files to Remove
- `packages/workspace-mcp/` — entire package (~1,300 lines, 7 tool files)
- `packages/vm-agent/internal/acp/workspace_mcp.go` — injection logic (~157 lines)
- `packages/vm-agent/internal/acp/workspace_mcp_test.go` — tests
- References in `pnpm-workspace.yaml` (implicit via `packages/*` glob — no change needed)
- References in `CLAUDE.md`

### Call Site for Injection
- `packages/vm-agent/internal/acp/session_host.go:972` calls `injectWorkspaceMcpIfAvailable()`

## Implementation Checklist

### Phase 1: VM Agent Endpoints for Container-Local Operations
- [ ] Create `packages/vm-agent/internal/server/mcp_tools.go` with handler struct
- [ ] Implement `GET /workspaces/{id}/mcp/workspace-info` — reads `/proc/uptime`, git branch, workspace metadata
- [ ] Implement `GET /workspaces/{id}/mcp/credential-status` — checks env vars inside container via `docker exec printenv`
- [ ] Implement `GET /workspaces/{id}/mcp/network-info` — combines existing port scanner data with workspace URLs
- [ ] Implement `POST /workspaces/{id}/mcp/expose-port` — validates port listening, returns external URL
- [ ] Implement `GET /workspaces/{id}/mcp/cost-estimate` — reads `/proc/uptime`, applies VM pricing
- [ ] Implement `GET /workspaces/{id}/mcp/diff-summary` — runs git fetch/diff/stat inside container
- [ ] Register all new routes in `server.go:setupRoutes()`
- [ ] Add unit tests for each endpoint in `mcp_tools_test.go`

### Phase 2: sam-mcp Tool Definitions and Proxy Handlers
- [ ] Add 15 new tool definitions to `apps/api/src/routes/mcp/tool-definitions.ts`
- [ ] Create `apps/api/src/routes/mcp/workspace-tools.ts` with:
  - [ ] `proxyToVmAgent()` shared helper (workspace lookup, token gen, fetch, error handling)
  - [ ] Category A handlers: `list_project_agents`, `get_file_locks`, `get_peer_agent_output`, `get_task_dependencies`, `get_remaining_budget`, `report_environment_issue`, `get_ci_status`, `get_deployment_status`
  - [ ] Category B handlers: `get_workspace_info`, `get_credential_status`, `get_network_info`, `expose_port`, `check_cost_estimate`, `get_workspace_diff_summary`
  - [ ] Category C handler: `check_dns_status` (implement in Worker directly)
- [ ] Add configurable env vars to Env type: `WORKSPACE_TOOL_TIMEOUT_MS`, `WORKSPACE_TOOL_COST_PRICING_JSON`, `WORKSPACE_TOOL_CI_RUNS_LIMIT`, `WORKSPACE_TOOL_DEPLOY_RUNS_LIMIT`, `WORKSPACE_TOOL_PORT_CHECK_TIMEOUT_MS`
- [ ] Handle missing workspace gracefully (return informative error when `workspaceId` is null)

### Phase 3: Wire Tool Dispatch
- [ ] Add workspace tool dispatch cases in `apps/api/src/routes/mcp/index.ts`
- [ ] Ensure proper error handling for workspace-not-running cases
- [ ] Add unit tests for tool dispatch routing

### Phase 4: Remove workspace-mcp
- [ ] Remove `packages/workspace-mcp/` directory entirely
- [ ] Remove `injectWorkspaceMcpIfAvailable()` call from `session_host.go:972`
- [ ] Remove `packages/vm-agent/internal/acp/workspace_mcp.go` and its test file
- [ ] Clean up any remaining references in `pnpm-lock.yaml` (run `pnpm install`)
- [ ] Clean up references in `packages/vm-agent/internal/persistence/store.go` if any

### Phase 5: Documentation
- [ ] Update `CLAUDE.md` — remove workspace-mcp from repository structure, update MCP description
- [ ] Update any docs referencing two MCP servers

## Acceptance Criteria
- [ ] All 15 workspace tools are accessible via sam-mcp `tools/list` response
- [ ] Category B tools proxy correctly through VM agent and return valid data
- [ ] Category A tools work directly from the Worker without VM agent
- [ ] Missing workspace returns informative error (not crash)
- [ ] `packages/workspace-mcp/` is completely removed
- [ ] workspace-mcp injection logic is removed from VM agent
- [ ] All existing MCP tools continue to work (regression check)
- [ ] TypeScript types pass, lint passes, tests pass, build succeeds
- [ ] Configuration variables are documented and have sensible defaults

## References
- Idea spec: `01KNH084PRD3XZYB2BKAMNKSWR`
- Existing proxy: `apps/api/src/routes/projects/files.ts`
- MCP tools: `apps/api/src/routes/mcp/tool-definitions.ts`
- MCP dispatch: `apps/api/src/routes/mcp/index.ts`
- VM agent routes: `packages/vm-agent/internal/server/server.go`
- workspace-mcp injection: `packages/vm-agent/internal/acp/workspace_mcp.go`
