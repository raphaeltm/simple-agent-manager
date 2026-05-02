# Open-Source Coding Agent Harness Survey

**Date:** 2026-05-02

## Executive Summary

The coding agent harness landscape exploded in 2025-2026. There are now 15+ viable open-source projects. The key insight from architectural analysis is that **"the real product isn't the AI -- it's the harness."** All agents make essentially identical API calls; differentiation emerges through orchestration, permission systems, context management, and prompt engineering.

For SAM's needs (AGPL-compatible, embeddable, Go or TypeScript, multi-model), the top candidates are:

1. **Mastra** (TypeScript, Apache 2.0) -- SAM already uses it, Harness abstraction is purpose-built for agent runtimes, 40+ model providers
2. **Cline** (TypeScript, Apache 2.0) -- 61k stars, headless CLI mode, decoupled core, 30+ providers
3. **Crush** (Go, Charm team) -- strongest Go option, modular, multi-model, clean architecture
4. **Pi** (TypeScript, MIT) -- most embeddable, SDK/RPC mode, minimal and opinionated
5. **Goose** (Rust, Apache 2.0) -- 43.7k stars, HTTP server API, modular crate architecture

---

## Master Comparison Table

| Project | License | AGPL-OK | Language | Stars | Embeddable | Multi-Model | Maintenance | SAM Fit |
|---------|---------|---------|----------|-------|-----------|-------------|-------------|---------|
| **Mastra** | Apache 2.0 | Yes | TypeScript | 23.5k | Yes (framework) | Yes (40+) | Very active | HIGH |
| **Cline** | Apache 2.0 | Yes | TypeScript | 61.3k | Yes (headless CLI) | Yes (30+) | Very active | HIGH |
| **Crush** | OSS (Charm) | Yes | Go | 23.8k | Needs work | Yes (7+) | Active | HIGH |
| **Pi** | MIT | Yes | TypeScript | 43.7k | Yes (SDK/RPC) | Yes | Very active | HIGH |
| **Goose** | Apache 2.0 | Yes | Rust + TS | 43.7k | Yes (crate/HTTP) | Yes (15+) | Very active | MEDIUM |
| **OpenHands** | MIT | Yes | Python + TS | 72.5k | Yes (SDK) | Yes | Very active | MEDIUM |
| **Plandex** | MIT | Yes | Go | 15.3k | Limited | Yes | Slowing | MEDIUM |
| **Aider** | Apache 2.0 | Yes | Python | 44.2k | Limited | Yes (best) | Very active | LOW |
| **SWE-agent** | MIT | Yes | Python | 19.1k | Limited | Yes | Moderate | LOW |
| **Devon** | AGPL-3.0 | Yes (same) | Python | 3.4k | Limited | Yes | Low | LOW |
| **Claude Code** | Proprietary | No | TypeScript | 120k | Limited | No (Claude only) | Very active | NONE |
| **Cursor SDK** | Proprietary | No | TypeScript | N/A | Yes (paid) | Yes | Active | NONE |
| **Windsurf** | Proprietary | No | Unknown | N/A | No | Yes | Active | NONE |
| **bolt.diy** | MIT* | Partial | TypeScript | 19.3k | No | Yes (20+) | Active | NONE |

*bolt.diy: MIT source but requires WebContainers API licensing for production commercial use.

---

## Tier 1: Strong Candidates for SAM

### 1. Mastra (mastra-ai/mastra)
- **Language:** TypeScript (99.4%)
- **License:** Apache 2.0 (core); enterprise `ee/` directory has separate source-available license
- **Stars:** 23.5k | **npm:** 300k+ weekly downloads
- **Status:** Very active (1.0 released Jan 2026, from ex-Gatsby founders, YC-backed)
- **Architecture:**
  - Full AI agent framework with modular packages
  - **Harness abstraction** -- reusable runtime surface with mode management (plan/build/review), thread/message persistence, event system, state management with Zod schemas, heartbeat monitoring
  - Agents with tool-loop reasoning
  - Graph-based workflow orchestration (`.then()`, `.branch()`, `.parallel()`)
  - Memory systems (conversation history, working memory, semantic recall)
  - RAG, evals, observability
  - MCP server support
  - 40+ model providers via Vercel AI SDK
