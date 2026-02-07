# Research: Multi-Agent ACP Implementation

**Feature**: 007-multi-agent-acp
**Date**: 2026-02-06
**Status**: Complete

## Research Questions Resolved

### 1. ACP Protocol Maturity & Transport

**Decision**: Use ACP v0.14.x as the structured communication protocol, with a custom WebSocket ↔ stdio NDJSON bridge in the VM Agent.

**Rationale**: ACP is the most widely adopted agent-editor protocol (30+ agents, Zed/JetBrains/Neovim support). The SDK at v0.14.1 has 160+ npm dependents and is stable for core features (sessions, prompts, tool calls, permissions). Remote WebSocket transport is officially WIP but the protocol is explicitly designed to be transport-agnostic — each NDJSON line maps cleanly to one WebSocket text frame.

**Alternatives considered**:
- **Wait for official WebSocket transport**: Rejected — timeline unknown, and our bridge is trivial (line ↔ frame mapping)
- **MCP (Model Context Protocol)**: Different purpose — MCP connects agents to tools/data sources, ACP connects editors to agents. Complementary, not competing.
- **Custom protocol**: Rejected — unnecessary when ACP already standardizes agent communication
- **Raw PTY only**: Rejected — loses structured UI benefits (tool cards, permissions, diffs, thinking)

### 2. Agent ACP Support Status

**Decision**: Support three agents at launch using their respective ACP interfaces. Accept adapter-based ACP for Claude Code and Codex; native ACP for Gemini.

| Agent | ACP Support | How to Start | Package |
|-------|------------|--------------|---------|
| **Claude Code** | Via adapter (`@zed-industries/claude-code-acp`) | `claude-code-acp` (stdio) | `@zed-industries/claude-code-acp` |
| **OpenAI Codex** | Via adapter (`codex-acp`) | `codex-acp` (stdio) | `codex-acp` (community, cola-io/codex-acp) |
| **Google Gemini CLI** | Native | `gemini --experimental-acp` (stdio) | `@google/gemini-cli` |

**Rationale**: All three agents can speak ACP over stdio NDJSON today. Claude Code and Codex use community-maintained adapters that wrap the native CLIs. Gemini has native support (co-created the protocol with Zed). The adapters are actively maintained and used by Zed editor in production.

**Alternatives considered**:
- **Only support native ACP agents (Gemini only)**: Rejected — Claude Code is SAM's primary agent, must be supported
- **Build our own adapters**: Rejected — existing adapters work, maintained by Zed/community, no need to duplicate effort
- **Use Happy Coder's integration patterns**: Rejected — Happy Coder uses 3 different strategies (direct spawn, MCP, ACP), adding unnecessary complexity. ACP alone is sufficient.

### 3. Go ACP SDK for VM Agent

**Decision**: Use `coder/acp-go-sdk` for the VM Agent's ACP gateway implementation.

**Rationale**: The `coder/acp-go-sdk` (by Coder) provides typed ACP requests/responses, client-side connection management, and examples including Claude Code and Gemini CLI bridges. It handles NDJSON parsing, JSON-RPC framing, and protocol negotiation. Using it avoids hand-rolling JSON-RPC parsing in Go.

Key SDK features:
- `acp.NewClientSideConnection(client, stdin, stdout)` — creates connection to agent process
- `acp.Client` interface — implement to handle agent notifications (messages, tool calls, permissions)
- Examples: Claude Code bridge, Gemini CLI bridge (directly applicable to our use case)
- Version: v0.10.7

**Alternatives considered**:
- **Hand-roll NDJSON/JSON-RPC in Go**: Rejected — error-prone, SDK handles edge cases
- **TypeScript SDK on VM**: Rejected — VM Agent is Go, adding Node.js runtime defeats single-binary architecture
- **agent-client-protocol Rust crate**: Rejected — not Go, different ecosystem

### 4. TypeScript ACP SDK for Browser Client

**Decision**: Use `@agentclientprotocol/sdk` v0.14.x for TypeScript type definitions. Implement custom WebSocket transport adapter since the SDK only provides stdio transport.

**Rationale**: The SDK's `ClientSideConnection` class accepts a `Stream` interface (readable + writable). We implement this interface over WebSocket — each WebSocket text message = one NDJSON line. The SDK handles JSON-RPC parsing, message routing, and protocol state.

```typescript
// Our custom adapter:
function createWebSocketStream(ws: WebSocket): Stream {
  const readable = new ReadableStream({
    start(controller) {
      ws.onmessage = (e) => controller.enqueue(JSON.parse(e.data));
      ws.onclose = () => controller.close();
    }
  });
  const writable = new WritableStream({
    write(msg) { ws.send(JSON.stringify(msg)); }
  });
  return { readable, writable };
}
```

**Alternatives considered**:
- **Build from scratch without SDK**: Rejected — would duplicate protocol parsing, message types, and state management
- **Wait for SDK WebSocket transport**: Rejected — not yet available, our adapter is trivial
- **Use Vercel AI SDK's ACP provider**: Considered — the `@ai-sdk/acp` community provider exists but targets server-side AI SDK usage, not browser client rendering

### 5. Agent Process Lifecycle in Devcontainers

**Decision**: VM Agent spawns agent processes inside the devcontainer via `docker exec` with piped stdio. All agents pre-installed during workspace provisioning.

**Rationale**: The current VM Agent already discovers the devcontainer (Docker label-based discovery in `internal/container/discovery.go`) and executes commands inside it for PTY sessions. The same pattern works for ACP agent processes — `docker exec -i <container-id> claude-code-acp` with stdin/stdout piped to the ACP gateway.

