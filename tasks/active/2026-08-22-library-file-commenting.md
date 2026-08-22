# Library File Commenting (Phase 1)

## Problem Statement

Users can comment on chat messages using the message-anchored commenting system (shipped in PR #1882). The same commenting UX should extend to library files viewed in the FilePreviewModal — particularly markdown files. Users should be able to select text in a markdown preview and leave comments, just as they do with chat messages.

Phase 1 delivers file-level comments with quote selection on markdown files. Block-level gutter markers, re-anchoring, send-to-agent, and agent-authored comments are deferred to Phase 2.

## Research Findings

### Anchor Architecture

The existing comment system uses a `MessageCommentAnchor` type (`packages/shared/src/types/comments.ts:39`). The correct approach is to extend this as a discriminated union:

```typescript
type CommentAnchor = MessageCommentAnchor | LibraryFileCommentAnchor;
```

This preserves the existing message comment contract while enabling file comments.

### DO Migration Constraint

The `comment_threads` table (DO migration 032, `apps/api/src/durable-objects/migrations.ts:968`) has:
- `CHECK (anchor_kind = 'message')` — must be widened to allow `'library_file'`
- `message_id TEXT NOT NULL` — must become nullable (file comments have no message)
- `session_id TEXT NOT NULL` — must become nullable (file comments are project-scoped)

SQLite cannot `ALTER CHECK` or `ALTER COLUMN` to remove NOT NULL. Table recreation is required. This is **safe** because:
- `comment_replies` FK: `REFERENCES comment_threads(id) ON DELETE CASCADE` — child table, not parent
- `comment_status_mutations` FK: `REFERENCES comment_threads(id) ON DELETE CASCADE` — child table, not parent
- Both child tables also reference `chat_sessions(id) ON DELETE CASCADE` — their `session_id` columns must also become nullable

Table recreation order: recreate children first (they reference threads), then threads.

### Route Structure

Library file comments need their own route file because:
- They are NOT session-scoped (no `sessionId` in URL)
- They are project+file scoped: `/api/projects/:projectId/library/:fileId/comments`
- They use the same project auth (`requireProjectCapability`) but different URL shape

### Library File Identity

Files are identified by ULID `id` in D1 `project_files` table (not in DO SQLite). The DO must verify the file exists via a D1 query or the caller must verify before calling the DO. Since the DO doesn't have D1 access, file existence validation belongs in the route handler (query D1 for the file row, then call the DO).

### Reusable Components

These frontend components work with any anchor type and need no changes:
- `CommentComposer.tsx` — accepts `onSubmit(body, quote)`
- `CommentThread.tsx` — renders thread with replies, resolve/reopen
- `CommentPrimitives.tsx` — low-level comment UI atoms
- `useCommentSelection.ts` — text selection with `data-comment-anchor` attribute
- `SelectionPopover` / `SelectionActionBar` — selection UI

### Frontend Data Fetching

Existing `useMessageComments.ts` uses TanStack Query (correct pattern per rule 48/60). New `useLibraryFileComments` should follow the same pattern with separate query keys.

## Implementation Checklist

### Shared Types (`packages/shared/`)
- [ ] Add `LibraryFileCommentAnchor` type: `{ kind: 'library_file'; fileId: string; quote: string | null }`
- [ ] Add `CommentAnchor = MessageCommentAnchor | LibraryFileCommentAnchor` union
- [ ] Add `LibraryFileCommentThread` type (same shape as `MessageCommentThread` but `sessionId` optional, anchor is `CommentAnchor`)
- [ ] Add `LibraryFileCommentListResponse` type
- [ ] Add `CreateLibraryFileCommentThreadRequest` type

### DO Migration (`apps/api/src/durable-objects/migrations.ts`)
- [ ] Add migration 033: recreate `comment_threads`, `comment_replies`, `comment_status_mutations` with relaxed constraints
  - `anchor_kind CHECK (anchor_kind IN ('message', 'library_file'))`
  - `message_id TEXT` (nullable)
  - `session_id TEXT` (nullable, FK still references chat_sessions but nullable now)
  - Add `file_id TEXT` column
  - Add compound CHECK: `(anchor_kind = 'message' AND message_id IS NOT NULL AND session_id IS NOT NULL) OR (anchor_kind = 'library_file' AND file_id IS NOT NULL)`
  - Recreate indexes including new `idx_comment_threads_file` on `(file_id, sequence)`
  - Child tables: make `session_id` nullable, preserve CASCADE FKs
  - UNIQUE constraints: `(session_id, client_mutation_id)` for message threads, `(file_id, client_mutation_id)` for file threads — use a single UNIQUE on `(anchor_kind, COALESCE(session_id,''), COALESCE(file_id,''), client_mutation_id)` or two partial indexes

### DO Implementation (`apps/api/src/durable-objects/project-data/comments.ts`)
- [ ] Add `ensureFileAnchor()` — validates file_id is a non-empty string (actual file existence checked in route)
- [ ] Update `ThreadRowSchema` — make `session_id` and `message_id` optional in valibot schema
- [ ] Update `mapThread()` — read `anchor_kind` from row, return correct anchor union
- [ ] Update `createCommentThread()` — accept file anchor input, INSERT with anchor_kind='library_file', file_id, null session_id/message_id
- [ ] Update `listCommentThreads()` — support `fileId` filter, don't require `sessionId` for file threads
- [ ] Update `readThreadRows()` — conditional WHERE clause based on filter type
- [ ] Update `hydrateThreads()` — handle optional sessionId
- [ ] Update `getCommentThread()` — handle optional sessionId (use threadId + projectId instead)

### DO Contracts (`apps/api/src/durable-objects/project-data/comment-contracts.ts`)
- [ ] Add `CreateFileCommentThreadInput` — `{ fileId: string; body: string; quote?: string | null; clientMutationId?: string | null; actor: CommentActor }`
- [ ] Extend `ListCommentThreadsInput` — make `sessionId` optional, add `fileId?: string | null`, add `anchorKind?: 'message' | 'library_file' | null`
- [ ] Add `'Library file'` to `CommentNotFoundError` resource union
- [ ] Update `CreateCommentThreadInput` to be `CreateMessageCommentThreadInput` (rename for clarity) or use a union

### API Routes (`apps/api/src/routes/`)
- [ ] Create `library-comments.ts` route file
  - `GET /api/projects/:projectId/library/:fileId/comments` — list file comment threads
  - `POST /api/projects/:projectId/library/:fileId/comments` — create file comment thread
  - `POST .../comments/:threadId/replies` — reply (reuse existing reply logic)
  - `POST .../comments/:threadId/resolve` — resolve
  - `POST .../comments/:threadId/reopen` — reopen
  - File existence check: query D1 `project_files` before calling DO
  - Auth: `requireProjectCapability(db, projectId, userId, 'task:read'/'task:write')`
- [ ] Mount in `apps/api/src/index.ts` under library routes or directly on `app`

### API Schemas (`apps/api/src/schemas/comments.ts`)
- [ ] Add `CreateLibraryFileCommentThreadSchema` — `{ body: string, quote?: string | null, clientMutationId?: string | null }`

### Project Data Service (`apps/api/src/services/project-data.ts`)
- [ ] Add `listFileCommentThreads()` — calls DO with fileId filter
- [ ] Add `createFileCommentThread()` — calls DO with file anchor input

### Frontend API Client (`apps/web/src/lib/api/comments.ts`)
- [ ] Add `LibraryFileCommentAnchor` type: `{ kind: 'library_file'; fileId: string; quote?: string | null }`
- [ ] Add `CommentAnchor = MessageCommentAnchor | LibraryFileCommentAnchor` union
- [ ] Add `LibraryFileCommentThread` type (mirrors backend, sessionId optional)
- [ ] Add `listLibraryFileComments(projectId, fileId, signal?)` function
- [ ] Add `createLibraryFileCommentThread(projectId, fileId, data)` function
- [ ] Add `createLibraryFileCommentReply(projectId, fileId, threadId, data)` function
- [ ] Add `resolveLibraryFileComment(projectId, fileId, threadId)` function
- [ ] Add `reopenLibraryFileComment(projectId, fileId, threadId)` function
- [ ] Generalize `mapBackendMessageCommentThread` to handle both anchor kinds

### Frontend Query Options (`apps/web/src/lib/query-options.ts` or similar)
- [ ] Add `libraryFileCommentQueryKeys` factory
- [ ] Add `libraryFileCommentsQueryOptions(projectId, fileId)` for TanStack Query

### Frontend Hook (`apps/web/src/components/library/`)
- [ ] Create `useLibraryFileComments.ts` hook using TanStack Query
  - `useQuery` for listing threads
  - `useMutation` for create thread, reply, resolve, reopen
  - Optimistic updates following the pattern in `useMessageComments.ts`
  - Query key includes user identity scope (rule 48)

### Frontend Components (`apps/web/src/components/library/`)
- [ ] Create `FileCommentPanel.tsx` — side panel or inline panel listing threads for a file
  - Uses `CommentThread` and `CommentComposer` components
  - Filter by status (open/resolved/all)
  - Thread count badge
- [ ] Modify `FilePreviewModal.tsx` — add comment toggle button in header, conditionally render FileCommentPanel
  - When comments are open: split layout (content + panel) on desktop, sheet/overlay on mobile
  - Pass `data-comment-anchor={fileId}` to markdown content container
  - Wire up `useCommentSelection` for text selection → comment creation with quote
- [ ] Handle selection popover / action bar positioning within the modal

### MCP Tools (`apps/api/src/routes/mcp/`)
- [ ] Add `list_library_file_comment_threads` tool definition
- [ ] Add `create_library_file_comment_thread` tool definition
- [ ] Add handlers in the MCP comment tools handler file

### Tests
- [ ] Unit tests for shared types (anchor union, type guards)
- [ ] DO migration test: verify table recreation preserves data, new columns work
- [ ] DO impl tests: create/list/get file comment threads, ensure file anchor validation
- [ ] Integration test: full API route → DO → response for file comments
- [ ] Frontend: useLibraryFileComments hook tests (TanStack Query)
- [ ] Vertical slice test: API creates file comment thread, lists it, replies, resolves

## Acceptance Criteria

- [ ] Users can open a markdown file in FilePreviewModal and leave a comment (no quote selection)
- [ ] Users can select text in the markdown preview and create a quoted comment
- [ ] File comments appear in a panel within the preview modal
- [ ] Replies, resolve, and reopen work on file comments
- [ ] File comments persist across modal close/reopen
- [ ] File comments are project-scoped, not session-scoped
- [ ] Existing message comments continue to work unchanged
- [ ] MCP tools can list and create file comment threads
- [ ] No horizontal overflow on mobile (375px)

## References

- SAM idea: `01M0N1250YESBW2R497KXDZVSC`
- Prior art (message commenting): PR #1882
- Existing commenting idea (updated): `01M0JQB842XSJ3W172DYPB37HN`
- Shared types: `packages/shared/src/types/comments.ts`
- DO comments impl: `apps/api/src/durable-objects/project-data/comments.ts`
- DO migration 032: `apps/api/src/durable-objects/migrations.ts:968`
- Frontend API client: `apps/web/src/lib/api/comments.ts`
- FilePreviewModal: `apps/web/src/components/library/FilePreviewModal.tsx`
- Comment components: `apps/web/src/components/project-message-view/comments/`
