# Harness Phase 2: SAM Platform Integration (MCP Client + Orchestration Mode)

## Context

Phase 1 (`2026-05-03-harness-phase1-capable-coding-agent.md`) produces a capable coding agent with grep, glob, git tools, tree-sitter repo maps, and context management. It runs against real models via SAM's AI proxy but has no awareness of SAM as a platform — it cannot read tasks, dispatch work, manage missions, or interact with project knowledge.

This task adds the MCP client and SAM-specific intelligence that transforms the harness from a standalone coding agent into a SAM-native platform agent. After this phase, the harness can:

1. Connect to SAM's MCP server and use platform tools (dispatch_task, search_knowledge, get_instructions, etc.)
2. Operate in an `--mode orchestrate` that curates tools and system prompt for orchestration work
3. Understand SAM's task lifecycle, session management, and cleanup obligations through a maintained system prompt
4. Be deployed in a Cloudflare Sandbox container as the runtime for SamSession/ProjectAgent delegation

See idea `01KQM8JT6CPHGS16Y91XJF67FS` "Revised Architecture and Phase Plan (2026-05-03)" for full context. This is Track D2.

## Acceptance Criteria

### MCP Client in Go

- [ ] `packages/harness/mcp/` package implements MCP client protocol (JSON-RPC over stdio or HTTP+SSE).
- [ ] Client connects to a remote MCP server URL with Bearer token auth (same contract as workspace agents: `SAM_MCP_URL` + `SAM_MCP_TOKEN`).
- [ ] Client discovers available tools via `tools/list` and converts them to the harness tool interface.
- [ ] Client executes tool calls via `tools/call` and returns results to the agent loop.
- [ ] MCP tools appear alongside built-in tools (read_file, grep, etc.) in the tool registry — the model sees one unified tool list.
- [ ] Connection errors, timeouts, and invalid responses are handled gracefully (logged, surfaced as tool errors to the model, do not crash the loop).
- [ ] Unit tests with a mock MCP server (in-process, no network) covering: connection, tool discovery, tool execution, error handling.

### Tool Adapter Layer

