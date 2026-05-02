# Recommendation and Action Plan

**Date:** 2026-05-02

## Top-Line Recommendation

**Build a Go-based coding agent harness (`packages/harness/`), inspired by Crush and Pi's architecture, deployed in three modes:**

1. **VM mode** — compiled into the VM agent binary for workspace coding work
2. **Container mode** — packaged as a lightweight Docker image for CF Containers (project/SAM agents)
3. **CLI mode** — standalone binary for local development and testing

## Why This Approach

### Why build our own instead of adopting an existing harness?

1. **No existing harness fits all three deployment contexts** (VM, Container, DO)
2. **SAM needs deep integration** with its own tools (knowledge, dispatch, policies, ideas) — wrapping an external agent always creates a seam
3. **Multi-model is non-negotiable** — Claude Code is Anthropic-only, Codex is OpenAI-only
4. **Control is the product** — SAM's value is in orchestrating and customizing agent behavior. A black-box harness undermines this
5. **The patterns are well-documented** — Crush, Pi, Claude Code, and SWE-agent have established clear architectural patterns. Building on these patterns is engineering, not research

### Why Go?

1. SAM's VM agent is already Go — shared codebase, shared expertise
2. Single static binary — easy to distribute via R2, fast to start in containers
3. Excellent concurrency — parallel tool execution, streaming, timeouts
4. Small container images — Alpine + Go binary = < 50MB
5. The best Go harnesses (Crush, Plandex) prove the approach works

### Why not just improve Mastra?

Mastra is a great framework for general AI agents, but:
1. No built-in coding tools (file edit, bash, git, grep)
2. TypeScript runtime adds overhead in containers (Node.js dependency)
3. Not designed for the think→act→observe loop that coding agents need
4. Would need so much coding-agent tooling on top that it becomes a harness anyway

**Mastra remains the right choice for the DO-based SAM agent** (the lightweight orchestrator that runs in Workers). But for agents that need file system access and coding capabilities, a Go harness is superior.

## Architecture

### `packages/harness/` — The Go Harness

```
packages/harness/
├── go.mod
├── go.sum
├── cmd/
���   └── harness/           # CLI/container entrypoint
│       └── main.go
├── agent/                 # Core agent loop
│   ├── loop.go            # think→act→observe cycle
│   ├── context.go         # Context window management
│   ├── compaction.go      # Context compaction strategies
│   └── session.go         # Session state and persistence
├── llm/                   # LLM provider abstraction
│   ├── provider.go        # Provider interface
│   ├── anthropic.go       # Anthropic format adapter
│   ├── openai.go          # OpenAI format adapter
│   ├── gateway.go         # CF AI Gateway router
│   └── streaming.go       # SSE/streaming handler
├── tools/                 # Tool system
│   ├── registry.go        # Tool registration and dispatch
│   ├── definition.go      # Tool definition schema
│   ├── file_read.go       # Read file contents
│   ├── file_write.go      # Write/create files
│   ├── file_edit.go       # Search-and-replace editing
│   ├── bash.go            # Command execution with timeout
│   ├── grep.go            # Content search (ripgrep-like)
│   ├── glob.go            # File pattern matching
│   ├── git.go             # Git operations
│   ├── mcp.go             # MCP tool bridge (for SAM tools)
│   └── permission.go      # Permission checking
├── prompt/                # Prompt construction
│   ├── system.go          # System prompt builder
│   ├── templates.go       # Model-specific prompt templates
│   └── context.go         # Context assembly (repo map, recent files)
├── index/                 # Code intelligence
│   ├── treesitter.go      # Tree-sitter based code indexing
│   └── repomap.go         # Repository structure map
└── server/                # HTTP API for container mode
    ├── handler.go         # Request handlers
    └── streaming.go       # SSE streaming responses
```

### Three Deployment Modes

#### Mode 1: VM Integration
```
packages/vm-agent/
└── internal/
    └── harness/           # Integration layer
        └── runner.go      # Starts harness as agent session
```
The VM agent imports `packages/harness/agent` and runs it as an agent session, similar to how it currently runs Claude Code. The harness gets the workspace's file system, tools, and environment.

