# Research: Multi-Agent Support via ACP

**Feature Branch**: `006-multi-agent-support`
**Created**: 2026-02-05
**Status**: Research / Pre-Spec

## Problem Statement

SAM currently supports only Claude Code as its coding agent. Users who prefer OpenAI Codex, Google Gemini CLI, or other coding agents cannot use the platform. To broaden SAM's appeal and avoid vendor lock-in, we need a multi-agent architecture that lets users choose which AI coding agent runs in their workspace — while keeping a single, unified web UI.

## Prior Art: Happy Coder CLI

Happy Coder (`happy-coder`, MIT License, by slopus) solves a related problem — wrapping multiple coding agents behind a single mobile/web interface. It currently supports Claude Code, OpenAI Codex, and Google Gemini CLI using **three different integration strategies**:

### Happy Coder's Agent Integration Approaches

| Agent | Integration Strategy | Protocol | How It Works |
|-------|---------------------|----------|--------------|
| **Claude Code** | Direct process spawn + file scanning | Custom (inherited stdio + JSONL log parsing) | Spawns `claude` as child process. In "local mode" stdio is inherited (user types directly). In "remote mode" uses `--print` / `--input-format stream-json` for programmatic control. Captures output by watching Claude's JSONL session log files on disk. |
| **OpenAI Codex** | MCP client | Model Context Protocol (stdio transport) | Communicates with Codex via `CodexMcpClient` using MCP's JSON-RPC over stdio. Maps permission modes to Codex-specific sandbox/approval policies. |
| **Google Gemini** | ACP backend | Agent Client Protocol (JSON-RPC/NDJSON over stdio) | Spawns `gemini --experimental-acp` which speaks ACP natively. Uses `@agentclientprotocol/sdk`'s `ClientSideConnection` for structured bidirectional communication. |

### Happy Coder's Abstraction Layers

Happy Coder uses a clean three-layer abstraction to normalize all agents:

**Layer 1 — AgentBackend Interface** (universal contract):
```typescript
interface AgentBackend {
    startSession(initialPrompt?: string): Promise<StartSessionResult>;
    sendPrompt(sessionId, prompt): Promise<void>;
    cancel(sessionId): Promise<void>;
    onMessage(handler: AgentMessageHandler): void;
    respondToPermission?(requestId, approved): Promise<void>;
    dispose(): Promise<void>;
}
```

**Layer 2 — TransportHandler** (agent-specific quirks):
Handles stdout filtering, stderr parsing, tool name resolution, timeout tuning per agent.

**Layer 3 — MessageAdapter** (normalization for the UI):
Transforms internal `AgentMessage` into a common `MobileAgentMessage` format.

### Happy Coder's Limitations for SAM

- **Mobile-first relay architecture** — designed for encrypted bridge to phone, not web workspace management
- **No orchestration** — sessions are independent; doesn't coordinate multiple agents
- **Local-only** — agents run on the user's desktop, not in cloud VMs/devcontainers
- **Terminal wrapping** — Claude integration relies on inherited stdio and file system watching, which works for a local CLI but doesn't map cleanly to a remote VM architecture

---

## Agent Client Protocol (ACP) Deep Dive

ACP is the most promising standardization effort for our use case. Created by **Zed Industries** with **Google**, it's designed to be "LSP for AI coding agents."

### Protocol Overview

- **Transport**: JSON-RPC 2.0 over NDJSON (newline-delimited JSON) via stdio
- **Version**: Protocol version `1` (stable core, pre-1.0 SDK at 0.14.x)
- **License**: Apache 2.0

### Key Protocol Methods

**Client → Agent:**
| Method | Purpose |
|--------|---------|
| `initialize` | Negotiate protocol version + capabilities |
| `authenticate` | Auth flow (if agent requires it) |
| `session/new` | Create conversation session |
| `session/load` | Resume previous session |
| `session/prompt` | Send user message |
| `session/cancel` | Cancel ongoing turn |
| `session/set_mode` | Switch mode (ask/architect/code) |