- [ ] `packages/harness/tools/mcp_adapter.go` wraps MCP tools into the harness `Tool` interface.
- [ ] Adapter translates between harness tool call format (name + JSON args → string result) and MCP protocol format.
- [ ] Adapter handles MCP tool schemas (JSON Schema input) and maps them to tool definitions the LLM understands.
- [ ] Tool descriptions from MCP are passed through to the model without modification (SAM's MCP server already has good descriptions).

### Tool Profiles (Context Management)

- [ ] `packages/harness/tools/profiles.go` defines named tool profiles that select which tools to expose to the model.
- [ ] At least 3 profiles:
  - `workspace` — coding tools (read, write, edit, bash, grep, glob, git_*) + subset of MCP tools relevant to workspace work (get_instructions, complete_task, update_task_status, add_knowledge, search_knowledge, request_human_input).
  - `orchestrate` — coding tools + orchestration MCP tools (dispatch_task, get_task_details, create_mission, get_mission, get_mission_state, publish_handoff, list_tasks, search_tasks, get_session_messages, send_message_to_subtask, stop_subtask, get_pending_messages, ack_message, list_policies).
  - `full` — all available tools (for testing/debugging).
- [ ] Profile selected via `--tool-profile` CLI flag (default: `workspace`).
- [ ] Each profile targets ~15-20 tools to keep context overhead manageable.
- [ ] Tool profile definitions are data (not code) — easy to add/modify without recompiling.
- [ ] Unit tests verify each profile resolves to the expected tool set.

### SAM Orchestration System Prompt

- [ ] `packages/harness/prompts/orchestrate.md` — a maintained, version-controlled system prompt for orchestration mode.
- [ ] System prompt encodes SAM platform knowledge:
  - Task lifecycle: pending → assigned → running → completed/failed. How to read task status vs. reading session messages for real progress.
  - Session management: conversation-mode tasks must be explicitly stopped. Don't leave child tasks running.
  - Cleanup obligations: when a mission is done, ensure all tasks are in terminal state.
  - Handoff packets: how to publish structured handoffs between tasks.
  - Mission state: how to use mission state entries for cross-task context.
  - Policy awareness: read and respect project policies.
  - Delegation patterns: when to dispatch a task vs. do the work directly.
  - Code understanding: use repo map + grep to understand code before delegating coding work.
- [ ] System prompt is loaded from the embedded file at startup (not hardcoded in Go).
- [ ] `packages/harness/prompts/workspace.md` — workspace mode system prompt (coding-focused, lighter on orchestration).
- [ ] System prompt selection based on `--mode` flag.

### Mode Selection

- [ ] `--mode workspace` (default) — coding tools + workspace MCP subset + workspace system prompt.
- [ ] `--mode orchestrate` — coding tools + orchestration MCP tools + orchestration system prompt.
- [ ] `--mode cli` — coding tools only, no MCP (for local use without SAM connection).
- [ ] Mode determines: tool profile, system prompt, and default behavior (e.g., orchestrate mode auto-connects to MCP).

### Callback API Integration

- [ ] When running in a Sandbox container, the harness reports progress back to SAM via HTTP callbacks (similar to workspace agent pattern).
- [ ] `--callback-url` flag specifies the SAM API endpoint to POST progress/results to.
- [ ] `--callback-token` flag provides auth for the callback.
- [ ] Callbacks sent at: loop start, each tool call completion, final result, error/timeout.
- [ ] Callback payload includes: turn number, tool calls made, token usage estimate, final message or error.
- [ ] Callback failures are logged but do not block the agent loop (fire-and-forget with retry).

### Evaluation

- [ ] At least 3 new evaluation scenarios beyond Phase 1's coding evaluations:
  1. Orchestration: harness reads a mission state, dispatches two tasks, monitors their progress, publishes a handoff.
  2. Code-aware delegation: harness analyzes a repo structure, decides which files need changes, dispatches appropriately scoped tasks.
  3. Mixed mode: harness answers a question about the codebase by reading code (grep + read_file) and enriching with SAM knowledge (search_knowledge).
- [ ] Evaluations use a mock MCP server that simulates SAM tool responses.
- [ ] At least one evaluation compared against current SamSession DO behavior on the same scenario (manual comparison, documented).

## Technical Notes

- The MCP client should use HTTP+SSE transport (not stdio) since the harness connects to a remote server. SAM's MCP endpoint is `https://api.${BASE_DOMAIN}/mcp` with Bearer token auth.
- Tool profiles are a critical context management mechanism. The full SAM MCP tool set is 40+ tools. Exposing all of them wastes context and confuses smaller models. Profiles curate the right subset per mode.
- The SAM orchestration system prompt is a living document. It should be easy for humans to read and update. Store it as markdown, not as Go string literals.
- The callback API pattern mirrors how workspace agents report back to the control plane. This is the mechanism that lets the DO stay responsive while the harness runs a long loop in a Sandbox.
- Static binary requirement still applies (CGO_ENABLED=0). The MCP client must use pure Go HTTP — no C dependencies.

## Out of Scope

- Sandbox deployment integration (that's Phase 3 / Track D3)
- DO-to-Sandbox delegation wiring (that's Phase 3)
- LSP integration (that's Phase 4)
- ACP protocol / VM agent integration (that's Phase 4)
- Multi-model prompt templates (that's Phase 5)

## Dependencies

- Phase 1 must be complete (coding tools, tree-sitter, context management).
- SAM MCP server must be accessible (already is — workspace agents use it today).

## References

- Existing harness: `packages/harness/`
- Idea: `01KQM8JT6CPHGS16Y91XJF67FS`
- SAM MCP tools: `apps/api/src/routes/mcp/`
- SAM MCP tool definitions: `apps/api/src/routes/mcp/tool-definitions*.ts`
- Architecture learnings: library file `sam-harness-architecture-learnings.md`
- Workspace agent MCP usage: `packages/vm-agent/internal/acp/session_host.go`

Execute this task using the /do skill.
