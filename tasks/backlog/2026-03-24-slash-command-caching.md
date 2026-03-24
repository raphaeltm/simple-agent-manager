# Slash Command Caching for Project Chat (Hybrid)

## Problem

When a user types in the ProjectChat input, there's no active ACP connection — slash commands can't be discovered or shown in autocomplete. The `SlashCommandPalette` only works inside `AgentPanel` which requires an active ACP session. Users must know commands from memory or start a session first.

## Research Findings

### Current Architecture

**Three command systems exist:**

| System | Source | Location |
|--------|--------|----------|
| ACP Agent Commands | `available_commands_update` notification | `useAcpMessages.ts:392-406` |
| Client Commands | Static array (`/clear`, `/copy`, `/export`) | `AgentPanel.tsx:26-30` |
| MCP Tools | 43 tools via `tools/list` | `tool-definitions.ts` (internal only) |

**Key code paths:**
- `SlashCommand` type: `packages/acp-client/src/types.ts:1-12` — `{ name, description, source: 'agent' | 'client' }`
- `SlashCommandPalette`: `packages/acp-client/src/components/SlashCommandPalette.tsx` — forwardRef with keyboard nav, source badges
- `AgentPanel` integration: combines `availableCommands` from ACP with `CLIENT_COMMANDS`, passes to palette
- `ChatInput` in `ProjectChat.tsx:1108-1312` — textarea with auto-grow, no slash command support
- `handleSubmit` in `ProjectChat.tsx:359-395` — submits task via `submitTask()` API
- ProjectData DO: `apps/api/src/durable-objects/project-data/index.ts` — latest migration is 012

**Gaps:**
- Commands stored only in React state (lost on reload)
- No persistence to DO/D1/KV
- `ChatInput` has no slash detection or palette integration
- `SlashCommand.source` only supports `'agent' | 'client'` — needs `'cached'` or similar

### Design: Option C — Hybrid (Static Registry + Session Cache)

**Three-tier command sources:**

| Source | Discovery | Cache Strategy | Invalidation |
|--------|-----------|---------------|--------------|
| Client commands (SAM-defined) | Static, compiled | Permanent | App version bump |
| Static registry (per agent type) | Compiled | Permanent | App version bump |
| Agent commands (from ACP) | `available_commands_update` | ProjectData DO SQLite | Fresh update on next session |

## Implementation Checklist

### 1. Extend SlashCommand type to support source badges
- [ ] Update `SlashCommand.source` in `packages/acp-client/src/types.ts` to include `'cached'` source
- [ ] Update badge rendering in `SlashCommandPalette.tsx` for the new source type

### 2. Create static agent command registry
- [ ] Create `packages/acp-client/src/commands/registry.ts` with well-known commands per agent type
- [ ] Define Claude Code commands: `/commit`, `/review-pr`, `/do`, `/help`, `/compact`, `/cost`, `/doctor`, `/init`, `/login`, `/logout`, `/mcp`, `/memory`, `/model`, `/pr-comments`, `/permissions`, `/status`, `/vim`
- [ ] Export `getStaticCommands(agentType: string): SlashCommand[]` function
- [ ] Export from `packages/acp-client/src/index.ts`

### 3. Add DO SQLite migration for command cache
- [ ] Add migration 013 in `apps/api/src/durable-objects/migrations.ts`: `cached_commands` table with columns `(agent_type TEXT, name TEXT, description TEXT, updated_at INTEGER, PRIMARY KEY (agent_type, name))`
- [ ] Add `saveCachedCommands(sql, agentType, commands)` and `getCachedCommands(sql, agentType)` functions in a new `apps/api/src/durable-objects/project-data/commands.ts` module
- [ ] Wire into ProjectData DO: `cacheCommands()` and `getCachedCommands()` methods

### 4. Add API endpoint for cached commands
- [ ] Add `GET /api/projects/:projectId/cached-commands` to `apps/api/src/routes/chat.ts`
- [ ] Returns `{ commands: Array<{ name, description, agentType }> }`
- [ ] Requires auth + project ownership

### 5. Add API endpoint to persist commands from ACP session
- [ ] Add `POST /api/projects/:projectId/cached-commands` to persist commands after `available_commands_update`
- [ ] Accepts `{ agentType: string, commands: Array<{ name, description }> }`
- [ ] Calls ProjectData DO `cacheCommands()` method

### 6. Create `useAvailableCommands` hook
- [ ] Create `apps/web/src/hooks/useAvailableCommands.ts`
- [ ] Fetches cached commands from API on mount: `GET /api/projects/:projectId/cached-commands`
- [ ] Merges: static registry commands + cached commands + live ACP commands (when connected)
- [ ] Deduplicates by command name (live > cached > static priority)
- [ ] Returns `{ commands: SlashCommand[], isLoading: boolean }`

### 7. Integrate slash palette into ChatInput
- [ ] Add slash detection to `ChatInput` in `ProjectChat.tsx`: detect when input starts with `/`
- [ ] Render `SlashCommandPalette` above the textarea when slash detected
- [ ] Handle command selection: replace input with `/<command> ` or prepend to message
- [ ] Wire keyboard navigation via `SlashCommandPaletteHandle.handleKeyDown`
- [ ] Pass commands from `useAvailableCommands` hook

### 8. Persist commands on ACP `available_commands_update`
- [ ] In `useAcpMessages.ts` or a wrapper, call the POST endpoint when commands are received
- [ ] Pass `projectId` and `agentType` to the persistence call

### 9. Add web API client function
- [ ] Add `getCachedCommands(projectId)` and `saveCachedCommands(projectId, agentType, commands)` to `apps/web/src/lib/api.ts`

### 10. Tests
- [ ] Unit test: static command registry returns correct commands per agent type
- [ ] Unit test: command merge/dedup logic in `useAvailableCommands`
- [ ] Integration test: `GET /api/projects/:projectId/cached-commands` returns cached commands
- [ ] Integration test: `POST /api/projects/:projectId/cached-commands` persists and retrieves
- [ ] Component test: `SlashCommandPalette` renders with all three source badges
- [ ] Component test: `ChatInput` shows palette on `/` keystroke, selects command

## Acceptance Criteria

- [ ] Typing `/` in ProjectChat input (before any session exists) shows slash command autocomplete
- [ ] Static well-known commands for Claude Code are always available
- [ ] After a session runs and receives `available_commands_update`, those commands are persisted per-project
- [ ] On next visit to ProjectChat, cached commands appear in the palette
- [ ] When an active ACP session sends fresh commands, they replace/merge with cached ones
- [ ] Source badges distinguish "Agent", "SAM", and "Cached" commands
- [ ] No horizontal overflow on mobile (375px) for the palette
- [ ] Tests cover: static registry, cache persistence, cache retrieval, merge logic, UI rendering

## References

- Idea: `01KMGMRYE87PDMZ5HEBJ4SJADS`
- SAM Task: `01KMGPXETXCPTSGB0GK0QD63Q4`
- `packages/acp-client/src/components/SlashCommandPalette.tsx`
- `packages/acp-client/src/hooks/useAcpMessages.ts`
- `packages/acp-client/src/components/AgentPanel.tsx`
- `apps/web/src/pages/ProjectChat.tsx`
- `apps/api/src/durable-objects/project-data/`
