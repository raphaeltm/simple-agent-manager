# Feature Specification: Multi-Agent Support via ACP

**Feature Branch**: `006-multi-agent-support`
**Created**: 2026-02-05
**Status**: Draft (Pre-Spec)
**Input**: Support multiple AI coding agents (Claude Code, OpenAI Codex, Google Gemini CLI) via the Agent Client Protocol, with agent-specific wrappers running inside devcontainers and a structured web UI.

## Overview

Extend SAM to support multiple AI coding agents — not just Claude Code — by adopting the Agent Client Protocol (ACP) as the communication standard between the web UI and agent processes. Users select their preferred agent when creating a workspace, provide their own API key, and get a rich structured UI (tool calls, permissions, thinking indicators, file diffs) instead of a raw terminal.

**Key Design Principles**:
1. **ACP-first, PTY-fallback** — Use ACP for structured agent communication; keep raw terminal as fallback
2. **Agent runs in devcontainer** — Agent processes live inside Docker, managed by VM Agent on the host
3. **VM Agent as ACP gateway** — Bridges WebSocket (browser) ↔ stdio NDJSON (agent process)
4. **BYOK (Bring Your Own Key)** — Users provide their own API keys for each agent, stored encrypted
5. **Incremental adoption** — Can ship ACP for one agent first, expand to others

---

## User Scenarios & Testing

### User Story 1 — Choose an Agent When Creating a Workspace (Priority: P1)

An authenticated user creates a workspace and selects which AI coding agent to use. The platform provisions the workspace with only the selected agent installed.

**Why this priority**: Agent selection is the foundational UX change. Everything else builds on the user's choice of agent.

**Independent Test**: User can see a list of supported agents in the workspace creation form, select one, and see the workspace created with that agent.

**Acceptance Scenarios**:

1. **Given** a user on the Create Workspace page, **When** they view the agent selector, **Then** they see available agents (Claude Code, Codex, Gemini) with descriptions and icons
2. **Given** a user selects "Google Gemini", **When** the workspace is provisioned, **Then** only the Gemini CLI is installed in the devcontainer (not Claude or Codex)
3. **Given** a user has not configured an API key for the selected agent, **When** they try to create the workspace, **Then** they are prompted to add the required API key in Settings first
4. **Given** a workspace is created with a specific agent, **When** the user views the workspace, **Then** the agent type is displayed in the workspace metadata

---

### User Story 2 — Manage Agent API Keys (Priority: P2)

A user navigates to Settings and configures API keys for one or more coding agents. Keys are encrypted and stored per-user.

**Why this priority**: Without API keys, agents cannot authenticate with their respective providers. This extends the existing BYOC credential model to agent credentials.

**Independent Test**: User can add, view (masked), update, and remove API keys for each supported agent.

**Acceptance Scenarios**:

1. **Given** a user on the Settings page, **When** they view the "Agent API Keys" section, **Then** they see a card for each supported agent with its connection status
2. **Given** a user enters a valid Anthropic API key, **When** they click "Save", **Then** the key is encrypted and stored, and the card shows "Connected"
3. **Given** a user has a saved API key, **When** they view it, **Then** only the last 4 characters are visible (e.g., `sk-ant-...7x9Q`)
4. **Given** a user removes an API key, **When** they have running workspaces using that agent, **Then** they see a warning that those workspaces will lose agent access on restart

---

### User Story 3 — Structured Agent UI via ACP (Priority: P3)

A user opens a running workspace and sees a rich, structured interface showing the agent's responses, tool calls, permission requests, and thinking process — instead of a raw terminal.

**Why this priority**: This is the core UX improvement that ACP enables. A structured UI is dramatically better than watching raw terminal output.

**Independent Test**: User can send a prompt, see streaming markdown response, see tool call cards, approve/reject tool permissions, and view file diffs — all in the browser.

**Acceptance Scenarios**:

