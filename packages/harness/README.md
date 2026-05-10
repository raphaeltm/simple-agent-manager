# SAM Agent Harness (Spike)

A minimal Go prototype proving the core agent-loop and tool architecture for a SAM-native coding agent.

**Status:** Architecture spike / proof-of-concept. Not production code.

## Architecture

```
packages/harness/
├── agent/         # Core think→act→observe loop
├── llm/           # LLM provider abstraction (mock + OpenAI-compatible)
├── tools/         # Tool registry + built-in tools
├── transcript/    # Append-only event log
├── cmd/harness/   # CLI entry point
├── scripts/       # Manual validation scripts
└── testdata/      # Fixture projects for evaluation
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

# Build and run CLI (mock mode)
go build -o harness ./cmd/harness/
./harness --prompt "Analyze this repo" --dir /path/to/project --transcript output.json

# Run CLI with a real model via SAM AI Gateway
./harness \
  --provider openai \
  --api-url "https://api.sammy.party/api/ai/proxy/openai/v1" \
  --api-key "$SAM_AI_PROXY_KEY" \
  --model "@cf/google/gemma-3-27b-it" \
  --prompt "Analyze this repo" \
  --dir /path/to/project \
  --transcript output.json
```

## Built-in Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents with line numbers |
| `write_file` | Create or overwrite files (auto-creates directories) |
| `edit_file` | Search-and-replace with unique match validation |
| `bash` | Shell command execution with configurable timeout and cancellation |
| `grep` | Recursive regex search with context lines and file filtering |
| `glob` | Find files matching glob patterns (supports `**`) |

## Evaluation Tasks

Eight scripted evaluation tasks verify the architecture works end-to-end. All run as Go tests with mock LLM responses — deterministic, no network needed.

### Basic Tasks (eval_test.go)

1. **Read-only repo analysis** — agent reads files and summarizes without writing
2. **File edit + verification** — agent creates, edits, and verifies a file
3. **Failing command recovery** — agent encounters an error, creates the missing file, retries

### Advanced Tasks (eval_advanced_test.go)

4. **Multi-file edit** — agent renames a function across 3 files (definition, caller, test), verifying old name is gone and new name appears in all files
5. **Bug fix via grep** — agent is given failing test output, uses grep to locate the buggy function, reads it, and applies a fix
6. **Refactor with git commit** — agent exports an unexported function, updates all call sites, and creates a git commit with a descriptive message
7. **Large codebase navigation** — agent navigates a 21-file project using glob/grep to answer a structural question without reading every file
8. **Failing test diagnosis** — agent reads both test and implementation files to diagnose a root cause and apply a fix

### Test Fixtures

| Directory | Files | Purpose |
|-----------|-------|---------|
| `testdata/fixture-repo/` | 2 | Basic Go project for read-only analysis |
| `testdata/multi-file-project/` | 3 | Inter-dependent Go files for multi-file rename |
| `testdata/buggy-project/` | 2 | Go project with a known bug in `Abs()` |
| `testdata/refactor-project/` | 2 | Go project with unexported functions to export |
| `testdata/large-project/` | 21 | Multi-package project (auth, db, handlers, middleware, models, workers) |

## Orchestration Mode

The harness supports an orchestrator role that decomposes tasks into subtasks and delegates work to child agents.

### Mock Orchestration (for eval)

```bash
./harness \
  --provider openai \
  --api-url "$SAM_AI_PROXY_URL" \
  --api-key "$SAM_AI_PROXY_KEY" \
  --model "gpt-5.4-mini" \
  --prompt "Refactor the auth middleware into its own package" \
  --prompt-preset orchestrator \
  --mock-orchestration success \
  --tool-profile full \
  --dir /path/to/project
```

Use `--mock-orchestration <scenario>` where scenario is `success`, `failure`, or `mixed`. This simulates subtask execution so the model's orchestration decisions can be evaluated without real child processes.

### Real Orchestration

```bash
./harness \
  --provider openai \
  --api-url "$SAM_AI_PROXY_URL" \
  --api-key "$SAM_AI_PROXY_KEY" \
  --model "gpt-5.4-mini" \
  --worker-model "gpt-4.1-mini" \
  --prompt "Refactor the auth middleware into its own package" \
  --prompt-preset orchestrator \
  --real-orchestration \
  --tool-profile full \
  --dir /path/to/project
```

Use `--real-orchestration` to spawn actual harness child sessions for each `dispatch_task` call. Child sessions use `--worker-model` (defaults to `--model` if not set), the `workspace` prompt preset, and `workspace` tool profile.

### Model Routing

Use `--worker-model` to route different models to different roles:
- `--model` sets the orchestrator model (the one that decomposes and delegates)
- `--worker-model` sets the model for child subtask sessions (the ones that do the work)

This enables cost-effective orchestration: use a capable model for planning and a cheaper model for execution.

## Running Against a Real Model

The `scripts/run-eval-real.sh` script runs eval tasks against a real LLM via the SAM AI Gateway. This is for manual validation only — not run in CI.

```bash
# Set required env vars
export SAM_AI_PROXY_URL="https://api.sammy.party/api/ai/proxy/openai/v1"
export SAM_AI_PROXY_KEY="your-api-key"

# Optional: override model (default: @cf/google/gemma-3-27b-it)
export SAM_AI_MODEL="gpt-4o-mini"

# Run all eval tasks
cd packages/harness
./scripts/run-eval-real.sh
```

### Example Output

```
============================================
  SAM Harness Real Model Evaluation
============================================
  Proxy URL: https://api.sammy.party/api/ai/proxy/openai/v1
  Model:     @cf/google/gemma-3-27b-it
  Time:      2026-05-09 22:00:00 UTC
============================================

TASK                      STATUS   TURNS    DURATION
------------------------- -------- -------- ----------
bug-fix                   PASS     4        12s
multi-file-rename         PASS     7        28s
codebase-navigation       PASS     3        8s
test-diagnosis            PASS     4        15s
refactor-export           PASS     8        35s

============================================
  Results: 5/5 passed, 0 failed
============================================
```

Transcript JSON files are written to `/tmp/harness-eval-*.json` for inspection.

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