**Key implementation details**:
- Agent processes run inside the devcontainer (where the code and tools live)
- VM Agent runs on the host (where it has network access for WebSocket)
- `docker exec -i` (not `-it`) — we need piped stdio, not a TTY
- Agent API keys injected as environment variables in `docker exec`
- Process monitored; auto-restart on crash (3 attempts, then fallback to PTY)

**Alternatives considered**:
- **Run agent on host**: Rejected — agents need access to workspace files inside the container
- **Use devcontainer exec CLI**: Rejected — adds Node.js dependency on host, `docker exec` is simpler
- **Shared filesystem mount**: Rejected — more complex, agent tooling expects to run inside the dev environment

### 6. Agent Credential Flow

**Decision**: Extend existing encrypted credential storage to support agent API keys. Keys are fetched by the control plane and passed to the VM Agent via a secure channel at workspace startup, then injected into agent processes as environment variables.

**Rationale**: SAM already has per-user AES-GCM encrypted credential storage for Hetzner tokens. The same pattern works for agent API keys. The credential type is extended (adding `credential_type` and `agent_type` columns), and the API key is injected via the bootstrap token flow that already exists.

**Flow**:
1. User saves API key in Settings → encrypted in D1
2. Workspace starts → control plane includes encrypted agent keys in bootstrap payload
3. VM Agent receives keys at startup (or on-demand via API call)
4. VM Agent injects key as env var when spawning agent: `docker exec -e ANTHROPIC_API_KEY=... claude-code-acp`

**Alternatives considered**:
- **Store keys in KV**: Rejected — D1 already has encrypted credentials with the right access patterns
- **Embed keys in cloud-init**: Rejected — cloud-init is logged and visible to cloud provider. Bootstrap token flow is more secure.
- **Agent-side authentication (OAuth flows)**: Rejected — Gemini supports OAuth but it's interactive and doesn't work in headless containers. API keys are simpler and sufficient.

### 7. Cloud-Init: Pre-Install All Agents

**Decision**: Install all three agents (Claude Code ACP adapter, Codex ACP adapter, Gemini CLI) during workspace provisioning via the devcontainer setup.

**Rationale**: Users should be able to switch agents at runtime without reprovisioning. The total install size is small (each is an npm package < 50MB). Installing all three adds ~30-60 seconds to initial provisioning but avoids the need to track which agent a workspace supports.

**Implementation**:
```bash
# In devcontainer post-create script or cloud-init:
npm install -g @zed-industries/claude-code-acp
npm install -g codex-acp
npm install -g @google/gemini-cli
```

**Alternatives considered**:
- **Install only selected agent**: Rejected per user feedback — users want to switch agents without reprovisioning
- **Install on-demand when user selects**: Rejected — adds latency to agent switch (npm install takes 30+ seconds)
- **Devcontainer features**: Acceptable alternative but npm global installs are simpler and more uniform

### 8. Structured UI Component Strategy

**Decision**: Create a new `packages/acp-client` React package with dedicated components for each ACP message type. Use the existing `packages/terminal` as the PTY fallback — unchanged.

**Rationale**: ACP defines clear message types (agent_message_chunk, tool_call, tool_call_update, request_permission, agent_thought_chunk, plan, usage_update). Each maps to a distinct UI component. Keeping these in a separate package follows the monorepo convention and allows independent testing.

**Key components**:
- `AgentPanel` — main container with message list + prompt input
- `MessageBubble` — formatted markdown with syntax highlighting
- `ToolCallCard` — shows tool name, target, status (running/completed/failed)
- `PermissionDialog` — approve/reject with action description
- `ThinkingBlock` — collapsible reasoning display
- `FileDiffView` — code diff (additions/removals)
- `TerminalBlock` — embedded command output within conversation
- `ModeSelector` — agent operating mode switcher

**Alternatives considered**:
- **Embed in apps/web directly**: Rejected — violates IX (Clean Code Architecture), acp-client could be reused by other apps
- **Extend existing terminal package**: Rejected — fundamentally different rendering model (structured messages vs raw PTY)
- **Use a third-party chat UI library**: Considered — but ACP message types are specialized (tool calls, permissions, diffs) and no existing library handles all of them

## Technology Decisions Summary

| Decision | Choice | Key Reason |
|----------|--------|------------|
| Protocol | ACP v0.14.x | Industry standard, 30+ agents, official SDKs |
| Go SDK | `coder/acp-go-sdk` | Typed ACP client, includes Claude/Gemini examples |
| TS SDK | `@agentclientprotocol/sdk` | Official types, Stream interface for custom transport |
| Transport Bridge | Custom WS ↔ NDJSON (trivial) | ACP WebSocket transport WIP, bridge is ~50 lines |
| Claude Code ACP | `@zed-industries/claude-code-acp` | Production-quality adapter used by Zed |
| Codex ACP | `codex-acp` | Community adapter, ACP-compatible |
| Gemini ACP | `gemini --experimental-acp` | Native support, co-created the protocol |
| Agent install | Pre-install all via npm | Enables runtime switching per user feedback |
| Credential storage | Extend existing D1 encrypted credentials | Proven pattern, minimal new code |
| UI components | New `packages/acp-client` React package | Clean separation, independent testing |

## References

- [ACP Protocol Overview](https://agentclientprotocol.com/protocol/overview)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) — v0.14.x
- [ACP Go SDK (Coder)](https://github.com/coder/acp-go-sdk) — v0.10.7
- [Claude Code ACP Adapter](https://github.com/zed-industries/claude-code-acp)
- [Codex ACP Bridge](https://github.com/cola-io/codex-acp)
- [Gemini CLI ACP](https://zed.dev/acp/agent/gemini-cli)
- [Copilot CLI ACP Preview](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/)
- [JetBrains ACP Agent Registry](https://blog.jetbrains.com/ai/2026/01/acp-agent-registry/)
