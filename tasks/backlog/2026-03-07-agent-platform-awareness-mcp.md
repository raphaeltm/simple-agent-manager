# Agent Platform Awareness via MCP

**Created**: 2026-03-07

## Problem

Agents running inside SAM workspaces have no structured way to interact with the platform. They receive env vars (`SAM_TASK_ID`, `SAM_PROJECT_ID`, etc.) but cannot:

1. **Query task context** — the agent doesn't know its task description, acceptance criteria, or project details beyond what's in the initial prompt
2. **Report task completion** — task completion is currently detected only when the ACP `HandlePrompt()` call returns, then the vm-agent fires a callback. The agent itself has no way to say "I'm done with this task" or "this task is blocked"
3. **Update task status** — no mechanism for incremental progress reporting (e.g., "3/5 checklist items done")

This limits the agent to a single-shot prompt-response pattern. For more autonomous workflows (multi-step tasks, self-directed work), the agent needs platform awareness.

## Research Findings

### Current Architecture

- **Env vars injected**: `SAM_TASK_ID`, `SAM_PROJECT_ID`, `SAM_CHAT_SESSION_ID`, `SAM_WORKSPACE_ID`, `SAM_REPOSITORY`, `SAM_BRANCH` — available in shell and via `docker exec -e` during ACP sessions (`bootstrap.go:ensureSAMEnvironment()`)
- **Initial prompt**: Task description sent via ACP `HandlePrompt()` as plain text (`workspaces.go:startAgentWithPrompt()`)
- **Task completion**: Detected when `HandlePrompt()` returns, then `makeTaskCompletionCallback()` fires HTTP POST to `/api/projects/{pid}/tasks/{tid}/status/callback`
- **No MCP servers registered**: `session_host.go` passes `McpServers: []acpsdk.McpServer{}` in both `NewSession` and `LoadSession`

### Available MCP Integration Points

The ACP SDK (`github.com/coder/acp-go-sdk v0.6.3`) already supports MCP server injection at session creation:

```go
type McpServer struct {
    Stdio *McpServerStdio
    Http  *McpServerHttp
    Sse   *McpServerSse
}

type McpServerHttp struct {
    Url     string
    Headers []HttpHeader
}
```

These are passed via `NewSessionRequest.McpServers` and the `claude-code-acp` adapter translates them into Claude Code's native MCP config. No file writing or CLI invocation needed.

Claude Code also reads `.mcp.json` from the project root and `~/.claude.json` for MCP config, which could be written via the existing `ProjectRuntimeFile` pipeline (`bootstrap.go:ensureProjectRuntimeAssets()`).

### Approaches Considered

#### A. HTTP MCP Server on the API (Recommended)

Expose an MCP endpoint on the API worker (e.g., `POST /mcp/task/{taskId}`) authenticated with a task-scoped bearer token. Register it via ACP `NewSessionRequest.McpServers` using the `McpServerHttp` type.

**Pros**: Cleanest separation. Uses standard MCP protocol. No new binaries to inject. Auth token scoped to the specific task. Tools are properly discoverable by the agent via MCP `tools/list`. Works for any agent type that supports MCP (Claude Code, Codex, Gemini).
**Cons**: Requires the container to reach the API over the network (already works — `SAM_API_URL` is set). Requires implementing an MCP server handler in Hono.

#### B. HTTP MCP Server on the VM Agent

Expose an MCP endpoint on the vm-agent's HTTP server (already runs on port 8080 inside the VM). The container can reach `host.docker.internal:8080` or the VM's internal IP.

