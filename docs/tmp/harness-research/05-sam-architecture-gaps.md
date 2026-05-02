# Current SAM Agent Architecture and Gap Analysis

**Date:** 2026-05-02

## Current Architecture Overview

### Supported Agent Harnesses (5 total)

SAM currently supports **five ACP-compatible agent harnesses**, all running as subprocesses inside Docker containers on VMs:

| Agent Type | Provider | Binary | Models | License | Install |
|-----------|----------|--------|--------|---------|---------|
| **claude-code** | Anthropic | `claude-agent-acp` | Claude 3/4 suite | Proprietary | npm |
| **openai-codex** | OpenAI | `codex-acp` | GPT-4/5 suite | Proprietary | npx |
| **google-gemini** | Google | `gemini --experimental-acp` | Gemini 2.0/2.5 | Proprietary | npm |
| **mistral-vibe** | Mistral | `vibe-acp` | Mistral Large/Codestral | Proprietary | UV toolchain |
| **opencode** | Scaleway | `opencode acp` | Scaleway Inference | Open source | npm |

**Key observation:** All five are **external proprietary binaries** (even OpenCode depends on Scaleway). SAM has zero control over their internals.

### Agent Bootstrap Flow (End-to-End)

```
Control Plane (CF Worker)         VM Agent (Go)              Container (Docker)
─────────────────────────         ────────────────           ──────────────────
TaskRunner DO:
  1. Create agent session (D1)
  2. Generate MCP token (KV)
  3. Create ACP session (DO)
  4. POST /workspaces/{id}/       → SelectAgent(agentType)
     agent-sessions/{id}/start      → Fetch credentials
                                    → Install/validate binary
                                    → Spawn via creack/pty    → ACP process starts
                                    → ACP SDK handshake       → Agent reads env/auth
                                    → Send initial prompt     → Agent begins work
                                                              → Connects to MCP
                                                              → Streams tokens back
```

### Credential Resolution (3-tier)

```
Project-scoped credential (if exists, active)
  ↓ fallback
User-scoped credential (if exists, active)
  ↓ fallback
Platform credential (Worker env vars)
```

Credentials encrypted with AES-GCM in D1. Two injection modes:
- **Environment variable** (default) — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.
- **Auth file** (Codex) — `~/.codex/auth.json` with centralized refresh via `CodexRefreshLock` DO

### Agent Profiles (Built-in)

| Profile | Agent Type | Model | Permission | Purpose |
|---------|-----------|-------|-----------|---------|
| default | claude-code | Claude Sonnet 4.5 | acceptEdits | General coding |
| planner | claude-code | Claude Opus 4.6 | plan | Task decomposition |
| implementer | claude-code | Claude Sonnet 4.5 | acceptEdits | Implementation + tests |
| reviewer | claude-code | Claude Opus 4.6 | plan | Code review |

Custom profiles override per-project. Resolution: explicit → profile → project default → platform default.

### 1. Top-Level SAM Agent (SamSession DO)

**Location:** `apps/api/src/durable-objects/sam-session/`

- Runs as a Cloudflare Durable Object
- Uses Mastra for AI orchestration
- Connects to Claude via CF AI Gateway
- Has MCP tools for SAM operations (dispatch_task, create_mission, search_knowledge, etc.)
- FTS5 search across conversation history
- GitHub API for code access (search_code, get_file_content)

### 2. Project-Level Orchestrator (ProjectOrchestrator DO)

**Location:** `apps/api/src/durable-objects/project-orchestrator/`

- Alarm-driven scheduling loop (30s default)
- Routes handoff packets between tasks
- Detects stalled tasks
- **Not an AI agent** — purely a rule-based state machine

### 3. VM Agent + Workspace Agents

**Location:** `packages/vm-agent/internal/acp/`

- Go-based VM agent manages workspace lifecycle
- SessionHost state machine: `HostIdle → HostStarting → HostReady → HostPrompting → HostStopped`
- Supports auto-suspend, multi-viewer, message buffer replay
- ACP SDK over JSON-RPC (stdin/stdout via PTY)

### 4. MCP Integration

Agents receive SAM MCP server access:
- **Endpoint:** `https://api.${BASE_DOMAIN}/mcp`
- **Auth:** Bearer token (task-scoped, stored in KV)
- **Tools:** list_projects, search_tasks, dispatch_task, create_mission, add_knowledge, search_code, get_file_content, etc.

---

## Gap Analysis

### Gap 1: No SAM-Native Coding Agent (CRITICAL)

**Current state:** All coding is done by 5 external black-box agents.