**Agent → Client (notifications):**
| Update Type | Purpose |
|-------------|---------|
| `agent_message_chunk` | Streaming text response |
| `agent_thought_chunk` | Internal reasoning (extended thinking) |
| `tool_call` | Tool execution started |
| `tool_call_update` | Tool execution progress/result |
| `usage_update` | Token usage |
| `plan` | Agent's execution plan |

**Agent → Client (requests):**
| Method | Purpose |
|--------|---------|
| `session/request_permission` | Ask user to approve tool execution |
| `fs/read_text_file` | Read file from client's filesystem |
| `fs/write_text_file` | Write file to client's filesystem |
| `terminal/create` | Execute command in terminal |
| `terminal/output` | Get terminal output |

### ACP Adoption (as of 2026-02)

**Agents with ACP support:**
- Claude Code (via ACP adapter)
- Gemini CLI (native, `--experimental-acp`)
- Codex CLI (via ACP adapter)
- GitHub Copilot
- Augment Code (Auggie CLI)
- Mistral Vibe
- OpenCode
- Qwen Code
- 30+ community agents

**Editors with ACP client support:**
- Zed (native)
- JetBrains IDEs
- Neovim (via plugins)
- Emacs

### ACP Maturity Assessment

**Stable**: initialization, sessions, prompts, tool calls, permissions, file system access, terminal management, slash commands, modes, config options, extensions.

**Unstable/Experimental**: session forking, session listing, session resuming, model selection, token usage tracking, request cancellation.

**Missing for our use case**: Remote agent transport (HTTP/WebSocket) is explicitly listed as work-in-progress. The current spec assumes local subprocess stdio. We need to bridge this gap.

---

## SAM's Current Architecture (Relevant to Multi-Agent)

### How Claude Code Currently Runs in SAM

```
Browser → Cloudflare → VM (Caddy reverse proxy)
                          ├── VM Agent (Go, port 8080)
                          │   ├── WebSocket terminal handler
                          │   ├── PTY session manager
                          │   ├── JWT auth + session cookies
                          │   └── Idle detection + heartbeat
                          │
                          ├── CloudCLI UI (port 3001) [optional]
                          │
                          └── Devcontainer (Docker)
                              ├── User's repo at /workspace
                              └── Claude Code CLI (installed via devcontainer feature)
```

Key observations:
1. **VM Agent is agent-agnostic** — it provides PTY access to a shell. It doesn't know about Claude Code.
2. **Claude Code is installed in the devcontainer** via a devcontainer feature, not by the VM Agent.
3. **The terminal component** (`packages/terminal`) renders raw PTY output via xterm.js + WebSocket. It has no understanding of agent-specific structured output.
4. **The web UI** (`apps/web`) shows a generic terminal view. No agent-aware UI elements (tool call cards, permission dialogs, thinking indicators, etc.).

### What We Gain from ACP

If we move from "raw PTY terminal" to "ACP-aware UI", we can render:
- **Structured agent responses** with markdown formatting
- **Tool call cards** showing what the agent is doing (reading files, editing, running commands)
- **Permission dialogs** allowing users to approve/reject tool executions
- **Thinking indicators** showing the agent's reasoning process
- **File diffs** inline when the agent edits code
- **Token usage** tracking per session
- **Agent mode switching** (ask/architect/code)

This is a dramatically better UX than a raw terminal.

---

## Architecture Options

### Option A: ACP-Native (Recommended)

Run ACP as the primary protocol between the web UI and coding agents. The VM Agent becomes an ACP gateway.

```
┌────────────────────────────────────────────────┐
│  Browser (SAM Web UI)                          │
│  ┌──────────────────────────────────────────┐  │
│  │  ACP Web Client                          │  │
│  │  (React components for structured agent  │  │
│  │   output, tool calls, permissions, etc.) │  │
│  └──────────────┬───────────────────────────┘  │
└─────────────────┼──────────────────────────────┘
                  │ WebSocket (ACP-over-WS)
                  │
┌─────────────────┼──────────────────────────────┐
│  VM (Host)      │                              │
│  ┌──────────────┴───────────────────────────┐  │
│  │  VM Agent (Go)                           │  │
│  │  ┌────────────────────────────────────┐  │  │
│  │  │  ACP WebSocket Gateway             │  │  │
│  │  │  - Accepts WS from browser         │  │  │
│  │  │  - Translates WS ↔ stdio NDJSON    │  │  │
│  │  │  - Manages agent child process     │  │  │
│  │  └────────────┬───────────────────────┘  │  │
│  │               │ stdio (NDJSON)           │  │
│  │  ┌────────────┴───────────────────────┐  │  │
│  │  │  Agent Process (in devcontainer)   │  │  │
│  │  │  - claude --acp                    │  │  │
│  │  │  - gemini --experimental-acp       │  │  │
│  │  │  - codex --acp                     │  │  │
│  │  └────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────┘  │
└────────────────────────────────────────────────┘
```