1. **Given** a running workspace with ACP-enabled agent, **When** the user opens the workspace, **Then** they see a chat-like interface with a prompt input and message history
2. **Given** the user sends "read the README and summarize it", **When** the agent responds, **Then** the response streams in as formatted markdown with syntax-highlighted code blocks
3. **Given** the agent wants to edit a file, **When** it requests permission, **Then** the user sees a permission dialog with the tool name, file path, and approve/reject buttons
4. **Given** the agent edits a file, **When** the tool call completes, **Then** the user sees a diff view showing the changes made
5. **Given** the agent is thinking, **When** extended thinking chunks arrive, **Then** a collapsible "Thinking..." section shows the agent's reasoning
6. **Given** the agent runs a terminal command, **When** the command executes, **Then** the output appears in an embedded terminal block within the conversation

---

### User Story 4 — PTY Fallback Terminal (Priority: P4)

A user can toggle between the structured ACP view and a raw PTY terminal at any time. If ACP fails to connect, the PTY terminal is shown automatically.

**Why this priority**: ACP is pre-1.0 and agents may have bugs. Users need escape hatch to raw terminal access.

**Independent Test**: User can switch between ACP view and PTY terminal, and if ACP connection drops, the terminal appears automatically.

**Acceptance Scenarios**:

1. **Given** a user in the ACP view, **When** they click "Switch to Terminal", **Then** they see the familiar xterm.js terminal with a shell prompt
2. **Given** the ACP connection fails during initialization, **When** the workspace loads, **Then** the PTY terminal is shown automatically with a banner: "Structured view unavailable — using terminal mode"
3. **Given** a user in the PTY terminal, **When** they click "Switch to Agent View", **Then** they return to the structured ACP interface (session state is preserved on the agent side)
4. **Given** an agent that does not support ACP, **When** the workspace opens, **Then** only the PTY terminal is available (no toggle shown)

---

### User Story 5 — Agent-Specific Configuration (Priority: P5)

A user can configure agent-specific settings for their workspace, such as agent mode (ask/architect/code), auto-approve rules, and model selection.

**Why this priority**: Power users need to configure agent behavior. ACP provides this through modes and config options.

**Acceptance Scenarios**:

1. **Given** an ACP-connected agent that supports modes, **When** the user opens the mode selector, **Then** they see available modes (e.g., "Ask", "Code", "Architect") as reported by the agent
2. **Given** the user selects "Code" mode, **When** the mode changes, **Then** the agent switches behavior and the UI updates the mode indicator
3. **Given** an agent that supports model selection, **When** the user opens model settings, **Then** they see available models from the agent's capabilities

---

## Technical Architecture

### System Context

```
┌──────────────────────────────────────────────────────────┐
│  Browser                                                 │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  SAM Web UI                                         │ │
│  │  ┌──────────────────┐  ┌─────────────────────────┐  │ │
│  │  │  ACP Agent Panel │  │  PTY Terminal (fallback) │  │ │
│  │  │  - Chat messages │  │  - xterm.js (existing)   │  │ │
│  │  │  - Tool cards    │  │                          │  │ │
│  │  │  - Permissions   │  │                          │  │ │
│  │  │  - Diffs         │  │                          │  │ │
│  │  │  - Thinking      │  │                          │  │ │
│  │  └────────┬─────────┘  └────────┬────────────────┘  │ │
│  └───────────┼─────────────────────┼────────────────────┘ │
└──────────────┼─────────────────────┼─────────────────────┘
               │ WS (ACP/JSON-RPC)   │ WS (PTY binary)
               │                     │
┌──────────────┼─────────────────────┼─────────────────────┐
│  VM Host     │                     │                     │
│  ┌───────────┴─────────────────────┴──────────────────┐  │
│  │  VM Agent (Go binary)                              │  │
│  │                                                    │  │
│  │  ┌──────────────────────┐  ┌────────────────────┐  │  │
│  │  │  ACP Gateway         │  │  PTY Manager       │  │  │
│  │  │  - WS ↔ NDJSON      │  │  (existing,        │  │  │
│  │  │  - Agent lifecycle   │  │   unchanged)       │  │  │
│  │  │  - Transport handler │  │                    │  │  │
│  │  └──────────┬───────────┘  └────────────────────┘  │  │
│  └─────────────┼──────────────────────────────────────┘  │
│                │ stdio (NDJSON via docker exec)           │
│  ┌─────────────┼──────────────────────────────────────┐  │
│  │  Devcontainer (Docker)                             │  │
│  │  ┌──────────┴───────────────────────────────────┐  │  │
│  │  │  Agent Process                               │  │  │
│  │  │  - claude --acp                              │  │  │
│  │  │  - gemini --experimental-acp                 │  │  │
│  │  │  - codex --acp                               │  │  │
│  │  │                                              │  │  │
│  │  │  Environment:                                │  │  │
│  │  │  - ANTHROPIC_API_KEY / OPENAI_API_KEY / etc. │  │  │
│  │  │  - Workspace at /workspace                   │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Component Responsibilities

#### 1. ACP Gateway (New — in VM Agent, Go)

The ACP Gateway is a new module in the VM Agent that:

- **Accepts WebSocket connections** at `/agent/ws` (alongside existing `/terminal/ws` for PTY)
- **Spawns agent processes** inside the devcontainer via `docker exec` with stdio piped
- **Bridges transports**: reads NDJSON from agent's stdout, writes to WebSocket; reads WebSocket messages, writes NDJSON to agent's stdin
- **Handles agent lifecycle**: start, monitor health, restart on crash, clean shutdown
- **Implements transport handlers**: per-agent quirks (stdout filtering, init timeouts, tool name resolution)

```go
// New package: internal/acp/
type Gateway struct {
    agentType       string          // "claude-code", "openai-codex", "google-gemini"
    agentCmd        string          // "claude"
    agentArgs       []string        // ["--acp"]
    containerID     string          // Docker container to exec into
    process         *AgentProcess   // Running agent with piped stdio
    idleDetector    *idle.Detector  // Shared with PTY manager
    transport       TransportHandler // Agent-specific quirks
}