#### Mode 2: Container
```dockerfile
# Minimal container for CF Containers
FROM alpine:3.20
RUN apk add --no-cache git openssh-client
COPY harness /usr/local/bin/harness
ENTRYPOINT ["harness", "serve", "--port", "8080"]
```
The container runs `harness serve` which exposes an HTTP API. The SAM Worker/DO communicates via HTTP to send prompts and receive streaming responses.

#### Mode 3: CLI
```bash
# Local development and testing
harness chat --model claude-4.6-sonnet --dir /path/to/project
```

## Implementation Phases

### Phase 1: Core Harness (2-3 weeks)
**Goal:** Minimal viable agent that can edit files and run commands

- [ ] Core agent loop (think→act→observe)
- [ ] LLM provider abstraction (Anthropic + OpenAI)
- [ ] CF AI Gateway integration
- [ ] 4 core tools: read, write, edit, bash
- [ ] Basic context management
- [ ] CLI mode working
- [ ] Unit tests

### Phase 2: VM Integration (1-2 weeks)
**Goal:** Replace Claude Code as default workspace agent option

- [ ] VM agent integration layer
- [ ] Agent session management (start, stop, stream output)
- [ ] ACP protocol support for session lifecycle
- [ ] git, grep, glob tools
- [ ] Permission system
- [ ] Streaming output to web UI

### Phase 3: Container Mode (1-2 weeks)
**Goal:** Run harness in CF Containers for project/SAM agents

- [ ] HTTP server mode (`harness serve`)
- [ ] Container image build
- [ ] CF Container DO integration
- [ ] Repo cloning on startup
- [ ] SamSession DO → Container communication
- [ ] Scale-to-zero configuration

### Phase 4: SAM Tool Integration (1-2 weeks)
**Goal:** Bridge SAM's MCP tools into the harness

- [ ] MCP client in Go (or HTTP bridge)
- [ ] Knowledge graph tools (add, search, get)
- [ ] Task dispatch tools
- [ ] Policy tools
- [ ] Idea tools
- [ ] Handoff tools

### Phase 5: Multi-Model + Optimization (1-2 weeks)
**Goal:** Support all target models with optimized prompts

- [ ] Model-specific prompt templates
- [ ] Tool calling format adapters (Anthropic, OpenAI, XML fallback)
- [ ] Model selection in agent profiles
- [ ] Context compaction strategies
- [ ] Cache boundary optimization
- [ ] Tree-sitter code indexing
- [ ] Repo map generation

### Phase 6: Polish + Migration (1-2 weeks)
**Goal:** Production-ready, replace existing agent infrastructure

- [ ] Agent observability (structured logging, metrics)
- [ ] Performance benchmarking
- [ ] Error handling and recovery
- [ ] Documentation
- [ ] Migration guide from Claude Code/Codex
- [ ] Agent profile configuration UI

## Model Selection Architecture

### For Workspace Agents (user-configurable)
```
Agent Profile → model selection → harness configuration
  ├── Model: claude-4.6-sonnet (default)
  ├── Model: gpt-4o
  ├── Model: llama-3.3-70b
  └── ...
```
Users choose from a tested shortlist. The harness adapts prompts and tool formats.

### For Top-Level SAM Agent (fixed, optimized)
- Model: Claude 4.6 Sonnet (or Opus for premium)
- Heavily optimized system prompt for SAM orchestration
- No user choice — we optimize until it's excellent

### For Project-Level Agent (fixed, optimized)
- Model: Claude 4.6 Sonnet
- Optimized for code analysis and task planning
- Could use Haiku for quick classification/routing

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Development time | Phase 1 is minimal — 4 tools + agent loop. Ship incrementally |
| Multi-model quality variance | Test each model against a benchmark suite. Only ship models that pass |
| CF Container cold starts too slow | Pre-warm containers for active projects. Use warm pool like nodes |
| Go harness less capable than Claude Code | Focus on SAM-specific capabilities first. Coding quality improves with prompt engineering |
| Maintenance burden | Clean architecture from day one. Automated tests for each tool |

## Success Metrics

1. **Harness can complete SWE-bench tasks** comparable to Aider/Claude Code
2. **Container cold start < 3s** with minimal image
3. **6+ models working** through CF AI Gateway
4. **SAM MCP tools integrated** — agent can dispatch tasks, search knowledge, etc.
5. **VM agent supports harness** as an agent type alongside Claude Code/Codex
6. **Users can select model** in agent profile settings
