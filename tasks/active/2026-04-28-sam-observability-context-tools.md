# SAM Observability & Context-Awareness Tools

## Problem Statement

The SAM orchestrator agent currently has limited visibility into task execution details and project codebases. While workspace-level agents have full MCP access to `search_messages`, `get_session_messages`, and `list_sessions`, the SAM agent lacks equivalent tools for cross-project task message inspection and has no codebase search capability at all.

This creates two gaps:
1. **Task message search**: SAM cannot read the chat history of tasks it dispatched. When checking on task progress or debugging failures, SAM relies on `get_task_details` which only shows the output summary — not the full conversation.
2. **Codebase contextual search**: SAM cannot search project codebases when answering questions or making decisions about task planning. It has no way to look up file structures or code patterns.

## Research Findings

### Existing Architecture

**SAM Agent Tools** live in `apps/api/src/durable-objects/sam-session/tools/`:
- Each tool exports a `def` (AnthropicToolDef) and a handler function
- Tools are registered in `tools/index.ts` via `SAM_TOOLS` array and `toolHandlers` map
- `ToolContext` provides `env`, `userId`, and optional `searchMessages` (for SAM's own conversation history)

**Message Storage** (ProjectData DO):
- `chat_messages` table stores raw streaming tokens per session
- `chat_messages_grouped` + FTS5 index for materialized sessions
- `searchMessages(query, sessionId, roles, limit)` supports both FTS5 and LIKE fallback
- `getMessages(sessionId, limit, before, roles)` returns raw tokens
- Sessions have a `taskId` field linking them to tasks

**Existing MCP Tools** (workspace-level):
- `search_messages` in `session-tools.ts` — full-text search across project sessions
- `get_session_messages` in `session-tools.ts` — get messages from a specific session with token grouping
- `list_sessions` — list project sessions with status/taskId filters
- These use `projectDataService.*` which proxies to ProjectData DO

**GitHub API Integration**:
- `get_ci_status` SAM tool already resolves user GitHub tokens from encrypted credentials
- Pattern: query project → resolve GitHub token → call API with AbortController timeout
- `getInstallationToken()` in `github-app.ts` can get installation-level tokens
- Projects have `repository` (owner/repo), `installationId`, `defaultBranch`

### Key Design Decisions

1. **Task message search**: Reuse `projectDataService.searchMessages()` and `projectDataService.getMessages()` — the same services workspace agents use. SAM needs the `projectId` from the task's project to call these.

2. **Codebase search**: Use GitHub's Code Search API (`GET /search/code`) with user's GitHub token. This gives SAM read access to any file in the project's repository. Fallback: use `GET /repos/{owner}/{repo}/contents/{path}` for directory listing and file content retrieval.

3. **GitHub token resolution**: Follow the same pattern as `get_ci_status` — resolve from user's encrypted credentials in the `credentials` table.

## Implementation Checklist

### Tool 1: `get_session_messages` (SAM-level)
- [ ] Create `apps/api/src/durable-objects/sam-session/tools/get-session-messages.ts`
- [ ] Define `getSessionMessagesDef` with input schema: `projectId` (required), `sessionId` (required), `limit` (optional), `roles` (optional array)
- [ ] Implement handler: verify project ownership, call `projectDataService.getMessages()`, group tokens via `groupTokensIntoMessages()`
- [ ] Register in `tools/index.ts` (SAM_TOOLS array + toolHandlers map)

### Tool 2: `search_task_messages` (SAM-level)
- [ ] Create `apps/api/src/durable-objects/sam-session/tools/search-task-messages.ts`
- [ ] Define `searchTaskMessagesDef` with input schema: `projectId` (required), `query` (required), `taskId` (optional — filter by task), `sessionId` (optional), `roles` (optional array), `limit` (optional)
- [ ] Implement handler: verify project ownership, resolve taskId → sessionId if needed, call `projectDataService.searchMessages()`
- [ ] Register in `tools/index.ts`

### Tool 3: `list_sessions` (SAM-level)
- [ ] Create `apps/api/src/durable-objects/sam-session/tools/list-sessions.ts`
- [ ] Define `listSessionsDef` with input schema: `projectId` (required), `status` (optional), `taskId` (optional), `limit` (optional)
- [ ] Implement handler: verify project ownership, call `projectDataService.listSessions()`
- [ ] Register in `tools/index.ts`

### Tool 4: `search_code` (SAM-level, GitHub Code Search)
- [ ] Create `apps/api/src/durable-objects/sam-session/tools/search-code.ts`
- [ ] Define `searchCodeDef` with input schema: `projectId` (required), `query` (required), `path` (optional — filter by file path), `extension` (optional — filter by file extension), `limit` (optional, default 10, max 30)
- [ ] Implement handler: verify project ownership, resolve GitHub token, call GitHub Code Search API with `repo:owner/name` qualifier
- [ ] Parse results: return file path, match snippet, HTML URL for each result
- [ ] Handle no-token gracefully (return helpful error)
- [ ] Register in `tools/index.ts`

### Tool 5: `get_file_content` (SAM-level, GitHub Contents API)
- [ ] Create `apps/api/src/durable-objects/sam-session/tools/get-file-content.ts`
- [ ] Define `getFileContentDef` with input schema: `projectId` (required), `path` (required), `ref` (optional — branch/commit, defaults to project's defaultBranch)
- [ ] Implement handler: verify project ownership, resolve GitHub token, call `GET /repos/{owner}/{repo}/contents/{path}` API
- [ ] Decode base64 content for files, return directory listing for directories
- [ ] Configurable max file size via env var (default 1MB)
- [ ] Register in `tools/index.ts`

### Shared Infrastructure
- [ ] Extract `getUserGitHubToken()` from `get-ci-status.ts` into a shared helper (avoid duplication)
- [ ] Add configurable constants: `SAM_CODE_SEARCH_LIMIT` (default 10), `SAM_CODE_SEARCH_MAX_LIMIT` (default 30), `SAM_FILE_CONTENT_MAX_BYTES` (default 1048576), `SAM_GITHUB_TIMEOUT_MS` (reuse existing)
- [ ] Add shared `resolveProjectWithOwnership()` helper for project+ownership verification (used by multiple tools)

### Tests
- [ ] Unit tests for `get-session-messages.ts` — verify message grouping, ownership check, limit enforcement
- [ ] Unit tests for `search-task-messages.ts` — verify query validation, taskId→sessionId resolution, FTS search delegation
- [ ] Unit tests for `list-sessions.ts` — verify status/taskId filtering, limit enforcement
- [ ] Unit tests for `search-code.ts` — verify GitHub API call construction, result parsing, no-token handling
- [ ] Unit tests for `get-file-content.ts` — verify path handling, base64 decode, directory listing, max size enforcement
- [ ] Integration test: verify tools are registered in SAM_TOOLS and toolHandlers

### Documentation
- [ ] Update CLAUDE.md recent changes section with new tools
- [ ] Update SAM_SYSTEM_PROMPT in agent-loop.ts to document new tool categories

## Acceptance Criteria

1. SAM can search through chat messages of any task in any of the user's projects
2. SAM can retrieve full message history for a specific session
3. SAM can list sessions for a project with optional filters
4. SAM can search code in a project's GitHub repository
5. SAM can retrieve file content from a project's GitHub repository
6. All tools verify project ownership before returning data
7. All tools use configurable limits (no hardcoded values per Constitution Principle XI)
8. All tools handle missing credentials gracefully with helpful messages
9. Tests cover happy path and error cases for all tools

## References

- SAM tools index: `apps/api/src/durable-objects/sam-session/tools/index.ts`
- Existing pattern: `apps/api/src/durable-objects/sam-session/tools/get-ci-status.ts`
- MCP session tools: `apps/api/src/routes/mcp/session-tools.ts`
- ProjectData service: `apps/api/src/services/project-data.ts`
- Constitution: `.specify/memory/constitution.md` (Principle XI)
