# Workspace File Upload & Download

**Created:** 2026-03-28
**Linked Idea:** 01KMTFTWTZA12GAPKB9R30NN80
**Task ID:** 01KMTFXHSW9SXK8RM634VK4A6R

## Problem

Users can browse and view files in workspaces (read-only), but cannot upload files to or download files from running workspaces. This blocks key use cases:
- Uploading context files (design docs, images, datasets) for agent reference
- Downloading agent-produced outputs without committing to git
- Working with private files in public repos

## Research Findings

### Existing Patterns

1. **File proxy routes** (`apps/api/src/routes/projects/files.ts`):
   - `resolveSessionWorkspace()` — resolves workspace from session, validates ownership, builds URL + token
   - `proxyToVmAgent()` — proxies requests with timeout, size guard, safe header forwarding
   - `requireSafePath()` — validates paths via `normalizeProjectFilePath()`
   - Routes are mounted in `apps/api/src/routes/projects/index.ts` line 12

2. **Multipart parsing** (`apps/api/src/routes/transcribe.ts`):
   - Uses `c.req.parseBody()` for multipart/form-data
   - File validation: type check, size check, empty check
   - Pattern: parse → validate → process

3. **VM agent file handlers** (`packages/vm-agent/internal/server/files.go`, `git.go`):
   - Auth: `requireWorkspaceRequestAuth()` in `workspace_routing.go:46-92`
   - Container resolution: `resolveContainerForWorkspace()` returns containerID, workDir, user
   - Command execution: `execInContainer()` runs `docker exec` with user/workdir
   - Path validation: `sanitizeFilePath()` rejects absolute paths, traversal, null bytes
   - Routes registered in `server.go:760-765`

4. **Config** (`packages/vm-agent/internal/config/config.go:152-156`):
   - Existing file browser config: FileListTimeout, FileListMaxEntries, etc.
   - Pattern: struct field + env var + default in Load()

5. **Path restriction** (`apps/api/src/routes/projects/_helpers.ts:34-91`):
   - `normalizeProjectFilePath()` only allows absolute paths under `/home/node/` and `/home/user/`
   - For upload, destination paths should be relative (resolved by VM agent against workdir)
   - The `.private/` directory will live at `/workspaces/.private/` — relative path `../.private/` from repo workdir

6. **Bootstrap** (`packages/vm-agent/internal/bootstrap/bootstrap.go:481-523`):
   - `populateVolumeFromHost()` copies repo into Docker volume at `/workspaces/{repoDirName}`
   - `ensureVolumeWritable()` runs `chmod -R a+rwX /workspaces`
   - No `.private/` directory exists yet — needs creation during volume setup

7. **Chat input** (`apps/web/src/components/chat/ProjectMessageView.tsx:1614-1680`):
   - `FollowUpInput` component with textarea, VoiceButton, Send button
   - Upload button should be added to the flex container at line 1643

8. **API client** (`apps/web/src/lib/api.ts:1817-1864`):
   - Existing session file proxy functions: `getSessionFileList`, `getSessionFileContent`, etc.
   - New upload/download functions needed here

9. **Env type** (`apps/api/src/index.ts:59-373`):
   - `FILE_PROXY_TIMEOUT_MS` and `FILE_PROXY_MAX_RESPONSE_BYTES` already exist (line 372-373)
   - New upload-specific env vars needed

## Implementation Checklist

### VM Agent (Go) — Upload & Download Handlers

- [ ] Add config fields to `config.go`: `FileUploadMaxBytes` (default: 10MB), `FileUploadBatchMaxBytes` (default: 50MB), `FileUploadTimeout` (duration, default: 60s), `FileDownloadTimeout` (duration, default: 30s), `FileDownloadMaxBytes` (default: 50MB)
- [ ] Load config fields from env vars in `config.go` Load(): `FILE_UPLOAD_MAX_BYTES`, `FILE_UPLOAD_BATCH_MAX_BYTES`, `FILE_UPLOAD_TIMEOUT`, `FILE_DOWNLOAD_TIMEOUT`, `FILE_DOWNLOAD_MAX_BYTES`
- [ ] Create `packages/vm-agent/internal/server/file_transfer.go` with:
  - `handleFileUpload` — POST handler: auth, parse multipart, validate each file (size, path), for each file: `docker exec sh -c 'mkdir -p <dir> && cat > <path>'` with stdin piped from file content
  - `handleFileDownload` — GET handler: auth, validate path, `docker exec cat <path>` streamed back with Content-Type detection and Content-Disposition header
