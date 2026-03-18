# Workspace-Aware MCP Server — Priority 1 (High-Value Tools)

**Created**: 2026-03-18
**Context**: Agents running inside SAM workspaces lack platform-level awareness. A workspace-aware MCP server bridges the gap between what the agent can see locally and what the control plane knows. This task covers the highest-value tools — ones that solve daily friction or enable core multi-agent coordination.

## Background

Today agents get limited context via:
- **`SAM_*` environment variables** — static, frozen at boot
- **`get_instructions()`** — task/project metadata only
- **VM agent HTTP API** — rich but agents don't know endpoints or auth

The principle: **only build MCP tools for things that cross the container boundary**. If the agent can `bash` it, it doesn't need an MCP tool.

## Architecture

A lightweight MCP server (stdio transport, injected per-session alongside the existing SAM MCP server) that:
1. **Reads local state** for self-awareness (env vars, `/proc`)
2. **Proxies to the VM agent API** for workspace operations (ports, processes, network)
3. **Calls the control plane API** for project/platform knowledge (cost, agents, tasks, CI)

The server should be a small Node.js/TypeScript process bundled into the devcontainer or started by the VM agent at session creation. Configuration via env vars injected at boot (VM agent API URL, control plane API URL, auth token).

## Implementation Checklist

### A) Server scaffold

- [ ] Create `packages/workspace-mcp/` with stdio MCP server skeleton (TypeScript, `@modelcontextprotocol/sdk`)
- [ ] Configure injection in cloud-init / devcontainer setup so it's available as an MCP server to Claude Code sessions
- [ ] Auth: server reads a session-scoped token (injected as env var) to authenticate against VM agent and control plane APIs
- [ ] Add to monorepo build order, CI, and `pnpm build`

### B) Network & Connectivity tools (highest daily friction)

- [ ] `get_network_info` — returns base domain, workspace URL, all currently exposed ports with their external URLs (`https://ws-${id}--${port}.${BASE_DOMAIN}`). Sources: env vars for workspace ID/base domain, VM agent API for port list.
- [ ] `expose_port` — takes port number + optional label, registers with VM agent, returns the external URL. Agent starts a dev server and immediately knows the public URL.
- [ ] `check_dns_status` — checks whether workspace DNS has propagated and TLS cert is valid. Useful for debugging "workspace not reachable" without guessing.

### C) Identity & orientation tools

- [ ] `get_workspace_info` — consolidates workspace ID, node ID, project ID, repo, branch, mode (task vs conversation), VM size, creation time, workspace URL into one structured response. Replaces scattered env var lookups.
- [ ] `get_credential_status` — reports which credentials are available (GitHub token, API key, OAuth token), their type, and whether they're valid/expired. Prevents silent auth failures mid-task.

### D) Cost & resource awareness tools

- [ ] `check_cost_estimate` — returns VM hourly rate, runtime duration so far, estimated total cost for the session. Sources: VM size from workspace metadata, pricing from control plane, uptime from VM agent or `/proc/uptime`.
- [ ] `get_remaining_budget` — if project has a cost cap configured, returns remaining budget. Sources: control plane API.

### E) Multi-agent coordination tools

- [ ] `list_project_agents` — returns all active agent sessions on this project with their task descriptions, status, branches, and workspace IDs. Enables conflict avoidance — "who else is working here?"
- [ ] `get_file_locks` — returns files currently being modified by other agents on the same repo (derived from active workspace git status or branch diffs). Prevents merge conflicts before they happen.
- [ ] `get_peer_agent_output` — retrieves the summary/result from a sibling task agent by task ID. Core multi-agent primitive — agents build on each other's work.

### F) Task & dependency awareness tools

- [ ] `get_task_dependencies` — returns tasks that depend on the current task and tasks the current task depends on, with their status. Agent understands its place in the dependency graph.

### G) CI/CD awareness tools

- [ ] `get_ci_status` — returns GitHub Actions workflow status for the current branch. Structured alternative to `gh run list` that the agent already does manually.
- [ ] `get_deployment_status` — returns staging/production deployment state, last deploy time, which branch is deployed, whether a deployment is currently in progress.

### H) Observability & reporting tools

- [ ] `report_environment_issue` — structured issue report (category, severity, description, diagnostic data) that feeds into the observability dashboard. First-class event, not a chat message.
- [ ] `get_workspace_diff_summary` — returns all changes since workspace creation, organized by area (files changed, new files, deleted files, summary). Enables workspace hand-off to another agent.

### I) Testing

- [ ] Unit tests for each tool handler (mock VM agent API and control plane API responses)
- [ ] Integration test: MCP server starts, tool discovery works, a tool call returns structured data
- [ ] Capability test: agent session with workspace MCP server available, agent calls `get_network_info`, receives correct workspace URL

## Acceptance Criteria

- [ ] Workspace MCP server runs as a stdio process injected into agent sessions
- [ ] All 15 tools listed above are implemented and return structured JSON
- [ ] Tools that need VM agent API have proper error handling for agent unavailability
- [ ] Tools that need control plane API authenticate with session-scoped token
- [ ] `expose_port` actually registers the port and returns a working URL
- [ ] `get_file_locks` shows files being edited by other active agents
- [ ] `get_ci_status` returns real GitHub Actions data
- [ ] Unit tests for all tool handlers
- [ ] Integration test for server lifecycle + tool discovery
- [ ] Capability test for at least one end-to-end tool call

## References

- `apps/api/src/routes/mcp.ts` — existing SAM MCP server (pattern reference)
- `packages/vm-agent/internal/server/` — VM agent HTTP API endpoints
- `packages/cloud-init/` — devcontainer/session setup where MCP servers are injected
- `apps/api/src/services/project-data.ts` — control plane data access patterns
- `tasks/backlog/2026-03-18-workspace-mcp-server-p2.md` — lower priority batch
