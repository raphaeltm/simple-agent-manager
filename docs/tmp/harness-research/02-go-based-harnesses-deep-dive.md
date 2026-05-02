# Go-Based Agent Harnesses Deep Dive

**Date:** 2026-05-02

## Why Go?

SAM's VM agent (`packages/vm-agent/`) is already written in Go. A Go-based harness would:
- Share the same runtime and build toolchain
- Compile to a single static binary (easy to distribute via R2)
- Have excellent concurrency primitives for parallel tool execution
- Integrate naturally with the existing VM agent codebase
- Produce small, fast-starting container images for CF Containers

## Candidate 1: Crush (charmbracelet/crush)

### Overview
Crush is the successor to OpenCode, developed by the Charm team (famous for BubbleTea, Lip Gloss, and other Go TUI libraries). It's the most polished Go coding agent available.

### Architecture Deep Dive

**Core Loop:**
```
User Input → LLM API Call → Tool Execution → Result → LLM API Call → ...
```

The agent uses Go channels for a clean blocking-approval pattern:
- When the agent needs permission, it creates a channel
- Publishes the request to the TUI
- Blocks until the user responds

**Tool System:**
- Built-in tools: `view`, `ls`, `grep`, `edit`, `bash`
- Permission system: `allowed_tools` config + `--yolo` mode
- MCP server support for extensibility
- Tools can be disabled via `disabled_tools`

**LLM Integration:**
- Supports OpenAI-compatible and Anthropic-compatible APIs
- Can switch LLMs mid-session while preserving context
- Provider configuration via environment variables

**LSP Integration:**
- Built-in Language Server Protocol support
- Provides code intelligence (diagnostics, completions, references)
- Configured per-language in settings

**Session Management:**
- SQLite-backed persistent sessions
- Auto-generated session titles
- Session history and recall

### What SAM Would Need to Extract

To use Crush as SAM's harness, we'd need to:

1. **Extract the core agent loop** — the while-loop that calls LLM → executes tools → feeds back results
2. **Extract the tool system** — the tool registry, permission checking, and execution engine
3. **Replace the TUI** — swap BubbleTea UI for a headless/API-driven interface
4. **Add SAM-specific tools** — MCP integration, task dispatch, knowledge graph queries
5. **Add CF AI Gateway routing** — replace direct provider calls with Gateway-proxied calls
6. **Add context management** — the prompt construction and context window management

### Integration Approach

**Option A: Fork and Modify**
- Fork charmbracelet/crush into `packages/harness/` (or similar)
- Strip the TUI, keep the core
- Add headless mode
- Maintain as a SAM-specific fork

**Option B: Import as Library**
- If Crush exposes its core as importable Go packages (needs investigation)
- Import `crush/agent`, `crush/tools`, etc.
- Build SAM's harness as a wrapper

**Option C: Clean-Room Inspired Rewrite**
- Study Crush's architecture
- Write a SAM-specific harness in Go from scratch
- Use same patterns but optimized for SAM's needs
- No license concerns, full control

### Assessment
- **Pros:** Go, well-architected, Charm team quality, multi-model
- **Cons:** No documented embedding API, TUI-coupled, would need significant adaptation
- **Effort:** Medium-High for fork, High for rewrite

---

## Candidate 2: Plandex (plandex-ai/plandex)

### Overview
Plandex is a Go-based (93.4%) coding agent designed for large projects. It uses a client-server architecture with a sophisticated diff sandbox system.

### Architecture Deep Dive

**Client-Server Model:**
- CLI client sends commands to a server
- Server manages state, LLM calls, and file operations
- Server can be self-hosted via Docker
- Local mode also available

**Diff Sandbox (Unique Feature):**
- AI-generated changes are kept in a sandbox
- Changes don't touch project files until explicitly applied
- Syntax validation and logic checks before application
- Multiple fallback layers for error handling
- This is conceptually similar to SAM's existing workspace isolation

**Context Management:**
- Up to 2M token context per file
- Tree-sitter project maps for larger codebases (20M+ tokens)
- Intelligent context selection

**Multi-Model:**
- Model packs: curated sets for different cost/capability tradeoffs
- Claude Pro/Max subscription support
- OpenRouter integration for model flexibility

### What SAM Would Extract