type TransportHandler interface {
    InitTimeout() time.Duration
    FilterStdoutLine(line string) (string, bool)  // Filter non-JSON output
    HandleStderr(line string) error                // Parse agent errors
}

type AgentProcess struct {
    cmd    *exec.Cmd
    stdin  io.WriteCloser
    stdout io.ReadCloser
    stderr io.ReadCloser
    done   chan struct{}
}
```

**WebSocket Message Format**: Raw ACP JSON-RPC messages forwarded as WebSocket text frames. Each line of NDJSON becomes one WebSocket message. The browser's ACP client parses JSON-RPC directly.

#### 2. ACP Web Client (New — React components in packages/acp-client)

A new package providing React components that implement an ACP client in the browser:

```
packages/acp-client/
├── src/
│   ├── AcpProvider.tsx          # Context provider, manages WS connection
│   ├── useAcpSession.ts         # Hook: initialize, prompt, cancel
│   ├── useAcpMessages.ts        # Hook: streaming message state
│   │
│   ├── components/
│   │   ├── AgentPanel.tsx        # Main panel (message list + input)
│   │   ├── MessageBubble.tsx     # Single agent/user message
│   │   ├── ToolCallCard.tsx      # Tool call with status, diff, output
│   │   ├── PermissionDialog.tsx  # Approve/reject tool execution
│   │   ├── ThinkingBlock.tsx     # Collapsible reasoning display
│   │   ├── FileDiffView.tsx      # Side-by-side or unified diff
│   │   ├── TerminalBlock.tsx     # Embedded terminal output in chat
│   │   ├── UsageIndicator.tsx    # Token usage display
│   │   └── ModeSelector.tsx      # Agent mode switcher
│   │
│   ├── transport/
│   │   ├── websocket.ts          # WebSocket ↔ ACP JSON-RPC bridge
│   │   └── types.ts              # ACP message types (from SDK schema)
│   │
│   └── index.ts
├── package.json                  # Depends on @agentclientprotocol/sdk
└── tsconfig.json
```

**Key Design Decision**: Use `@agentclientprotocol/sdk`'s type definitions but implement our own WebSocket transport (since the SDK only provides stdio transport). The SDK's `ClientSideConnection` expects a `Stream` interface — we implement that interface over WebSocket.

```typescript
// Custom WebSocket stream adapter for ACP SDK
import { type Stream, ClientSideConnection } from '@agentclientprotocol/sdk';