**Problems:**
- Zero control over tool usage, prompt engineering, or agent behavior
- Each agent has different installation/configuration requirements
- They don't deeply integrate with SAM's knowledge graph, ideas, or policies
- When Claude Code changes its ACP API or behavior, SAM breaks
- Users can't use arbitrary models within a given agent (Claude Code = Anthropic only)
- Agent binary installation via `npm install -g` has no version pinning or rollback
- Hardcoded ACP binary commands make adding new agents require code changes

**What's needed:** A SAM-native coding harness that:
- Is fully controlled by SAM
- Integrates natively with SAM's MCP tools
- Supports multiple LLM providers via CF AI Gateway
- Can be customized per agent profile
- Has version management and clean rollback

### Gap 2: Top-Level SAM Agent Has No File/Code Access (HIGH)

**Current state:** SamSession DO can only access code via GitHub API.

**Problems:**
- GitHub API is slow, rate-limited, and provides limited context
- Can't run git commands, analyze file trees, or understand project structure deeply
- Can't test, build, or verify code
- Severely limits the agent's decision-making quality

**What's needed:** Run SAM agent in a CF Container with repo cloning and CLI access.

### Gap 3: Project-Level Agent Is Not an Agent (HIGH)

**Current state:** ProjectOrchestrator is a rule-based state machine.

**Problems:**
- Can't make intelligent decisions about task decomposition
- Can't analyze code to plan work
- Handoff between tasks is mechanical, not intelligent

**What's needed:** An AI agent with code access for project-level orchestration.

### Gap 4: No Multi-Model Agent Support (HIGH)

**Current state:** Each external agent is locked to one provider.

**Problems:**
- Users can't choose the best model for their use case
- Cost optimization is impossible
- Open-weight models completely unavailable as coding agents
- SAM's AI Gateway infrastructure is underutilized

**What's needed:** A model-agnostic harness working with any model behind CF AI Gateway.

### Gap 5: No Integrated Tool Ecosystem (MEDIUM)

**Current state:** External agents bring their own tools. SAM MCP tools exist but are a separate layer.

**Problems:**
- Agent can't simultaneously use SAM tools AND coding tools natively
- No way to add custom tools per project
- MCP bridge adds latency and complexity

**What's needed:** Unified tool registry: core coding tools + SAM platform tools + project custom tools + MCP bridge.

### Gap 6: No Agent Observability/Control (MEDIUM)

**Current state:** External agents are black boxes — SAM sees stdout/stderr only.

**Problems:**
- Can't debug agent behavior or inspect reasoning
- Can't interrupt or redirect mid-execution
- Can't learn from performance to improve prompts

**What's needed:** Structured logging of every LLM call, tool execution, and decision. Real-time streaming of agent reasoning. Ability to interrupt and redirect.

### Gap 7: Credential Injection Asymmetry (LOW)

**Current state:** Two code paths — env var injection vs file-based injection.

**Problem:** Rotation logic only works for file-based (Codex). No unified credential lifecycle.

### Gap 8: Inference Config Duplication (LOW)

**Current state:** Anthropic proxy configuration scattered across `agent-loop.ts`, `session_host.go`, credential resolution.

**Problem:** Adding a new inference mode requires changes in multiple files.

---

## Architecture Pain Points (from code analysis)

1. **Agent Type Coupling** — Hardcoded ACP binary commands require code changes for new agents
2. **No Agent Version Management** — `npm install -g` with no version pinning or rollback
3. **MCP Token Scoping** — Task-scoped tokens are one-time bootstrap; no refresh if revoked mid-task
4. **Model/Provider Override Complexity** — Permission mode, model, provider passed separately; no unified config struct
5. **ACP SDK Lifecycle** — Tightly coupled to PTY + subprocess; no abstraction for alternative transports
6. **Credential Fallback Chain** — Resolved at startup only; no dynamic re-resolution

---

## Summary: What SAM Needs

| Need | Priority | Solution |
|------|----------|----------|
| SAM-native coding harness | P0 | Build Go harness (`packages/harness/`) |
| Multi-model support | P0 | Provider abstraction + CF AI Gateway |
| Container runtime for SAM/project agents | P1 | Cloudflare Containers |
| Unified tool registry | P1 | Tool registry in harness (coding + SAM + custom) |
| Agent observability | P2 | Structured logging + streaming |
| Customizable agent profiles → harness config | P2 | Profile mapping to harness configuration |
| Project-level AI agent | P2 | Upgrade ProjectOrchestrator with harness |
| Top-level SAM agent with code access | P2 | Move SamSession to Container |
| Unified credential injection | P3 | Single injection mode in harness |
| Inference config consolidation | P3 | Single config struct in harness |