**Pros:**
- Clean, standardized protocol end-to-end
- Rich structured UI for all agents
- As ACP matures, all agents automatically improve
- Permission model built into protocol
- File diffs, tool calls, thinking all come for free

**Cons:**
- Requires building ACP WebSocket transport (not yet in spec)
- Agents that don't fully support ACP need adapter work
- More complex VM Agent changes (Go ACP gateway)
- ACP is still pre-1.0; breaking changes possible

### Option B: PTY + Structured Sideband

Keep the current PTY/terminal approach but add a structured sideband channel for agent metadata.

```
┌────────────────────────────────────────────────┐
│  Browser                                       │
│  ┌─────────────────┐  ┌────────────────────┐  │
│  │  xterm.js        │  │  Agent Panel       │  │
│  │  (raw terminal)  │  │  (tool calls,      │  │
│  │                  │  │   permissions,     │  │
│  │                  │  │   thinking, etc.)  │  │
│  └────────┬─────────┘  └────────┬───────────┘  │
└───────────┼─────────────────────┼──────────────┘
            │ WS (terminal)       │ WS (sideband)
            │                     │
┌───────────┼─────────────────────┼──────────────┐
│  VM Agent │                     │              │
│  ┌────────┴──────┐  ┌──────────┴───────────┐  │
│  │ PTY Manager   │  │ Agent Monitor        │  │
│  │ (existing)    │  │ (watches logs,       │  │
│  │               │  │  parses output,      │  │
│  │               │  │  emits structured    │  │
│  │               │  │  events)             │  │
│  └───────────────┘  └──────────────────────┘  │
└────────────────────────────────────────────────┘
```

**Pros:**
- Simpler to implement incrementally
- PTY terminal always works as fallback
- Doesn't depend on ACP maturity
- Can parse Claude's JSONL logs (like Happy Coder)

**Cons:**
- Agent-specific log parsing is fragile and breaks with updates
- Two parallel channels (PTY + sideband) add complexity
- Permission model must be custom-built per agent
- Each new agent requires new parsing code

### Option C: Hybrid (Recommended Starting Point)

Start with ACP as the primary protocol, but keep PTY as a fallback for agents that don't speak ACP or when ACP breaks.

```
┌────────────────────────────────────────────────────────┐
│  Browser (SAM Web UI)                                  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Workspace View                                  │  │
│  │  ┌────────────────────┐ ┌─────────────────────┐  │  │
│  │  │  ACP Agent Panel   │ │  Fallback Terminal  │  │  │
│  │  │  (structured UI    │ │  (xterm.js PTY,     │  │  │
│  │  │   when ACP works)  │ │   always available) │  │  │
│  │  └────────┬───────────┘ └──────────┬──────────┘  │  │
│  └───────────┼────────────────────────┼─────────────┘  │
└──────────────┼────────────────────────┼────────────────┘
               │ WS (ACP)              │ WS (PTY)
               │                       │
┌──────────────┼───────────────────────┼─────────────────┐
│  VM Agent    │                       │                 │
│  ┌───────────┴────────────┐  ┌───────┴──────────────┐  │
│  │  ACP Gateway           │  │  PTY Manager         │  │
│  │  - WS ↔ stdio bridge   │  │  (existing, unchanged│  │
│  │  - Agent lifecycle     │  │   from current impl) │  │
│  │  - Transport handler   │  │                      │  │
│  │    per agent           │  │                      │  │
│  └───────────┬────────────┘  └──────────────────────┘  │
│              │ stdio (NDJSON)                           │
│  ┌───────────┴────────────────────────────────────┐    │
│  │  Devcontainer                                  │    │
│  │  ┌──────────────┐                              │    │
│  │  │ Agent Process │  claude --acp               │    │
│  │  │              │  gemini --experimental-acp   │    │
│  │  │              │  codex --acp                 │    │
│  │  └──────────────┘                              │    │
│  └────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────┘
```