- [ ] Register routes in `server.go` setupRoutes():
  - `POST /workspaces/{workspaceId}/files/upload`
  - `GET /workspaces/{workspaceId}/files/download`
- [ ] Add unit tests for upload/download handlers in `packages/vm-agent/`

### Bootstrap — Create `.private/` Directory

- [ ] In `bootstrap.go` `populateVolumeFromHost()` (or `ensureVolumeWritable()`), add step to create `/workspaces/.private/` with appropriate permissions after volume population

### API Worker — Upload & Download Proxy Routes

- [ ] Add env vars to `Env` interface in `apps/api/src/index.ts`: `FILE_UPLOAD_MAX_BYTES`, `FILE_UPLOAD_BATCH_MAX_BYTES`, `FILE_UPLOAD_TIMEOUT_MS`, `FILE_DOWNLOAD_TIMEOUT_MS`, `FILE_DOWNLOAD_MAX_BYTES`
- [ ] Add upload proxy route in `apps/api/src/routes/projects/files.ts`:
  - `POST /:id/sessions/:sessionId/files/upload` — multipart proxy: resolve workspace, validate total size, forward multipart body to VM agent
- [ ] Add download proxy route in `apps/api/src/routes/projects/files.ts`:
  - `GET /:id/sessions/:sessionId/files/download` — stream proxy: resolve workspace, validate path, proxy response with Content-Disposition
- [ ] Modify `proxyToVmAgent()` or create `proxyUploadToVmAgent()` to support POST with body forwarding and larger timeouts/size limits

### Web UI — Upload Button & Download Button

- [ ] Add `uploadSessionFile()` function to `apps/web/src/lib/api.ts` — POST multipart to `/api/projects/:id/sessions/:sessionId/files/upload`
- [ ] Add `downloadSessionFile()` function to `apps/web/src/lib/api.ts` — GET from `/api/projects/:id/sessions/:sessionId/files/download?path=...`, trigger browser download
- [ ] Add upload button to `FollowUpInput` in `ProjectMessageView.tsx` — paperclip/attachment icon, opens file picker, shows selected file(s), sends upload on confirm
- [ ] On successful upload, inject a system message into the chat indicating file path(s) so the agent knows the file exists
- [ ] Add download button to file browser (`ChatFilePanel.tsx`) — shown on file view mode, triggers download for the viewed file

### Documentation & Env Reference

- [ ] Add new env vars to `apps/api/.env.example`
- [ ] Update CLAUDE.md "Recent Changes" section

## Acceptance Criteria

- [ ] Users can upload single or multiple files (up to 10MB each, 50MB total batch) to a running workspace via the chat UI
- [ ] Uploaded files default to a `.private/` directory outside the git tree
- [ ] Users can optionally specify a custom destination path within the workspace
- [ ] Users can download any file from the workspace via the file browser
- [ ] File upload triggers a visible system message in the chat with file path(s)
- [ ] All size limits and timeouts are configurable via environment variables
- [ ] Path validation prevents directory traversal and unsafe destinations
- [ ] Binary files are handled correctly (not just text)
- [ ] Upload and download work through the existing auth flow (session/token)

## References

- `apps/api/src/routes/projects/files.ts` — existing file proxy routes
- `apps/api/src/routes/transcribe.ts` — multipart parsing pattern
- `apps/api/src/routes/projects/_helpers.ts` — path validation
- `packages/vm-agent/internal/server/files.go` — file browser handlers
- `packages/vm-agent/internal/server/git.go` — file serving, sanitizeFilePath, execInContainer
- `packages/vm-agent/internal/server/server.go:722-791` — route registration
- `packages/vm-agent/internal/config/config.go` — config struct and loading
- `packages/vm-agent/internal/bootstrap/bootstrap.go` — volume setup
- `apps/web/src/components/chat/ProjectMessageView.tsx` — chat input (FollowUpInput)
- `apps/web/src/components/chat/ChatFilePanel.tsx` — file browser
- `apps/web/src/lib/api.ts` — API client functions