- **Embeddability:** Excellent -- this IS a framework/library, not an application. Agents can be bundled into React, Next.js, or Node.js apps. The Harness is explicitly designed to be extractable.
- **Multi-Model:** Yes -- 40+ providers through Vercel AI SDK (OpenAI, Anthropic, Gemini, etc.)
- **Strengths:**
  - SAM already uses Mastra -- minimal integration friction
  - The Harness abstraction is exactly what SAM needs for agent runtimes
  - `mastracode` package proves coding agent viability on the Harness
  - Apache 2.0 license
  - TypeScript ecosystem alignment with SAM's Worker/web stack
- **Weaknesses:**
  - General-purpose AI framework, not coding-agent specific
  - No built-in file editing, bash execution, or coding tools (must layer on)
  - Enterprise features require separate license
- **SAM Fit:** HIGH -- already integrated, Harness is purpose-built, needs coding tools layered on top

### 2. Cline (cline/cline)
- **Language:** TypeScript (primary), with Go and JavaScript
- **License:** Apache 2.0
- **Stars:** 61.3k | **Installs:** 5M+
- **Status:** Very active (v3.81, May 2, 2026)
- **Architecture:**
  - Decoupled architecture separating agentic core from host environment (VS Code, CLI, standalone)
  - Provider-based abstraction layer
  - Centralized Controller manages task lifecycle
  - MCP integration for tool extensibility
  - Plan/Act modes
  - 30+ LLM providers
- **Embeddability:** Yes, emerging. CLI supports both interactive and **headless mode** (`cline "task"` for CI/CD, cron, scripts). Core logic is shared across VS Code extension and CLI targets.
- **Multi-Model:** Excellent -- 30+ providers (Anthropic, OpenAI, Gemini, Bedrock, Azure, OpenRouter, Cerebras, DeepSeek, etc.)
- **Strengths:**
  - TypeScript (matches SAM stack)
  - Headless CLI mode proves it can run without VS Code
  - Massive community (61k stars)
  - Mature tool system, MCP support
  - Decoupled core architecture suggests clean extraction
- **Weaknesses:**
  - Originally VS Code-centric -- CLI/headless mode is newer, less battle-tested
  - Core extraction may still carry VS Code assumptions
  - Enterprise features have separate licensing
- **SAM Fit:** HIGH -- strongest TypeScript candidate for extracting a headless coding agent runtime

### 3. Crush (charmbracelet/crush)
- **Language:** Go
- **License:** Open source (Charm ecosystem, likely MIT)
- **Stars:** 23.8k
- **Status:** Active (successor to OpenCode, backed by Charm team)
- **Architecture:**
  - Go-based CLI with BubbleTea TUI
  - Modular tool system (view, ls, grep, edit, bash)
  - LSP integration for code intelligence
  - SQLite-backed session persistence
  - MCP server support for extensibility
  - Permission-based tool access with `allowed_tools` config, `--yolo` mode
- **Multi-Model:** Full support -- Anthropic, OpenAI, Groq, OpenRouter, Google Gemini, Azure OpenAI, AWS Bedrock
- **Embeddability:** Currently CLI-focused, but Go architecture is inherently importable as packages
- **Strengths:**
  - Written in Go (aligns with SAM VM agent)
  - Charm ecosystem (BubbleTea, Lip Gloss) is production-grade
  - ~30k lines of Go -- relatively compact
  - Clean architecture, multi-model from day one
- **Weaknesses:**
  - No documented SDK/embedding mode
  - TUI-focused, would need headless mode for container deployment
  - Younger project (OpenCode archived Sep 2025)
- **SAM Fit:** HIGH -- Go language, multi-model, clean architecture, could extract core agent loop