**Pros**: Lower latency (local). VM agent already has task context. No external network dependency.
**Cons**: VM agent is Go, needs MCP server implementation. Container networking to host varies by Docker config. Auth still needed (agent shouldn't access arbitrary vm-agent endpoints).

#### C. Stdio MCP Server (CLI binary)

Inject a small CLI binary into the container that communicates with the vm-agent or API via stdout/stdin. Register via `McpServerStdio` in the ACP session.

**Pros**: No networking concerns. Stdio is the simplest MCP transport.
**Cons**: Need to build/distribute another binary. Must be available in all devcontainer images. More moving parts.

#### D. `.mcp.json` File Injection

Write a `.mcp.json` file into the workspace via the existing `ProjectRuntimeFile` pipeline, pointing to an HTTP MCP server.

**Pros**: Uses existing infrastructure. No vm-agent code changes for registration.
**Cons**: Per-project, not per-session. File written at provisioning time, so task-scoped tokens need to be known early. Less dynamic than ACP-level injection.

#### E. Initial Prompt Prefixing Only (No MCP)

Prefix the initial prompt with SAM context and instructions like "when done, create a file called `.task-complete`". VM agent watches for the file.

**Pros**: Zero infrastructure changes.
**Cons**: Fragile. No structured API. Agent can't query for info. File-watching is hacky. Doesn't work across agent types.

### Recommended Approach: A + ACP Injection

1. **Build an MCP server endpoint on the API** (`/mcp/task/{taskId}`) with tools:
   - `get_task_context` — returns task description, acceptance criteria, project info, checklist
   - `update_task_status` — report progress (checklist updates, status changes)
   - `complete_task` — mark task as completed with optional summary
   - `get_project_info` — project details, repo, default branch, recent activity

2. **Generate a task-scoped auth token** at task start time (short-lived JWT or KV-stored opaque token scoped to the specific task + project). Passed as a bearer token header on the MCP server.

3. **Register the MCP server via ACP** by populating `NewSessionRequest.McpServers` with an `McpServerHttp` entry. This requires:
   - Adding MCP server config to `GatewayConfig` in `gateway.go`
   - Passing MCP server details from the API to the vm-agent in the `start` request body
   - Populating `McpServers` in `session_host.go` instead of the empty slice

4. **Inject behavioral guidance via initial prompt prefix** — SAM already controls the initial prompt sent to the agent (`workspaces.go:startAgentWithPrompt()`). Prepend platform instructions (e.g., "When you've completed the task, call the `complete_task` tool. Report progress using `update_task_status`.") before the user's task description. This requires no user configuration — SAM owns the prompt construction.

### How the Agent Learns About Tools

**Tool discovery is automatic.** When MCP servers are registered via ACP `NewSessionRequest.McpServers`, Claude Code calls MCP `tools/list` and the tools appear alongside built-in tools (Read, Write, Bash, etc.). No CLAUDE.md or user config needed.

**Behavioral guidance goes in the initial prompt prefix**, not CLAUDE.md. SAM should not rely on users configuring CLAUDE.md for platform features to work. The prompt prefix is fully platform-controlled and tells the agent *when* and *how* to use the SAM tools (e.g., "Call `complete_task` when finished"). This is analogous to how the task description is already injected today — just with additional platform instructions prepended.

### Key Code Locations

| File | What to change |
|------|---------------|
| `packages/vm-agent/internal/acp/session_host.go:904,941` | Populate `McpServers` field |
| `packages/vm-agent/internal/acp/gateway.go:94` | Add MCP config to `GatewayConfig` |
| `packages/vm-agent/internal/server/workspaces.go:576` | Accept MCP server details in start request |
| `apps/api/src/routes/` | New MCP endpoint route |
| `apps/api/src/services/node-agent.ts` | Pass MCP server URL + token in start request |
| `apps/api/src/durable-objects/task-runner.ts` | Generate task-scoped token, construct MCP URL |

## Speckit Integration

This feature should go through speckit for proper design:

1. `/speckit.specify` — full spec with data model for task-scoped tokens, MCP tool schemas, auth flow
2. `/speckit.plan` — implementation plan covering API MCP handler, vm-agent plumbing, token lifecycle
3. `/speckit.tasks` — task breakdown

## Acceptance Criteria

- [ ] Agent running in a SAM workspace can discover SAM MCP tools via standard MCP protocol
- [ ] Agent can query its own task context (description, project, checklist) via MCP tool call
- [ ] Agent can report task completion via MCP tool call, which updates task status in D1
- [ ] Agent can report incremental progress via MCP tool call
- [ ] MCP auth token is scoped to the specific task and has a bounded lifetime
- [ ] Works with Claude Code agent type; designed to be agent-type-agnostic
- [ ] Platform-controlled initial prompt prefix tells the agent when/how to use SAM tools (no user CLAUDE.md required)
- [ ] No hardcoded URLs — MCP server URL derived from `SAM_API_URL` / `BASE_DOMAIN`

## Open Questions

- Should the MCP server live on the API worker or the vm-agent? (Recommendation: API, but vm-agent proxy could reduce latency)
- What's the token format — JWT with task claims, or opaque token stored in KV? (KV is simpler to revoke)
- Should the agent be able to create follow-up tasks? (Stretch goal)
- How do we handle MCP server registration for non-Claude-Code agents (Codex, Gemini)?
- Should we expose project files / chat history via MCP tools?