function createWebSocketStream(ws: WebSocket): Stream {
  const readable = new ReadableStream({
    start(controller) {
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        controller.enqueue(message);
      };
      ws.onclose = () => controller.close();
    }
  });

  const writable = new WritableStream({
    write(message) {
      ws.send(JSON.stringify(message));
    }
  });

  return { readable, writable };
}
```

#### 3. Agent Registry (New — in API + shared types)

A configurable registry of supported agents:

```typescript
// packages/shared/src/agents.ts
export interface AgentDefinition {
  id: AgentType;
  name: string;
  description: string;
  icon: string;                     // URL or icon identifier

  // ACP integration
  acpCommand: string;               // Binary name inside devcontainer
  acpArgs: string[];                // Args to enable ACP mode
  supportsAcp: boolean;

  // Installation
  devcontainerFeature?: string;     // Feature URI for devcontainer.json
  installCommand?: string;          // Fallback: npm install command

  // Credentials
  envVarName: string;               // e.g., 'ANTHROPIC_API_KEY'
  credentialLabel: string;          // e.g., 'Anthropic API Key'
  credentialHelpUrl: string;        // Link to "get an API key" page

  // Agent-specific transport config
  initTimeoutMs: number;            // ACP init timeout
  stdoutFilterPatterns?: string[];  // Regex patterns to strip from stdout
}

export type AgentType = 'claude-code' | 'openai-codex' | 'google-gemini';

export const AGENT_REGISTRY: Record<AgentType, AgentDefinition> = {
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Anthropic\'s AI coding agent',
    icon: 'claude',
    acpCommand: 'claude',
    acpArgs: ['--acp'],
    supportsAcp: true,
    devcontainerFeature: 'ghcr.io/anthropics/devcontainer-features/claude-code:1.0',
    envVarName: 'ANTHROPIC_API_KEY',
    credentialLabel: 'Anthropic API Key',
    credentialHelpUrl: 'https://console.anthropic.com/settings/keys',
    initTimeoutMs: 30000,
  },
  'openai-codex': {
    id: 'openai-codex',
    name: 'Codex',
    description: 'OpenAI\'s coding agent',
    icon: 'openai',
    acpCommand: 'codex',
    acpArgs: ['--acp'],
    supportsAcp: true,
    installCommand: 'npm install -g @openai/codex',
    envVarName: 'OPENAI_API_KEY',
    credentialLabel: 'OpenAI API Key',
    credentialHelpUrl: 'https://platform.openai.com/api-keys',
    initTimeoutMs: 30000,
  },
  'google-gemini': {
    id: 'google-gemini',
    name: 'Gemini CLI',
    description: 'Google\'s AI coding agent',
    icon: 'gemini',
    acpCommand: 'gemini',
    acpArgs: ['--experimental-acp'],
    supportsAcp: true,
    installCommand: 'npm install -g @google/gemini-cli',
    envVarName: 'GEMINI_API_KEY',
    credentialLabel: 'Gemini API Key',
    credentialHelpUrl: 'https://aistudio.google.com/apikey',
    initTimeoutMs: 120000,  // Gemini needs longer init
    stdoutFilterPatterns: ['^(?!\\{)'],  // Filter non-JSON debug output
  },
};
```

#### 4. Cloud-Init & Devcontainer Changes

The cloud-init template needs to:
1. Accept `agent_type` as a template variable
2. Install only the selected agent's CLI in the devcontainer
3. Pass the agent's API key as a container environment variable
4. Configure the VM Agent with the agent type and ACP command

```yaml
# Cloud-init additions (template variables)
# {{ agent_type }}     - 'claude-code', 'openai-codex', 'google-gemini'
# {{ agent_command }}  - 'claude', 'codex', 'gemini'
# {{ agent_args }}     - '--acp', '--experimental-acp'
# {{ agent_api_key }}  - User's encrypted API key (decrypted at boot)

# VM Agent systemd environment additions:
Environment=AGENT_TYPE={{ agent_type }}
Environment=AGENT_COMMAND={{ agent_command }}
Environment=AGENT_ARGS={{ agent_args }}
```

#### 5. Credential Flow

```
User saves API key          API encrypts & stores       Workspace created
in Settings UI        →     in D1 (per-user)      →    with agent_type
                                                              │
                                                              ▼
                                                    Cloud-init fetches
                                                    encrypted key via
                                                    bootstrap token
                                                              │
                                                              ▼
                                                    VM Agent decrypts
                                                    and injects into
                                                    devcontainer env
                                                              │
                                                              ▼
                                                    Agent process reads
                                                    ANTHROPIC_API_KEY /
                                                    OPENAI_API_KEY / etc.
