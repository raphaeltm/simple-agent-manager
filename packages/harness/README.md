# SAM Agent Harness (Spike)

A minimal Go prototype proving the core agent-loop and tool architecture for a SAM-native coding agent.

**Status:** Architecture spike / proof-of-concept. Not production code.

## Architecture

```
packages/harness/
├── agent/         # Core think→act→observe loop
├── llm/           # LLM provider abstraction + mock
├── tools/         # Tool registry + built-in tools (read, write, edit, bash)
├── transcript/    # Append-only event log
├── cmd/harness/   # CLI entry point
└── testdata/      # Fixture repo for evaluation
```

### Core Loop

The agent follows a think→act→observe cycle:

1. **Think**: Send conversation history + tool definitions to the LLM
2. **Act**: Execute any tool calls the LLM requests
3. **Observe**: Feed tool results back into the conversation
4. **Repeat** until the model stops calling tools or max turns is reached

### Deterministic Testing

The `llm.MockProvider` enables fully deterministic tests with no network dependency. Script a sequence of responses (including tool calls) and the agent loop executes them against real tools operating on temp directories.

## Quick Start

```bash
# Build
cd packages/harness
go build ./...

# Run tests (all deterministic, no network needed)
go test ./... -v

# Build and run CLI
go build -o harness ./cmd/harness/
./harness --prompt "Analyze this repo" --dir /path/to/project --transcript output.json
```

## Built-in Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents with line numbers |
| `write_file` | Create or overwrite files (auto-creates directories) |
| `edit_file` | Search-and-replace with unique match validation |
| `bash` | Shell command execution with configurable timeout and cancellation |

## Evaluation Tasks

Three scripted evaluation tasks verify the architecture works end-to-end:

1. **Read-only repo analysis** — agent reads files and summarizes without writing
2. **File edit + verification** — agent creates, edits, and verifies a file
3. **Failing command recovery** — agent encounters an error, creates the missing file, retries

All run as Go tests with mock LLM responses.

## Architectural Inspiration

This harness draws architectural patterns from several open-source projects. No code was vendored or copied.

| Source | Pattern Borrowed | License |
|--------|-----------------|---------|
| **Crush** (charmbracelet/crush) | Tool registry with name-based dispatch, permission-ready architecture | MIT |
| **Pi** (badlogic/pi-mono) | Minimal 4-tool design (read, write, edit, bash), SDK/embedding modes | MIT |
| **OpenHands** (All-Hands-AI/OpenHands) | Event-sourced transcript log (action→observation pairs) | MIT |
| **SWE-agent** (Princeton) | Agent-Computer Interface concept — tool output formatted for LLM comprehension | MIT |
| **Claude Code** (Anthropic) | Context management patterns, composable system prompts | Proprietary (patterns only) |

All implementations are clean-room. The tool interfaces, agent loop, and transcript system were written from scratch for SAM's specific needs.

## Next Steps (Integration Risks)

### VM Integration (Phase 2)
- Wire into `packages/vm-agent/internal/acp/` as a new agent type
- Share workspace file system and Docker container
- Connect to ACP session lifecycle (start, stop, stream output)
- Risk: ACP SDK protocol differences from subprocess-based agents

### Multi-Model Support (Phase 5)
- Implement `llm.Provider` for Anthropic and OpenAI APIs
- Route through CF AI Gateway for cost tracking
- Risk: Tool calling format differences between providers

### Container Mode (Phase 3)
- Package as lightweight Docker image for CF Containers
- Add HTTP server mode (`harness serve`)
- Risk: Cold start time vs. warm pool management
