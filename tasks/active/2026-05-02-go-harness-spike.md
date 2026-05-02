# Go Harness Architecture Spike

**Created:** 2026-05-02
**Parent Idea:** 01KQM8JT6CPHGS16Y91XJF67FS (SAM-Native Coding Agent Harness)
**Prior Research:** Session 6efb961c-874f-4d6a-8e39-9398a5bf6beb

## Problem Statement

SAM currently relies on 5 external proprietary agent binaries (Claude Code, Codex, Gemini, Mistral Vibe, OpenCode) with zero control over internals. This spike builds the smallest useful `packages/harness/` Go prototype that proves the core agent-loop and tool architecture can work inside SAM.

## Research Findings

### Key Architectural Patterns (from library research)
- **Crush/Pi pattern**: think->act->observe loop with tool registry
- **Pi's minimal tools**: read, write, edit, bash — 4 tools cover 90% of coding work
- **OpenHands event-sourced architecture**: action->observation pairs with deterministic replay
- **SWE-agent ACI**: optimize tool interface for LLM comprehension
- **Plandex context mgmt**: tree-sitter repo maps for large codebases

### Existing SAM Architecture (from codebase)
- VM agent Go module at `packages/vm-agent/` uses Go 1.25, coder/acp-go-sdk, creack/pty
- Agent session lifecycle: SessionHost state machine (idle->starting->ready->prompting->stopped)
- Credential resolution: 3-tier (project->user->platform)
- MCP tools exposed via HTTP Bearer auth
- Agent profiles: built-in profiles (default, planner, implementer, reviewer) with per-project overrides

### Design Decisions
- **Clean-room Go harness** (Option C from research) — no vendored code, patterns only
- **Deterministic mock model** for tests — no network dependency
- **Isolated from existing agents** — no changes to claude-code/codex/gemini/mistral/opencode paths
- **Transcript/event log** for observability — every LLM call and tool execution recorded

## Implementation Checklist

### 1. Module Setup
- [x] Create `packages/harness/` with `go.mod` (module `github.com/workspace/harness`)
- [x] Directory structure: `cmd/harness/`, `agent/`, `llm/`, `tools/`, `transcript/`

### 2. Core Interfaces
- [x] `llm.Provider` interface (SendMessage with messages+tools, returns response with tool calls)
- [x] `llm.Message` / `llm.ToolCall` / `llm.ToolResult` types
- [x] `llm.ToolDefinition` schema type (JSON Schema for tool parameters)
- [x] `llm.MockProvider` — deterministic scripted responses for testing

### 3. Tool System
- [x] `tools.Registry` — register tools by name, dispatch by name
- [x] `tools.Tool` interface — Name(), Description(), Schema(), Execute(ctx, params) (result, error)
- [x] `tools.ReadFile` — read file contents with line numbers
- [x] `tools.WriteFile` — create/overwrite files with safe directory handling
- [x] `tools.EditFile` — search-and-replace with unique match validation
- [x] `tools.Bash` — command execution with configurable timeout, cancellation, working directory sandboxing

### 4. Agent Loop
- [x] `agent.Run` — think->act->observe cycle with max iterations
- [x] Context: system prompt + user message + conversation history
- [x] Tool dispatch from LLM response
- [x] Stop conditions: no more tool calls, max iterations, context cancelled

### 5. Transcript / Event Log
- [x] `transcript.Log` — append-only event log (LLM requests, LLM responses, tool calls, tool results)
- [x] `transcript.Event` types (LLMRequest, LLMResponse, ToolCall, ToolResult, Error)
- [x] JSON serialization for persistence
- [x] In-memory implementation for testing

### 6. CLI Prototype
- [x] `cmd/harness/main.go` — parse flags, create provider + tools + loop, run
- [x] `--dir` flag for working directory
- [x] `--prompt` flag for initial task
- [x] `--max-turns` flag
- [x] `--transcript` flag for output file
- [x] `--system` flag for system prompt

### 7. Tests
- [x] Tool dispatch: register tools, dispatch by name, verify results
- [x] Bash timeout: command exceeds timeout, verify cancellation
- [x] Bash cancellation: cancel context mid-execution, verify cleanup
- [x] Edit safety: non-unique match returns error, unique match succeeds
- [x] Transcript persistence: events written and readable
- [x] Scripted agent run: mock model returns tool calls, agent executes them, verifies final state

### 8. Evaluation Fixtures
- [x] Task 1: Read-only repo analysis — read files, summarize structure (no writes)
- [x] Task 2: Simple file edit + verification — create file, edit it, verify with bash
- [x] Task 3: Failing command recovery — run bad command, detect error, retry with fix

### 9. Documentation
- [x] `packages/harness/README.md` — architecture, usage, inspiration credits
- [x] Document what was borrowed from Crush/Pi/OpenHands (patterns only, no code)
- [x] Next steps: integration risks for VM mode, container mode

## Acceptance Criteria
- [x] `packages/harness` builds with `go build ./...`
- [x] `go test ./...` passes in `packages/harness`
- [x] Evaluation fixtures produce expected results with mock model
- [x] No changes to existing agent types (claude-code, codex, gemini, mistral, opencode)
- [x] CLI can run against a temp fixture repo with mock model
- [ ] PR description includes command outputs and evaluation results

## References
- Research docs: `/research/agent-harness/01-08`
- VM agent: `packages/vm-agent/`
- ACP session host: `packages/vm-agent/internal/acp/session_host.go`