```

---

## Data Model Changes

### Workspaces Table

```sql
-- Add agent_type column
ALTER TABLE workspaces ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'claude-code';
-- CHECK constraint: agent_type IN ('claude-code', 'openai-codex', 'google-gemini')
```

### Credentials Table

```sql
-- Extend to support agent API keys alongside cloud provider tokens
ALTER TABLE credentials ADD COLUMN credential_type TEXT NOT NULL DEFAULT 'cloud-provider';
-- Values: 'cloud-provider', 'agent-api-key'

ALTER TABLE credentials ADD COLUMN agent_type TEXT;
-- NULL for cloud-provider credentials
-- 'claude-code', 'openai-codex', 'google-gemini' for agent keys
```

### API Changes

**New/Modified Endpoints:**

| Method | Path | Change |
|--------|------|--------|
| `POST /api/workspaces` | Add `agentType` to request body | New field |
| `GET /api/workspaces/:id` | Include `agentType` in response | New field |
| `PUT /api/credentials/agent` | Save agent API key | New endpoint |
| `GET /api/credentials/agent` | List agent API keys (masked) | New endpoint |
| `DELETE /api/credentials/agent/:agentType` | Remove agent API key | New endpoint |
| `GET /api/agents` | List supported agents with metadata | New endpoint |

**WebSocket Endpoints (VM Agent):**

| Path | Protocol | Purpose |
|------|----------|---------|
| `/terminal/ws` | Binary (PTY) | Existing raw terminal access |
| `/agent/ws` | Text (ACP JSON-RPC) | New structured agent communication |

---

## ACP Message Flow (Detailed)

### Session Initialization

```
Browser                    VM Agent                Agent Process
  │                          │                        │
  │── WS connect ───────────►│                        │
  │   /agent/ws?token=JWT    │                        │
  │                          │── docker exec ────────►│
  │                          │   claude --acp         │
  │                          │   (pipes stdio)        │
  │                          │                        │
  │── initialize ──────────►│── (NDJSON) ──────────►│
  │   {protocolVersion: 1,   │                        │
  │    capabilities: {...}}  │                        │
  │                          │◄── InitializeResult ───│
  │◄── InitializeResult ────│   {capabilities,       │
  │                          │    authMethods}        │
  │                          │                        │
  │── session/new ─────────►│── (NDJSON) ──────────►│
  │   {cwd: "/workspace"}   │                        │
  │                          │◄── NewSessionResult ───│
  │◄── NewSessionResult ────│   {sessionId, modes}   │