1. **The server component** — the stateful agent server that manages LLM calls and tool execution
2. **The diff sandbox** — could be valuable for SAM's review workflow
3. **The context management** — tree-sitter indexing and context window management
4. **Model pack system** — interesting pattern for SAM's multi-model needs

### Assessment
- **Pros:** Go, large codebase support, sophisticated diff system, model packs
- **Cons:** Cloud service winding down, complex architecture, opinionated workflow
- **Effort:** High — extracting from client-server architecture is complex

---

## Candidate 3: Google ADK for Go (google/adk-go)

### Overview
Google's Agent Development Kit for Go — an official Google framework for building AI agents in Go.

### Key Features
- Code-first Go toolkit
- Strong typing and concurrency
- Agent2Agent (A2A) protocol support for multi-agent systems
- Google ecosystem integration

### Assessment
- **Pros:** Google-backed, Go-native, A2A protocol for multi-agent
- **Cons:** Likely Google-ecosystem focused (Gemini), may not have coding-specific tools
- **Effort:** Would need significant coding-agent tools built on top
- **SAM Fit:** LOW-MEDIUM — framework, not a coding agent

---

## Candidate 4: Custom Go Harness (Clean-Room)

### Overview
Build a purpose-built SAM harness in Go, inspired by the best patterns from the field.

### Architecture Design (Proposed)

```
packages/harness/
├── agent/           # Core agent loop
│   ├── loop.go      # The main think→act→observe cycle
│   ├── context.go   # Context window management
│   └── session.go   # Session state and persistence
├── llm/             # LLM provider abstraction
│   ├── provider.go  # Provider interface
│   ├── anthropic.go # Anthropic client
│   ├── openai.go    # OpenAI client
│   └── gateway.go   # CF AI Gateway routing
├── tools/           # Tool system
│   ├── registry.go  # Tool registration and dispatch
│   ├── file.go      # File read/write/edit
│   ├── bash.go      # Command execution
│   ├── grep.go      # Code search
│   ├── git.go       # Git operations
│   └── mcp.go       # MCP tool bridge
├── prompt/          # Prompt construction
│   ├── system.go    # System prompt builder
│   ├── context.go   # Context assembly
│   └── templates.go # Prompt templates
└── sandbox/         # Execution safety
    ├── permission.go # Permission system
    └── limits.go     # Resource limits
```

### Patterns to Borrow

From **Crush/OpenCode:**
- Go channel-based permission system
- BubbleTea-decoupled architecture (headless-capable)
- SQLite session persistence
- LSP integration approach

From **Pi:**
- Minimal 4-tool design (read, write, edit, bash)
- SDK/RPC embedding modes
- Unified LLM API abstraction

From **Claude Code:**
- Streaming tool executor (begin execution while model still streaming)
- Four-layer context compaction
- Composable system prompt sections
- Cache boundary optimization

From **Plandex:**
- Diff sandbox (changes separate from files until approved)
- Tree-sitter project maps for large codebases
- Model pack concept for cost/capability tradeoffs

From **SWE-agent:**
- Agent-Computer Interface (ACI) — optimize the tool interface for LLM performance
- Tool output formatting that's easy for LLMs to parse

### Assessment
- **Pros:** Full control, optimized for SAM, no license concerns, Go-native
- **Cons:** Significant development effort, starting from scratch
- **Effort:** HIGH but with the highest long-term payoff

---

## Recommendation

**Primary approach: Fork Crush + Custom Extensions**

1. Study Crush's internals — understand the agent loop, tool system, LLM abstraction
2. Fork into SAM monorepo as `packages/harness/`
3. Strip TUI dependencies, add headless API mode
4. Add SAM-specific features:
   - CF AI Gateway integration
   - MCP bridge for SAM tools
   - Task dispatch integration
   - Knowledge graph integration
   - Optimized prompts for SAM workflows
5. Add container-friendly packaging (small binary, fast startup)

**Fallback: Clean-room Go harness inspired by Crush + Pi + Claude Code patterns**

If Crush's internals are too TUI-coupled to cleanly extract, build from scratch using the architecture patterns documented above. This is more work upfront but gives complete control.

**TypeScript alternative: Layer coding tools on Mastra + Pi patterns**

If Go proves impractical for the container runtime, enhance the existing Mastra integration with coding-specific tools inspired by Pi's minimal design (read, write, edit, bash).
