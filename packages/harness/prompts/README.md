# Harness Prompt Architecture

System prompts that define agent behavior for the SAM harness. Each prompt is a self-contained markdown file that can be loaded via `--prompt-preset` or `--prompt-file`.

## Presets

| Preset | File | Tool Profile | Use Case |
|--------|------|--------------|----------|
| `workspace` | `workspace.md` | `workspace` | Single-workspace coding agent — reads, edits, tests, commits |
| `orchestrator` | `orchestrator.md` | `orchestrate` | Coordinates subtasks via SAM dispatch — decomposes, delegates, aggregates |

## Loading Prompts

```bash
# Use a built-in preset (loads from this directory)
harness --prompt-preset orchestrator --prompt "Deploy the new auth flow"

# Use a custom prompt file
harness --prompt-file ./my-custom-prompt.md --prompt "Do the thing"

# Use inline system prompt (original behavior, still works)
harness --system "You are a helpful assistant." --prompt "Hello"
```

### Precedence

1. `--prompt-file` (highest) — loads from the specified path
2. `--prompt-preset` — loads from `prompts/<name>.md` relative to the binary or embedded
3. `--system` (lowest/default) — inline string

Only one source is used. If multiple are specified, the highest-precedence one wins.

## Prompt + Tool Profile Pairing

Each prompt is designed to work with a specific tool profile (set via `--tool-profile`):

- **workspace** prompt expects file/git/shell tools + workspace MCP tools
- **orchestrator** prompt expects file/shell tools (for lightweight queries) + orchestration MCP tools

The CLI does NOT auto-select the tool profile — you must set both `--prompt-preset` and `--tool-profile` to match. This keeps them independently configurable for experimentation.

## Writing Custom Prompts

A prompt file is plain markdown. The entire file content becomes the system prompt. Guidelines:

1. Start with a role definition (who the agent is)
2. Define decision frameworks (when to use which approach)
3. Document tool usage patterns specific to the role
4. Include error handling and edge case guidance
5. End with anti-patterns to avoid

Keep prompts under 3000 tokens — longer prompts waste context budget on every turn.
