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
- [ ] Create `packages/harness/` with `go.mod` (module `github.com/workspace/harness`)
- [ ] Directory structure: `cmd/harness/`, `agent/`, `llm/`, `tools/`, `transcript/`
- [ ] Add `.gitignore` for Go build artifacts

### 2. Core Interfaces
- [ ] `llm.Provider` interface (SendMessage with messages+tools, returns response with tool calls)
- [ ] `llm.Message` / `llm.ToolCall` / `llm.ToolResult` types
- [ ] `llm.ToolDefinition` schema type (JSON Schema for tool parameters)
- [ ] `llm.MockProvider` — deterministic scripted responses for testing

### 3. Tool System
- [ ] `tools.Registry` — register tools by name, dispatch by name
- [ ] `tools.Tool` interface — Name(), Description(), Schema(), Execute(ctx, params) (result, error)
- [ ] `tools.ReadFile` — read file contents with line numbers
- [ ] `tools.WriteFile` — create/overwrite files with safe directory handling
- [ ] `tools.EditFile` — search-and-replace with unique match validation
- [ ] `tools.Bash` — command execution with configurable timeout, cancellation, working directory sandboxing

### 4. Agent Loop
- [ ] `agent.Loop` — think->act->observe cycle with max iterations
- [ ] Context: system prompt + user message + conversation history
- [ ] Tool dispatch from LLM response
- [ ] Stop conditions: no more tool calls, max iterations, context cancelled

### 5. Transcript / Event Log
- [ ] `transcript.Log` — append-only event log (LLM requests, LLM responses, tool calls, tool results)
- [ ] `transcript.Event` types (LLMRequest, LLMResponse, ToolCall, ToolResult, Error)
- [ ] JSON serialization for persistence
- [ ] In-memory implementation for testing

### 6. CLI Prototype
- [ ] `cmd/harness/main.go` — parse flags, create provider + tools + loop, run
- [ ] `--model` flag (default: mock)
- [ ] `--dir` flag for working directory
- [ ] `--prompt` flag for initial task
- [ ] `--max-turns` flag
- [ ] `--transcript` flag for output file

### 7. Tests
- [ ] Tool dispatch: register tools, dispatch by name, verify results
- [ ] Bash timeout: command exceeds timeout, verify cancellation
- [ ] Bash cancellation: cancel context mid-execution, verify cleanup
- [ ] Edit safety: non-unique match returns error, unique match succeeds
- [ ] Transcript persistence: events written and readable
- [ ] Scripted agent run: mock model returns tool calls, agent executes them, verifies final state

### 8. Evaluation Fixtures
- [ ] Task 1: Read-only repo analysis — read files, summarize structure (no writes)
- [ ] Task 2: Simple file edit + verification — create file, edit it, verify with bash
- [ ] Task 3: Failing command recovery — run bad command, detect error, retry with fix

### 9. Documentation
- [ ] `packages/harness/README.md` — architecture, usage, inspiration credits
- [ ] Document what was borrowed from Crush/Pi/OpenHands (patterns only, no code)
- [ ] Next steps: integration risks for VM mode, container mode

## Acceptance Criteria
- [ ] `packages/harness` builds with `go build ./...`
- [ ] `go test ./...` passes in `packages/harness`
- [ ] Evaluation fixtures produce expected results with mock model
- [ ] No changes to existing agent types (claude-code, codex, gemini, mistral, opencode)
- [ ] CLI can run against a temp fixture repo with mock model
- [ ] PR description includes command outputs and evaluation results

## References
- Research docs: `/research/agent-harness/01-08`
- VM agent: `packages/vm-agent/`
- ACP session host: `packages/vm-agent/internal/acp/session_host.go`
