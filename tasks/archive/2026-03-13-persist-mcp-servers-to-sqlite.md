# Persist MCP Server Config to VM Agent SQLite

## Problem

MCP server configurations for ACP sessions are stored only in an in-memory map (`sessionMcpServers`) on the VM agent. This causes inconsistent MCP tool availability because:

1. **Race condition**: If a WebSocket connection triggers `getOrCreateSessionHost` before `handleStartAgentSession` stores the MCP config, the SessionHost is created without MCP servers.
2. **Process restart**: If the VM agent restarts, the in-memory map is lost. The SessionHost can be recreated from persisted ACP session IDs, but MCP server configs are gone.
3. **Silent failure**: There's no error when MCP servers are missing — the agent just doesn't have the `sam-mcp` tools available.

## Research Findings

### Current Flow
- Task runner (CF Worker DO) generates an MCP token, stores it in KV, then calls `startAgentSessionOnNode()` with `{url, token}` — `task-runner.ts:~836-891`
- VM agent `handleStartAgentSession` stores MCP servers in `s.sessionMcpServers[hostKey]` (in-memory map) — `workspaces.go:~651-665`
- `getOrCreateSessionHost` reads from `s.sessionMcpServers[hostKey]` — `agent_ws.go:~263-265`
- `buildAcpMcpServers()` converts entries to ACP SDK format — `session_host.go:~41-68`

### Persistence Store
- SQLite-backed store at `packages/vm-agent/internal/persistence/store.go`
- Currently at migration V4 (tabs + workspace_metadata tables)
- Uses `sync.RWMutex` for thread safety
- Already used by `getOrCreateSessionHost` to hydrate ACP session IDs from tabs

### Key Files
- `packages/vm-agent/internal/persistence/store.go` — Store + migrations
- `packages/vm-agent/internal/server/workspaces.go` — `handleStartAgentSession`
- `packages/vm-agent/internal/server/agent_ws.go` — `getOrCreateSessionHost`
- `packages/vm-agent/internal/server/server.go` — Server struct, `sessionMcpServers` map
- `packages/vm-agent/internal/acp/gateway.go` — `McpServerEntry` type, `GatewayConfig.McpServers`

## Implementation Checklist

- [ ] Add V5 migration creating `session_mcp_servers` table
- [ ] Add `UpsertSessionMcpServers(workspaceID, sessionID string, servers []McpServerEntry)` method
- [ ] Add `GetSessionMcpServers(workspaceID, sessionID string) ([]McpServerEntry, error)` method
- [ ] Add `DeleteSessionMcpServers(workspaceID, sessionID string)` method
- [ ] Add unit tests for all three Store methods
- [ ] Update `handleStartAgentSession` to write MCP servers to SQLite (in addition to in-memory map)
- [ ] Update `getOrCreateSessionHost` to fall back to SQLite when in-memory map miss
- [ ] Update session cleanup paths (stop, delete, suspend) to delete from SQLite
- [ ] Run `go test ./...` and `go vet ./...`

## Acceptance Criteria

- [ ] MCP server configs survive VM agent process restarts
- [ ] MCP server configs are available even if WebSocket connects before start call
- [ ] Cleanup removes MCP server configs from SQLite when session ends
- [ ] All existing tests pass; new tests cover CRUD operations
- [ ] No import cycle between persistence and acp packages (use plain strings in Store, convert in server)

## References

- `docs/notes/2026-03-08-mcp-token-revocation-postmortem.md` — related MCP token lifecycle issue
- `tasks/active/2026-03-08-mcp-token-revocation-breaks-session.md` — active related task
