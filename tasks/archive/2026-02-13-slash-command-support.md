# Slash Command Support in Chat Sessions

## Summary

Claude Code and Codex both support `/` commands (e.g. `/compact`, `/model`, `/review`) that users rely on heavily. Our chat UI currently has no awareness of these commands — users can type them as plain text prompts and the agent will process some of them, but there's no autocomplete, no command palette, and no visual distinction. Some commands (like `/clear`) are client-side concerns that the agent can't handle.

We should surface slash commands properly in the chat UI: autocomplete on `/`, display available commands, and handle client-local commands ourselves.

## How ACP Slash Commands Work

### Protocol: `available_commands_update`

When an ACP session starts, the agent sends an `available_commands_update` notification listing all commands it supports. Each command includes:

- **name** — the slash command name (e.g. `compact`, `review`)
- **description** — human-readable description for UI display
- **input** — optional `AvailableCommandInput` describing expected arguments

The agent filters out client-local commands (like `/clear`, `/exit`, `/theme`, `/config`) and only advertises commands applicable in ACP mode. Both built-in and custom commands (from `.claude/commands/` or `.codex/prompts/`) are included.

### How Commands Are Sent

Slash commands are sent as regular prompt text — the user types `/compact` and it goes through `session/prompt` as `[{ type: "text", text: "/compact" }]`. The agent parses the leading `/` and routes it internally. No special ACP method is needed.

### Current SAM Behavior

1. The `gatewayClient.SessionUpdate()` in `gateway.go` forwards all `session/update` notifications to the browser — this likely **already includes** `available_commands_update` in the notification stream
2. The browser chat component **ignores** these notifications — no command parsing, no autocomplete
3. Users can type `/compact` as a text message and it works (agent processes it), but there's no UI support

## Agent Command Catalogs

### Claude Code (`claude-code-acp`)

**ACP-supported built-in commands:**

| Command | Description |
|---------|-------------|
| `/compact` | Compress conversation context (accepts optional focus instructions) |
| `/model` | Switch between models (Opus, Sonnet, Haiku) |
| `/review` | Code review with optional instructions |
| `/plan` | Enter plan mode |
| `/memory` | Edit CLAUDE.md memory files |
| `/permissions` | Show or update tool permissions |
| `/cost` | Display token usage and cost statistics |
| `/context` | View current context usage |
| `/status` | Version, model, and account info |
| `/init` | Initialize project with CLAUDE.md guide |
| `/help` | Show all available commands |
| `/bug` | Report bugs to Anthropic |
| `/doctor` | Check installation for problems |
| `/mcp` | Manage MCP server connections |

**Client-local commands (NOT sent via ACP):**

| Command | Description | SAM handling |
|---------|-------------|-------------|
| `/clear` | Clear conversation history | SAM should handle client-side |
| `/exit` | Terminate REPL | N/A (no REPL in browser) |
| `/theme` | Change color theme | Could map to SAM theme |
| `/config` | Open settings | Could link to SAM settings |
| `/vim` | Toggle vim mode | Could implement in chat input |
| `/copy` | Copy last response to clipboard | SAM should handle client-side |
| `/export` | Export conversation | SAM should handle client-side |

**Custom commands:** Loaded from `.claude/commands/` in the workspace. Fully supported via ACP.

Reference: [Claude Code Commands Reference](https://www.gradually.ai/en/claude-code-commands/)

### OpenAI Codex (`codex-acp`)

**ACP-supported built-in commands:**

| Command | Description |
|---------|-------------|
| `/compact` | Condense conversation to free context |
| `/model` | Switch between models |
| `/review` | Code review |
| `/review-branch` | Review changes in current git branch |
| `/review-commit` | Review specific git commit |
| `/init` | Initialize project with AGENTS.md |
| `/diff` | Show git diff of changes |
| `/mention` | Pull specific files into conversation |

**Client-local commands:**

| Command | Description | SAM handling |
|---------|-------------|-------------|
| `/new` | Start fresh session | SAM creates new chat tab |
| `/logout` | Clear auth | N/A |

**Custom prompts:** Loaded from `.codex/prompts/` in the workspace. Supported via ACP.

Reference: [Codex CLI Slash Commands](https://developers.openai.com/codex/cli/slash-commands/)

### Google Gemini CLI

Currently runs with `--experimental-acp`. Command support is limited and evolving.

## Proposed Implementation

### Phase 1: Parse and Display Available Commands

1. **Gateway passthrough** — Verify that `available_commands_update` notifications already flow through `SessionUpdate()` to the browser (likely already works, just need to confirm the notification type)
2. **Browser: Parse commands** — In the chat WebSocket handler, listen for `available_commands_update` and store the command list in React state
3. **Autocomplete popup** — When user types `/` in the chat input, show a filterable dropdown of available commands with descriptions
4. **Visual distinction** — Render sent slash commands differently in the chat history (e.g. monospace, distinct color)

### Phase 2: Client-Local Commands

Handle commands that should NOT be forwarded to the agent:

| Command | Client behavior |
|---------|----------------|
| `/clear` | Clear the chat message history in the browser |
| `/new` | Create a new chat session tab |
| `/copy` | Copy last assistant response to clipboard |
| `/export` | Download conversation as markdown/JSON |
| `/help` | Show combined list of agent + client commands |

These are intercepted before sending to the WebSocket.

### Phase 3: Enhanced Command Features

- **`/model` UI integration** — When user runs `/model`, show a model picker dropdown instead of just passing text
- **`/compact` status** — Show a visual indicator when context is being compacted
- **`/diff` rendering** — Render diff output with syntax highlighting
- **Custom command discovery** — Show a badge or section for workspace-specific custom commands

## Acceptance Criteria

- [ ] Chat input shows autocomplete dropdown when user types `/`
- [ ] Available commands list is populated from ACP `available_commands_update` notification
- [ ] Autocomplete filters as user types (e.g. `/co` shows `/compact`, `/cost`, `/context`, `/copy`)
- [ ] Selecting a command from autocomplete inserts it into the input
- [ ] Commands with descriptions show the description in the dropdown
- [ ] Client-local commands (`/clear`, `/copy`, `/new`, `/export`) are handled without sending to agent
- [ ] `/help` shows both agent commands and SAM-specific client commands
- [ ] Custom workspace commands (from `.claude/commands/`, `.codex/prompts/`) appear in autocomplete
- [ ] Works on mobile with touch-friendly dropdown

## Files Likely Affected

### VM Agent (Go)
- `internal/acp/gateway.go` — Verify `available_commands_update` passthrough (may already work)

### Web (React)
- `apps/web/src/components/ChatSession.tsx` — Command parsing, autocomplete UI, client-local command handling
- `apps/web/src/components/SlashCommandPalette.tsx` — New component for the autocomplete dropdown
- `apps/web/src/hooks/useSlashCommands.ts` — Hook to manage available commands state from WebSocket

### Shared
- `packages/shared/src/types.ts` — `SlashCommand` interface if needed for type safety

## Notes

- Commands are just text prompts with a `/` prefix — the agent handles parsing. No special ACP method is needed for execution.
- The `available_commands_update` notification is sent at session start, but may also update dynamically (e.g. after `/mcp` adds a new server). The UI should handle updates.
- Some ACP clients (like Zed) use `\command` syntax to avoid conflicts with built-in commands, but SAM has no built-in command namespace conflict, so we can use `/` directly.
- Custom commands are workspace-specific and change per-repo — the autocomplete list will differ between workspaces.