**Pros:**
- ACP provides the rich UI when available
- PTY fallback ensures nothing breaks
- Incremental migration path
- Users can toggle between views

**Cons:**
- Two code paths to maintain (but PTY path already exists)
- Slightly more complex VM Agent

---

## Key Technical Challenges

### 1. ACP over WebSocket (Not Yet Standardized)

ACP currently specifies stdio (NDJSON) as its transport. We need a WebSocket bridge. Two options:

**a) VM Agent bridges WS ↔ stdio** (recommended):
The Go VM Agent accepts WebSocket connections from the browser, spawns the agent process with piped stdio, and forwards NDJSON messages bidirectionally. This keeps the agent process unchanged.

**b) Direct WS transport in agent**:
Wait for ACP to standardize WebSocket transport. This is listed as work-in-progress and may land before we ship.

### 2. Agent Process Lifecycle in Devcontainers

Agents run inside the devcontainer (Docker), but the VM Agent runs on the host. We need to spawn and manage agent processes across this boundary:

```bash
# From VM Agent (host), execute in devcontainer:
docker exec -it <container-id> claude --acp
```

Or use `devcontainer exec`:
```bash
devcontainer exec --workspace-folder /workspace -- claude --acp
```

This is how the current architecture would work — the VM Agent needs to spawn the agent process inside the devcontainer and pipe its stdio.

### 3. Agent Installation

Each agent needs to be available inside the devcontainer. Options:

**a) Devcontainer features** (current approach for Claude):
```json
{
  "features": {
    "ghcr.io/anthropics/devcontainer-features/claude-code:1.0": {},
    "ghcr.io/google/devcontainer-features/gemini-cli:1.0": {},
    "ghcr.io/openai/devcontainer-features/codex:1.0": {}
  }
}
```

**b) Cloud-init post-install** (install after devcontainer up):
```bash
devcontainer exec -- npm install -g @anthropic-ai/claude-code
devcontainer exec -- npm install -g @openai/codex
devcontainer exec -- npm install -g @google/gemini-cli
```

**c) Only install the selected agent** (based on workspace config):
Install only the agent the user chose when creating the workspace.

Option (c) is most efficient — no point installing agents the user won't use.

### 4. Agent Authentication / API Keys

Each agent needs its own API key:
- Claude Code → `ANTHROPIC_API_KEY`
- Codex → `OPENAI_API_KEY`
- Gemini CLI → Google auth (OAuth or `GEMINI_API_KEY`)

These are user-provided credentials that should be:
1. Stored encrypted per-user in the database (like Hetzner tokens currently)
2. Injected into the devcontainer environment at startup
3. Never exposed to the VM Agent or control plane

### 5. Permission Model Differences

ACP standardizes the permission flow, but agents have different permission semantics:

| Agent | Permission Model |
|-------|-----------------|
| Claude Code | Tool-level approval (read/edit/execute), auto-approve rules |
| Codex | Sandbox levels (workspace-write, full-access) + approval policies |
| Gemini | Tool-level approval via ACP `request_permission` |

ACP normalizes this to: `request_permission` → user chooses from `allow_once`, `reject_once`, etc. But the agent's behavior after approval may differ.

### 6. Fallback Terminal for Non-ACP Agents

Some agents may never support ACP, or users may want raw terminal access. The existing PTY/xterm.js infrastructure should remain available as a fallback — either as the primary view or as a secondary panel.

---

## Data Model Implications

### Workspace Table Changes

```sql
ALTER TABLE workspaces ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'claude-code';
-- Values: 'claude-code', 'openai-codex', 'google-gemini', etc.

ALTER TABLE workspaces ADD COLUMN agent_mode TEXT DEFAULT 'acp';
-- Values: 'acp' (structured UI), 'pty' (raw terminal)
```

