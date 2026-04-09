# Project File Library — MCP Tools

## Problem Statement

Agents running in SAM workspaces need programmatic access to the project file library. The backend core (PR #638) provides encrypted file storage with D1 metadata and R2 data, but no MCP tools exist for agents to list, download, upload, or replace library files.

## Research Findings

### MCP Tool Pattern
- Tools defined in `apps/api/src/routes/mcp/tool-definitions.ts` (MCP_TOOLS array with JSON Schema)
- Handlers follow signature: `(requestId, params, tokenData, env) => Promise<JsonRpcResponse>`
- Dispatcher switch in `apps/api/src/routes/mcp/index.ts`
- Context available via `McpTokenData`: taskId, projectId, userId, workspaceId
- Success: `jsonRpcSuccess(id, { content: [{ type: 'text', text: JSON.stringify(data) }] })`
- Error: `jsonRpcError(id, INVALID_PARAMS | INTERNAL_ERROR, message)`
- `requireWorkspace()` helper validates workspaceId exists

### File Library Backend
- Service at `apps/api/src/services/file-library.ts` with: `uploadFile`, `replaceFile`, `listFiles`, `getFile`, `downloadFile`, `deleteFile`, `updateTags`
- Encryption key: `env.LIBRARY_ENCRYPTION_KEY ?? env.ENCRYPTION_KEY`
- Upload checks: filename validation, size limit, project file count, duplicate filename (throws 409 conflict)
- Replace: requires fileId, encrypts new data, overwrites R2, updates D1
- Tags: source='user'|'agent', validated pattern, max per file enforced

### VM Agent File Transfer
- Download from workspace: `GET /workspaces/:id/files/download?path=...&token=...` via `{nodeId}.vm.{domain}:8443`
- Upload to workspace: `POST /workspaces/:id/files/upload?token=...` with multipart FormData via `{nodeId}.vm.{domain}:8443`
- Token: `signTerminalToken(userId, workspaceId, env)` — RS256 JWT
- Workspace node lookup: D1 query scoped to project

### Key Design Decisions
- upload/replace split forces agents to reason about overwrites (cannot accidentally overwrite user files)
- Download target: configurable `.library/` directory
- Upload reads file from workspace via VM agent, then encrypts and stores via file-library service
- Tags from MCP tools use `tag_source='agent'`

## Implementation Checklist

- [ ] 1. Create `apps/api/src/routes/mcp/library-tools.ts` with 4 tool handlers
- [ ] 2. Add tool definitions to `tool-definitions.ts` (list_library_files, download_library_file, upload_to_library, replace_library_file)
- [ ] 3. Register handlers in `index.ts` dispatcher switch
- [ ] 4. Implement `handleListLibraryFiles` — validate params, call `listFiles`, return metadata
- [ ] 5. Implement `handleDownloadLibraryFile` — decrypt from R2, upload to workspace via VM agent
- [ ] 6. Implement `handleUploadToLibrary` — download from workspace via VM agent, encrypt and store via service
- [ ] 7. Implement `handleReplaceLibraryFile` — download from workspace, replace via service, merge tags
- [ ] 8. Add `LIBRARY_MCP_DOWNLOAD_DIR` configurable constant (default: `.library/`)
- [ ] 9. Add helper to resolve workspace node for VM agent calls
- [ ] 10. Write unit tests for all 4 handlers
- [ ] 11. Test upload collision → replace flow
- [ ] 12. Test tag merging on replace
- [ ] 13. Update CLAUDE.md Recent Changes section

## Acceptance Criteria

- [ ] `list_library_files` returns filtered file metadata with tags
- [ ] `download_library_file` decrypts file and transfers to workspace `.library/` directory
- [ ] `upload_to_library` reads file from workspace, encrypts, stores in library with agent source
- [ ] `upload_to_library` returns FILE_EXISTS error with existing file metadata on duplicate filename
- [ ] `replace_library_file` replaces file content, merges tags, preserves original provenance
- [ ] `replace_library_file` returns FILE_NOT_FOUND error for invalid fileId
- [ ] All limits configurable via env vars (no hardcoded values)
- [ ] Unit tests cover all 4 tools including collision and tag merge flows
- [ ] Session and task IDs auto-attached from MCP context on upload

## References

- `packages/shared/src/types/library.ts` — shared types
- `apps/api/src/services/file-library.ts` — backend CRUD service
- `apps/api/src/routes/library.ts` — API routes (pattern reference)
- `apps/api/src/routes/mcp/` — existing MCP tools pattern
- `apps/api/src/routes/mcp/workspace-tools.ts` — VM agent proxy pattern
