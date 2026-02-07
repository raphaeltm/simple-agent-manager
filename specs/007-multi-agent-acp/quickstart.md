# Quickstart: Multi-Agent ACP Development

**Feature**: 007-multi-agent-acp

## Prerequisites

- Node.js 20+, pnpm 9+
- Go 1.22+
- Docker (for devcontainer testing)
- API keys for at least one agent (Anthropic, OpenAI, or Google)

## 1. Install Dependencies

```bash
pnpm install
```

This installs all packages including the new `packages/acp-client`.

## 2. Understand the Architecture

```
Browser (apps/web)
    │
    ├── ACP Agent Panel (packages/acp-client)
    │   └── WebSocket → /agent/ws
    │
    └── PTY Terminal (packages/terminal)
        └── WebSocket → /terminal/ws
                │
VM Agent (packages/vm-agent)
    │
    ├── ACP Gateway (internal/acp/)
    │   └── stdio ↔ agent process (docker exec)
    │
    └── PTY Manager (internal/pty/)
        └── PTY ↔ shell (docker exec)
                │
Devcontainer (Docker)
    ├── claude-code-acp (pre-installed)
    ├── codex-acp (pre-installed)
    └── gemini --experimental-acp (pre-installed)
```

## 3. Key Development Areas

### Area A: VM Agent ACP Gateway (Go)

Location: `packages/vm-agent/internal/acp/`

```bash
# Run VM Agent tests
cd packages/vm-agent && go test ./internal/acp/...

# Build VM Agent
cd packages/vm-agent && make build
```

The gateway:
- Accepts WebSocket connections at `/agent/ws`
- Spawns agent processes via `docker exec -i <container> <command>`
- Bridges WebSocket text frames ↔ NDJSON lines (stdin/stdout)
- Uses `coder/acp-go-sdk` for typed ACP messages

### Area B: ACP Web Client (React/TypeScript)

Location: `packages/acp-client/`

```bash
# Run ACP client tests
pnpm --filter @simple-agent-manager/acp-client test

# Build
pnpm --filter @simple-agent-manager/acp-client build
```

Key components:
- `AgentPanel` — main conversation view
- `ToolCallCard` — tool execution display
- `PermissionDialog` — approve/reject UI
- `useAcpSession` — hook for session lifecycle

### Area C: API Credential Endpoints (TypeScript/Hono)

Location: `apps/api/src/routes/credentials.ts`, `apps/api/src/routes/agents.ts`

```bash
# Run API tests
pnpm --filter @simple-agent-manager/api test
```

New endpoints:
- `GET /api/agents` — agent catalog
- `PUT /api/credentials/agent` — save agent API key
- `GET /api/credentials/agent` — list agent keys (masked)
- `DELETE /api/credentials/agent/:agentType` — remove key

### Area D: Agent Registry (Shared Types)

Location: `packages/shared/src/agents.ts`

The agent registry defines all supported agents and their configuration. Add new agents here.

### Area E: Cloud-Init (Agent Installation)

Location: `packages/cloud-init/src/template.ts`

The cloud-init template installs all agents via npm global install during workspace provisioning.

## 4. Testing Locally

### Unit Tests

```bash
# All tests
pnpm test

# Specific packages
pnpm --filter @simple-agent-manager/acp-client test
pnpm --filter @simple-agent-manager/api test
cd packages/vm-agent && go test ./...
```

### Manual ACP Testing

To test ACP communication locally without a full VM:

```bash
# 1. Start an ACP agent directly (requires API key)
ANTHROPIC_API_KEY=sk-... npx @zed-industries/claude-code-acp

# 2. Send NDJSON to stdin, read from stdout:
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1","clientInfo":{"name":"test","version":"1.0.0"},"capabilities":{}}}' | npx @zed-industries/claude-code-acp
```

### Integration Testing

Deploy to staging per the Cloudflare-first development approach. Real agent testing requires a running workspace with Docker.

## 5. Key Files Reference

| Area | Path | Purpose |
|------|------|---------|
| Agent Registry | `packages/shared/src/agents.ts` | Agent definitions and types |
| ACP Gateway | `packages/vm-agent/internal/acp/gateway.go` | WebSocket ↔ stdio bridge |
| ACP Process | `packages/vm-agent/internal/acp/process.go` | Agent subprocess lifecycle |
| ACP Transport | `packages/vm-agent/internal/acp/transport.go` | Per-agent quirks |
| ACP Client Hooks | `packages/acp-client/src/hooks/useAcpSession.ts` | React session management |
| ACP WS Transport | `packages/acp-client/src/transport/websocket.ts` | Browser WebSocket adapter |
| Agent Panel UI | `packages/acp-client/src/components/AgentPanel.tsx` | Main conversation view |
| Credential Routes | `apps/api/src/routes/credentials.ts` | API key storage endpoints |
| Agent Routes | `apps/api/src/routes/agents-catalog.ts` | Agent catalog endpoint |
| Workspace Page | `apps/web/src/pages/Workspace.tsx` | Dual-mode ACP/PTY view |
| Settings Page | `apps/web/src/pages/Settings.tsx` | Agent API key management |
| Cloud-Init | `packages/cloud-init/src/template.ts` | Agent installation in VMs |
| DB Schema | `apps/api/src/db/schema.ts` | Credential table extensions |