### Credentials Table Changes

Currently stores Hetzner tokens. Needs to support agent API keys:

```sql
-- Existing: provider credentials (Hetzner)
-- New: agent credentials
ALTER TABLE credentials ADD COLUMN credential_type TEXT NOT NULL DEFAULT 'cloud-provider';
-- Values: 'cloud-provider', 'agent-api-key'

ALTER TABLE credentials ADD COLUMN agent_type TEXT;
-- Values: 'claude-code', 'openai-codex', 'google-gemini'
-- NULL for cloud-provider credentials
```

### Agent Registry (Configuration)

```typescript
interface AgentDefinition {
  id: string;                    // 'claude-code'
  name: string;                  // 'Claude Code'
  acpCommand: string;            // 'claude'
  acpArgs: string[];             // ['--acp']
  devcontainerFeature?: string;  // 'ghcr.io/anthropics/devcontainer-features/claude-code:1.0'
  installCommand?: string;       // 'npm install -g @anthropic-ai/claude-code'
  envVarName: string;            // 'ANTHROPIC_API_KEY'
  supportsAcp: boolean;          // true
  transportQuirks?: {            // Agent-specific ACP behavior
    initTimeout: number;         // Gemini needs 120s vs 30s default
    stdoutFilter?: RegExp;       // Filter non-JSON output
  };
}
```

---

## Scope for Spec

Based on this research, the spec should cover:

### Phase 1: ACP Gateway in VM Agent
- Add ACP WebSocket endpoint to VM Agent (alongside existing PTY endpoint)
- Implement stdio ↔ WebSocket bridge for ACP NDJSON
- Agent process lifecycle management (spawn inside devcontainer, monitor, restart)
- Transport handler abstraction for agent-specific quirks

### Phase 2: ACP Web Client Components
- React components for rendering ACP session updates
- Structured message display (markdown, code blocks)
- Tool call cards with status indicators
- Permission request dialogs
- Thinking/reasoning display
- File diff viewer
- Token usage display

### Phase 3: Multi-Agent Workspace Configuration
- Agent selection in workspace creation flow
- Agent API key management in Settings
- Per-agent devcontainer feature installation
- Cloud-init template updates for agent-specific setup

### Phase 4: Fallback & Resilience
- PTY fallback when ACP fails or agent doesn't support it
- Toggle between ACP view and raw terminal
- Graceful degradation for unstable ACP features

---

## Open Questions

1. **Should we support running multiple agents in the same workspace?** (e.g., Claude + Codex side by side) — Probably not for MVP, but the architecture shouldn't prevent it.

2. **Should ACP be the only interface, or always paired with PTY?** — Recommend always keeping PTY available. ACP is pre-1.0 and agents may have bugs.

3. **How do we handle agent updates?** — Agents are installed in the devcontainer. Users can rebuild to get updates, or we can auto-update on workspace restart.

4. **Should we contribute to ACP's WebSocket transport spec?** — If we build a clean WS transport, contributing it upstream would benefit the ecosystem and ensure our implementation stays compatible.

5. **Do we need agent-specific UI beyond what ACP provides?** — ACP is generic by design. Some agents have unique features (Claude's artifacts, Gemini's grounding) that ACP may not surface.

---

## References

- [Agent Client Protocol (ACP)](https://agentclientprotocol.com) — Official website
- [ACP GitHub](https://github.com/agentclientprotocol/agent-client-protocol) — Spec + SDKs
- [@agentclientprotocol/sdk](https://www.npmjs.com/package/@agentclientprotocol/sdk) — TypeScript SDK
- [Happy Coder CLI](https://github.com/slopus/happy-cli) — MIT-licensed multi-agent wrapper
- [Happy Coder Mobile App](https://github.com/slopus/happy) — MIT-licensed companion app
- [claude-squad](https://github.com/smtg-ai/claude-squad) — Multi-agent terminal manager
- [Zed ACP Integration](https://zed.dev/acp) — Reference ACP client implementation
