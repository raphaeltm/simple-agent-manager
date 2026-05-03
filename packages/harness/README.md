# SAM Agent Harness (Spike)

A minimal Go prototype proving the core agent-loop and tool architecture for a SAM-native coding agent.

**Status:** Architecture spike / proof-of-concept. Not production code.

## Architecture

```
packages/harness/
├── agent/         # Core think→act→observe loop
├── llm/           # LLM provider abstraction + mock + OpenAI-compatible proxy
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

### LLM Providers

The `llm.MockProvider` enables fully deterministic tests with no network dependency. Script a sequence of responses (including tool calls) and the agent loop executes them against real tools operating on temp directories.

The `llm.OpenAIProxyProvider` is the first real-model experiment path. It calls an OpenAI-compatible `/chat/completions` endpoint, which can be SAM's AI proxy:

```bash
cd packages/harness
go run ./cmd/harness \
  --provider openai-proxy \
  --base-url "https://api.${SAM_BASE_DOMAIN}/ai/v1" \
  --api-key "$SAM_AI_PROXY_TOKEN" \
  --model "@cf/google/gemma-4-26b-a4b-it" \
  --tool-choice auto \
  --dir ./testdata/fixture-repo \
  --prompt "Read README.md and summarize the project." \
  --transcript /tmp/harness-gemma-transcript.json
```

For a small OpenAI model through the same SAM proxy, change only `--model`:

```bash
--model "gpt-4.1-mini"
```

The API key is expected to be a workspace callback token when using SAM's `/ai/v1` proxy. The proxy is responsible for routing to the configured SAM Cloudflare AI Gateway and applying Unified Billing where configured.

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

## Proven Capabilities (2026-05-03)

The harness has been tested end-to-end inside Cloudflare Containers via the Sandbox SDK:

- **Multi-model**: Workers AI (Gemma 4, Llama 4 Scout, Qwen 2.5 Coder) and OpenAI (gpt-4.1-mini) all work through the same SAM `/ai/v1` proxy
- **Unified billing**: OpenAI calls route through the `sam` AI Gateway with `authentication: true` — zero external API keys needed
- **Container execution**: Static binary (6.1MB) runs inside Cloudflare Containers; admin endpoint orchestrates download from R2, write to container, fixture creation, and harness execution
- **Tool calls in containers**: `read_file`, `write_file`, and `bash` all execute inside the container filesystem
- **Performance**: 2-4 turns, 3-8 seconds total (warm container)

See `experiments/harness-sam-proxy/README.md` for full experiment logs and results.

## Next Steps (Track D: SAM Integration Design)

Tracks A (Go harness spike), B (AI Gateway experiment), and C (Cloudflare Sandbox prototype) are complete. The remaining work:

### SAM Integration Design (Track D)
- Design how TaskRunner DO dispatches the harness as an alternative agent runtime
- Define transcript-to-chat-message mapping for streaming progress to project chat
- Decide: harness in Sandbox container vs. on existing VM (or both)
- Wire harness agent type into the agent profile system
- Risk: ACP session lifecycle differences from subprocess-based agents

### Evaluation Framework (Track E)
- Build eval task corpus beyond the 3 scripted mock tests
- Compare harness vs. Claude Code on standardized coding tasks
- Measure cost/latency/quality tradeoffs across models
- Go/no-go decision on shipping harness as a user-facing agent option