```

### Prompt Turn with Tool Call

```
Browser                    VM Agent                Agent Process
  │                          │                        │
  │── session/prompt ──────►│── (NDJSON) ──────────►│
  │   {prompt: "fix the     │                        │
  │    bug in main.ts"}     │                        │
  │                          │                        │
  │                          │◄── session/update ─────│
  │◄── session/update ──────│   (agent_thought_chunk) │
  │   "Let me look at..."   │                        │
  │                          │                        │
  │                          │◄── session/update ─────│
  │◄── session/update ──────│   (tool_call:          │
  │   📁 Read main.ts       │    kind: "read")       │
  │                          │                        │
  │                          │◄── session/update ─────│
  │◄── session/update ──────│   (tool_call_update:   │
  │   📁 Read main.ts ✓     │    status: completed)  │
  │                          │                        │
  │                          │◄── session/update ─────│
  │◄── session/update ──────│   (tool_call:          │
  │   ✏️ Edit main.ts       │    kind: "edit")       │
  │                          │                        │
  │                          │◄── request_permission ─│
  │◄── request_permission ──│   "Allow edit of       │
  │   [Approve] [Reject]    │    main.ts?"           │
  │                          │                        │
  │── permission_response ─►│── (NDJSON) ──────────►│
  │   {approved: true}      │                        │
  │                          │                        │
  │                          │◄── session/update ─────│
  │◄── session/update ──────│   (tool_call_update:   │
  │   ✏️ Edit main.ts ✓     │    status: completed,  │
  │   [diff view]           │    diff: {...})        │
  │                          │                        │
  │                          │◄── session/update ─────│
  │◄── session/update ──────│   (agent_message_chunk)│
  │   "I fixed the bug..."  │                        │
  │                          │                        │
  │                          │◄── PromptResponse ─────│
  │◄── PromptResponse ──────│   {stopReason:         │
  │                          │    "end_turn"}         │
```

---

## Implementation Phases

### Phase 1: ACP Gateway in VM Agent
**Goal**: VM Agent can spawn an ACP agent process and bridge its stdio to a WebSocket.

- Add `internal/acp/` package to VM Agent
- Implement `Gateway` struct with agent process lifecycle
- Implement WebSocket endpoint at `/agent/ws`
- Implement NDJSON ↔ WebSocket message bridging
- Add `TransportHandler` interface for agent-specific quirks
- Add `AGENT_TYPE`, `AGENT_COMMAND`, `AGENT_ARGS` env vars to config
- Implement `docker exec` spawning for devcontainer processes
- Integration test: spawn Claude with `--acp`, send `initialize`, get response

### Phase 2: ACP Web Client
**Goal**: Browser can display a structured agent conversation.

- Create `packages/acp-client` package
- Implement WebSocket ↔ ACP Stream adapter
- Build `AcpProvider` context with connection management
- Build `useAcpSession` hook (initialize, prompt, cancel)
- Build core UI components (AgentPanel, MessageBubble, ToolCallCard)
- Build PermissionDialog component
- Build ThinkingBlock component
- Build FileDiffView component
- Build TerminalBlock component (for `terminal/create` tool calls)
- Integration test: full prompt → response → tool call → permission cycle

### Phase 3: Multi-Agent Configuration
**Goal**: Users can select agents and manage API keys.

- Add `agent_type` column to workspaces table + migration
- Add agent credential storage (extend credentials table)
- Build agent selection UI in Create Workspace form
- Build agent API key management in Settings page
- Update cloud-init template to accept agent_type
- Update devcontainer setup to install only selected agent
- Update credential flow to inject agent API key into devcontainer env
- Add `GET /api/agents` endpoint returning registry

### Phase 4: PTY Fallback & Polish
**Goal**: Robust fallback and production readiness.

- Add view toggle (ACP ↔ Terminal) to workspace page
- Auto-fallback to PTY when ACP connection fails
- Session persistence across reconnects
- Token usage display
- Agent mode selector
- Error recovery for agent crashes (auto-restart with backoff)
- Idle detection integration (ACP activity counts as user activity)

---

## Dependencies & Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| ACP protocol breaking changes (pre-1.0) | UI components break | Pin SDK version, abstract behind our own types |
| Agent doesn't start in ACP mode | Workspace unusable | Auto-fallback to PTY terminal |
| Agent-specific ACP quirks | Unreliable behavior | TransportHandler abstraction per agent |
| WebSocket transport not in ACP spec | Non-standard transport | Implement as thin bridge (WS frames = NDJSON lines) |
| Agent API key security | Key exposure | Same encryption as Hetzner tokens (AES-GCM, per-user) |
| Docker exec stdio latency | Sluggish UI | Benchmark; consider direct container networking if needed |

---

## Out of Scope (for initial version)

- **Multi-agent orchestration**: Running multiple agents cooperating on the same task
- **Agent marketplace**: Third-party agents beyond the initial three
- **Session history persistence**: Saving and resuming ACP sessions across workspace restarts
- **Voice interaction**: Audio content blocks in ACP
- **Agent-to-agent communication**: A2A protocol support
- **Custom agent configurations**: Per-workspace agent settings files (`.claude/settings.json` etc.)

---

## Technologies

- **Protocol**: Agent Client Protocol (ACP) v1, JSON-RPC 2.0 over NDJSON
- **SDK**: `@agentclientprotocol/sdk` (TypeScript, for types and protocol constants)
- **VM Agent**: Go 1.22+ (new `internal/acp/` package)
- **Web Client**: React + TypeScript (new `packages/acp-client/` package)
- **Transport**: WebSocket (browser ↔ VM Agent) + stdio NDJSON (VM Agent ↔ agent process)