### 4. Pi (badlogic/pi-mono)
- **Language:** TypeScript
- **License:** MIT
- **Stars:** 43.7k
- **Status:** Very active
- **Architecture:**
  - Monorepo with 5 packages: `pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `pi-web-ui`
  - 4 built-in tools: read, write, edit, bash
  - 4 run modes: interactive, print/JSON, RPC (process integration), SDK (embedding)
  - Skills and prompt templates for customization
- **Multi-Model:** Yes -- unified API across OpenAI, Anthropic, Google
- **Embeddability:** EXCELLENT -- explicit SDK mode and RPC mode for process integration
- **Strengths:**
  - Most embeddable option -- designed for integration from day one
  - SDK mode for programmatic import, RPC mode for subprocess control
  - Minimal and opinionated -- 4 tools, clean abstraction
  - MIT license
  - Excellent separation of concerns (AI, agent-core, UI are separate packages)
- **Weaknesses:**
  - TypeScript (not Go)
  - Less mature tool ecosystem than Claude Code
  - Single maintainer (Mario Zechner)
- **SAM Fit:** HIGH -- most embeddable, cleanest architecture for integration

### 5. Goose (block/goose)
- **Language:** Rust (48.8%) + TypeScript (45.4% for Electron desktop UI)
- **License:** Apache 2.0
- **Stars:** 43.7k | **Forks:** 4.5k | **Contributors:** ~350
- **Status:** Very active (v1.33.1, April 29, 2026, 4,343 commits)
- **Architecture:**
  - Cargo workspace with modular crates: `goose` (core), `goose-mcp`, `goose-cli`, `goose-server` (HTTP API), `goose-acp` (Agent Client Protocol)
  - Agent loop: plans actions -> selects tools via MCP extensions -> executes -> evaluates -> loops
  - 70+ extensions via MCP standard
- **Embeddability:** Yes -- `goose` core crate is a Rust library, `goose-server` provides HTTP API for programmatic integration
- **Multi-Model:** Excellent -- 15+ providers (Anthropic, OpenAI, Google, Ollama, OpenRouter, Azure, Bedrock, etc.)
- **Strengths:**
  - Apache 2.0, Rust performance, extremely modular
  - `goose-server` HTTP API enables sidecar integration
  - MCP-native extensibility (70+ extensions)
  - Massive, active community
- **Weaknesses:**
  - Rust is not SAM's stack (Go/TypeScript). FFI bridging adds complexity.
  - The HTTP server approach works but adds a network hop
- **SAM Fit:** MEDIUM -- excellent project but Rust language barrier. HTTP server could work as sidecar.

---

## Tier 2: Worth Understanding

### 6. OpenHands (All-Hands-AI/OpenHands)
- **Language:** Python (62.2%) + TypeScript (35.9%)
- **License:** MIT (core + agent-server Docker images)
- **Stars:** 72.5k | $18.8M Series A
- **Architecture:** **Event-stream architecture** -- Agent -> Actions -> Environment -> Observations -> Agent. The `software-agent-sdk` is a separate, composable Python library with event-sourced state model, deterministic replay, typed tool system with MCP integration, workspace abstraction (local or remote sandboxed containers).
- **Embeddability:** Best-in-class -- `software-agent-sdk` at `github.com/OpenHands/software-agent-sdk` is the gold standard for an extracted agent runtime.
- **SAM Fit:** MEDIUM -- Python is the blocker. But the event-sourced architecture and extracted SDK are the best reference implementation for what SAM should build.

### 7. Plandex (plandex-ai/plandex)
- **Language:** Go (93.4%)
- **License:** MIT
- **Stars:** 15.3k
- **Architecture:** Client-server model in Go, cumulative diff review sandbox, tree-sitter project maps (handles 20M+ token codebases), 2M token context per file.
- **Embeddability:** Limited -- designed as terminal REPL + server, not a library. Go packages could theoretically be imported.
- **SAM Fit:** MEDIUM -- Go is great but development has slowed (last release mid-2025) and it wasn't designed for embedding.

### 8. Aider (Aider-AI/aider)
- **Language:** Python (80%)
- **License:** Apache 2.0
- **Stars:** 44.2k | 13,133 commits
- **Architecture:** Stdin/stdout CLI, "Architect + Editor" dual-model pattern, tree-sitter repo map, automatic git commits, watch mode.
- **Multi-Model:** Best-in-class -- works with virtually every provider, maintains LLM leaderboard.
- **SAM Fit:** LOW -- Python, CLI-focused. But Aider's multi-model testing methodology, LLM leaderboard, and repo map (tree-sitter) are worth studying.

### 9. SWE-agent (Princeton)
- **Language:** Python (94.8%)
- **License:** MIT
- **Stars:** 19.1k
- **Architecture:** "Agent-Computer Interface" (ACI) -- custom LM-centric commands optimized for LLM interaction. YAML-configured workflows.
- **SAM Fit:** LOW -- research-oriented, Python. But the ACI concept (optimizing the tool interface for LLM performance) is worth studying.

---

## Tier 3: Not Applicable

| Project | License | Why Not |
|---------|---------|---------|
| **Claude Code** | Proprietary | "All rights reserved" -- NOT open source despite GitHub visibility. Anthropic-locked. |
| **Cursor SDK** | Proprietary (paid) | TypeScript SDK, production-proven, but commercial per-token pricing. |
| **Windsurf** | Proprietary | Completely closed. Acquired by Cognition (Devin) for ~$250M. |
| **Amp** | Proprietary | Sourcegraph enterprise-only, no public SDK. |
| **Codex CLI** | Proprietary | OpenAI-locked |
| **bolt.diy** | MIT* | MIT source but WebContainers dependency requires separate licensing. Browser-based, wrong architecture. |
| **Devon** | AGPL-3.0 | Directly compatible license, but too early-stage (3.4k stars, low maintenance). |
| **Roo Code** | Open source | Shutting down May 15, 2026. |

---

## Architecture Comparison Matrix (Top 5)

| Feature | Mastra (TS) | Cline (TS) | Crush (Go) | Pi (TS) | Goose (Rust) |
|---------|-------------|-----------|-----------|---------|-------------|
| License | Apache 2.0 | Apache 2.0 | OSS (Charm) | MIT | Apache 2.0 |
| Stars | 23.5k | 61.3k | 23.8k | 43.7k | 43.7k |
| Codebase Size | Large (framework) | Large | ~30k lines | Moderate | Large |
| Embeddable | YES (library) | YES (headless CLI) | Needs work | YES (SDK/RPC) | YES (HTTP server) |
| Multi-Model | 40+ (Vercel AI SDK) | 30+ providers | 7+ providers | Unified API | 15+ providers |
| Tool System | Build your own | Built-in + MCP | Built-in + MCP | 4 core + extensions | 70+ MCP extensions |
| Coding-Specific | No (general) | Yes | Yes | Yes | Yes (via extensions) |
| Headless/API | Yes (library) | Yes (CLI headless) | Needs work | Yes (RPC, SDK, JSON) | Yes (goose-server) |
| MCP Support | Yes | Yes | Yes | Yes | Yes (native) |
| Sandbox/Security | N/A | Plan/Act modes | Permission-based | Channel-based | Extension-scoped |
| Session Persistence | Configurable | VS Code state | SQLite | SQLite | Extension-managed |

## Key Insight

The critical differentiator for SAM is **embeddability**. Most coding agents are designed as standalone CLIs. SAM needs a harness that can be:
1. **Embedded in Go** for the VM agent (Crush, Plandex)
2. **Run headlessly** in a Cloudflare Container / Sandbox (Mastra, Cline, Pi)
3. **Controlled programmatically** via API/SDK (Mastra Harness, Pi SDK, Goose HTTP server)

The top recommendation for SAM is a **hybrid approach**:
- **Mastra Harness** (TypeScript) for project-level and top-level agents running in CF Containers via Sandbox SDK
- **Go harness** (inspired by Crush architecture) for VM workspace agents
- Both share the same tool definitions, prompt templates, and MCP integration patterns
