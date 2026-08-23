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

### DO Storage Model (revised after review)

The first cut widened the existing `comment_threads` table (migration 032) to
accept a `library_file` anchor. That required relaxing `CHECK (anchor_kind =
'message')` and dropping `NOT NULL` on `message_id` / `session_id`. SQLite
supports neither `ALTER ... CHECK` nor removing `NOT NULL`, so it meant
recreating `comment_threads` plus both of its `ON DELETE CASCADE` children.

**That approach was rejected in review.** Durable Object SQLite has no
time-travel recovery, so a table drop there is unrecoverable — `pnpm
quality:do-migration-safety` blocks it (rule 31). It also had a second-order
cost: making `session_id` nullable forced `getCommentThread` to drop its
`sessionId` parameter, which silently removed the session-ownership check from
reply/resolve/reopen.

**Final design: separate tables.** Migration 033 is purely additive and creates
`library_file_comment_threads` / `_replies` / `_status_mutations`. Message
comment storage and code are untouched, so session isolation holds by
construction. The two anchor kinds are unified at the type layer
(`CommentAnchor`), not in storage. Future anchor kinds extend the library-file
tables additively rather than widening the message tables.

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

- [x] Add `LibraryFileCommentAnchor` type: `{ kind: 'library_file'; fileId: string; quote: string | null }`
- [x] Add `CommentAnchor = MessageCommentAnchor | LibraryFileCommentAnchor` union
- [x] Add `LibraryFileCommentThread` type (same shape as `MessageCommentThread` but `sessionId` optional, anchor is `CommentAnchor`)
- [x] Add `LibraryFileCommentListResponse` type
- [x] Add `CreateLibraryFileCommentThreadRequest` type

### DO Migration (`apps/api/src/durable-objects/migrations.ts`)

- [x] Add migration 033: additive `CREATE TABLE IF NOT EXISTS` for three new library-file comment tables (supersedes the table-recreation plan below)
  - `anchor_kind CHECK (anchor_kind IN ('message', 'library_file'))`
  - `message_id TEXT` (nullable)
  - `session_id TEXT` (nullable, FK still references chat_sessions but nullable now)
  - Add `file_id TEXT` column
  - Add compound CHECK: `(anchor_kind = 'message' AND message_id IS NOT NULL AND session_id IS NOT NULL) OR (anchor_kind = 'library_file' AND file_id IS NOT NULL)`
  - Recreate indexes including new `idx_comment_threads_file` on `(file_id, sequence)`
  - Child tables: make `session_id` nullable, preserve CASCADE FKs
  - UNIQUE constraints: `(session_id, client_mutation_id)` for message threads, `(file_id, client_mutation_id)` for file threads — use a single UNIQUE on `(anchor_kind, COALESCE(session_id,''), COALESCE(file_id,''), client_mutation_id)` or two partial indexes

### DO Implementation (`apps/api/src/durable-objects/project-data/comments.ts`)

- [x] Add `ensureFileAnchor()` — validates file_id is a non-empty string (actual file existence checked in route)
- [x] Update `ThreadRowSchema` — make `session_id` and `message_id` optional in valibot schema
- [x] Update `mapThread()` — read `anchor_kind` from row, return correct anchor union
- [x] Update `createCommentThread()` — accept file anchor input, INSERT with anchor_kind='library_file', file_id, null session_id/message_id
- [x] Update `listCommentThreads()` — support `fileId` filter, don't require `sessionId` for file threads
- [x] Update `readThreadRows()` — conditional WHERE clause based on filter type
- [x] Update `hydrateThreads()` — handle optional sessionId
- [x] Update `getCommentThread()` — handle optional sessionId (use threadId + projectId instead)

### DO Contracts (`apps/api/src/durable-objects/project-data/comment-contracts.ts`)

- [x] Add `CreateFileCommentThreadInput` — `{ fileId: string; body: string; quote?: string | null; clientMutationId?: string | null; actor: CommentActor }`
- [x] Extend `ListCommentThreadsInput` — make `sessionId` optional, add `fileId?: string | null`, add `anchorKind?: 'message' | 'library_file' | null`
- [x] Add `'Library file'` to `CommentNotFoundError` resource union
- [x] Update `CreateCommentThreadInput` to be `CreateMessageCommentThreadInput` (rename for clarity) or use a union

### API Routes (`apps/api/src/routes/`)

- [x] Create `library-comments.ts` route file
  - `GET /api/projects/:projectId/library/:fileId/comments` — list file comment threads
  - `POST /api/projects/:projectId/library/:fileId/comments` — create file comment thread
  - `POST .../comments/:threadId/replies` — reply (reuse existing reply logic)
  - `POST .../comments/:threadId/resolve` — resolve
  - `POST .../comments/:threadId/reopen` — reopen
  - File existence check: query D1 `project_files` before calling DO
  - Auth: `requireProjectCapability(db, projectId, userId, 'task:read'/'task:write')`
- [x] Mount in `apps/api/src/index.ts` under library routes or directly on `app`

### API Schemas (`apps/api/src/schemas/comments.ts`)

- [x] Add `CreateLibraryFileCommentThreadSchema` — `{ body: string, quote?: string | null, clientMutationId?: string | null }`

### Project Data Service (`apps/api/src/services/project-data.ts`)

- [x] Add `listFileCommentThreads()` — calls DO with fileId filter
- [x] Add `createFileCommentThread()` — calls DO with file anchor input

### Frontend API Client (`apps/web/src/lib/api/comments.ts`)

- [x] Add `LibraryFileCommentAnchor` type: `{ kind: 'library_file'; fileId: string; quote?: string | null }`
- [x] Add `CommentAnchor = MessageCommentAnchor | LibraryFileCommentAnchor` union
- [x] Add `LibraryFileCommentThread` type (mirrors backend, sessionId optional)
- [x] Add `listLibraryFileComments(projectId, fileId, signal?)` function
- [x] Add `createLibraryFileCommentThread(projectId, fileId, data)` function
- [x] Add `createLibraryFileCommentReply(projectId, fileId, threadId, data)` function
- [x] Add `resolveLibraryFileComment(projectId, fileId, threadId)` function
- [x] Add `reopenLibraryFileComment(projectId, fileId, threadId)` function
- [x] Generalize `mapBackendMessageCommentThread` to handle both anchor kinds

### Frontend Query Options (`apps/web/src/lib/query-options.ts` or similar)

- [x] Add `libraryFileCommentQueryKeys` factory
- [x] Add `libraryFileCommentsQueryOptions(projectId, fileId)` for TanStack Query

### Frontend Hook (`apps/web/src/components/library/`)

- [x] Create `useLibraryFileComments.ts` hook using TanStack Query
  - `useQuery` for listing threads
  - `useMutation` for create thread, reply, resolve, reopen
  - Optimistic updates following the pattern in `useMessageComments.ts`
  - Query key includes user identity scope (rule 48)

### Frontend Components (`apps/web/src/components/library/`)

- [x] Create `FileCommentPanel.tsx` — side panel or inline panel listing threads for a file
  - Uses `CommentThread` and `CommentComposer` components
  - Filter by status (open/resolved/all)
  - Thread count badge
- [x] Modify `FilePreviewModal.tsx` — add comment toggle button in header, conditionally render FileCommentPanel
  - When comments are open: split layout (content + panel) on desktop, sheet/overlay on mobile
  - Pass `data-comment-anchor={fileId}` to markdown content container
  - Wire up `useCommentSelection` for text selection → comment creation with quote
- [x] Handle selection popover / action bar positioning within the modal

### MCP Tools (`apps/api/src/routes/mcp/`)

- [x] Add `list_library_file_comment_threads` tool definition
- [x] Add `create_library_file_comment_thread` tool definition
- [x] Add handlers in the MCP comment tools handler file

### Tests

- [x] Unit tests for shared types (anchor union, type guards)
- [x] DO migration test: index count pinned; migration is additive so there is no data to preserve
- [x] DO impl tests: create/list/get file comment threads, ensure file anchor validation
- [x] Integration test: full API route → DO → response for file comments
- [x] Frontend: useLibraryFileComments hook tests (TanStack Query)
- [x] Vertical slice test: API creates file comment thread, lists it, replies, resolves

## Acceptance Criteria

- [x] Users can open a markdown file in FilePreviewModal and leave a comment (no quote selection)
- [x] Users can select text in the markdown preview and create a quoted comment
- [x] File comments appear in a panel within the preview modal
- [x] Replies, resolve, and reopen work on file comments
- [x] File comments persist across modal close/reopen
- [x] File comments are project-scoped, not session-scoped
- [x] Existing message comments continue to work unchanged
- [x] MCP tools can list and create file comment threads
- [x] No horizontal overflow on mobile (375px)

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

## Specialist Review and Rework (2026-08-22 / 2026-08-23)

Seven specialist reviewers ran against the first implementation. The
`task-completion-validator` returned **FAIL**. Everything below was fixed before
the PR was opened.

### CRITICAL

1. **Cross-session isolation regression** (test-engineer). Widening the shared
   table made `session_id` nullable, so `getCommentThread` lost its `sessionId`
   parameter and reply/resolve/reopen stopped enforcing session ownership — any
   project collaborator could mutate another session's message threads. Fixed by
   separating storage: `comments.ts`, `comment-contracts.ts`, the DO index,
   `services/project-data.ts` and `services/message-comments.ts` are restored to
   their `main` versions and extended additively.
2. **Destructive DO migration** (cloudflare-specialist / rule 31). Migration 033
   recreated three tables via backup → drop → re-insert. Replaced with a purely
   additive migration; `pnpm quality:do-migration-safety` passes.

### MEDIUM / HIGH

3. `fileThreadToUi()` forged `{ kind: 'message', messageId: fileId }` to satisfy
   a message-typed prop, defeating the anchor union at the UI boundary. Added
   `UiCommentThread` — the anchor-agnostic subset the presentational components
   actually render — and typed them on it.
4. `verifyFileExists` was duplicated between the HTTP routes and the MCP tools →
   extracted `services/library-file-comments.ts:assertLibraryFileInProject`.
5. `rethrowCommentError` was duplicated from `chat-comments.ts`, and the copy
   was **weaker**: it did not recognise errors that had crossed the DO RPC
   boundary, where the class and `code` field are lost. Every expected 404/400/422
   from the durable object would have surfaced as a 500. Extracted
   `lib/comment-http.ts`; both routers now share one implementation.
6. Redundant `verifyFileExists` D1 round trip on reply/resolve/reopen — removed;
   those reach their thread through a `file_id`-scoped lookup inside the
   project's own DO.
7. Every mutation invalidated the list query on settle, doubling round trips on
   top of an optimistic update that already had the server row. Invalidation now
   runs only on error.
8. Quote selection had never been implemented, despite being in scope. Now wired
   through the existing `useCommentSelection` machinery.

### Found by the new tests

9. `upsertLibraryFileCommentThread` matched on server id only, so the optimistic
   row was never retired and the user saw their own comment twice.
10. A failed create/reply rolled back silently with no feedback, and the
    rejection escaped as an unhandled promise.
11. **The desktop selection popover was unclickable.** It rendered at
    `z-dropdown` (20) inside a modal at `z-dialog-backdrop` (50), so the modal's
    own content intercepted the click. Caught by the Playwright audit at 1280px;
    mobile was unaffected because `SelectionActionBar` already used `z-panel`.

## Second Validator Pass (2026-08-23, post-rework)

`task-completion-validator` re-run against the reworked diff: **PASS**, no
CRITICAL or HIGH findings. It independently re-derived (rather than trusted)
session-isolation restoration, migration additivity, and the quote-selection
wiring, and re-ran both suites itself.

Its three non-blocking findings were fixed in this branch rather than deferred:

- MEDIUM — "unit tests for shared types" was checked off with no artifact. Added
  `packages/shared/tests/comment-anchors.test.ts` (5 tests) covering union
  narrowing, per-variant field exclusivity, null quotes, and a runtime-list ↔
  union-variant parity assertion.
- LOW — dead code: `services/project-data.ts:getFileCommentThread` and the
  matching `ProjectData` RPC method had zero callers (Phase 1 has no
  send-to-agent for files). Removed both; the module-level
  `library-file-comments.ts:getFileCommentThread` stays, since that IS the
  file-scoped ownership guard used by create/reply/status.
- LOW — "comments persist across modal close/reopen" was only covered
  indirectly. Added an explicit close-and-reopen assertion to the Playwright
  audit. On mobile the comment panel is a full-width overlay, so the test closes
  it before the preview, matching the real mobile flow.

Its remaining note — `library-file-comments.ts` at 553 lines, over rule 18's
500-line soft threshold — is left as-is: it is under the 800-line mandatory
threshold, `quality:file-sizes` passes, and it is smaller than the message
equivalent `comments.ts` (698 lines) it mirrors.

## Post-Mortem

**What broke.** The feature was implemented, self-reviewed as complete, and
archived — while carrying a silent authorization regression, an unrecoverable
migration, and a headline capability (quote selection) that was never built. A
desktop user could not have created a quoted comment at all.

**Root cause.** A single design decision — reuse the existing `comment_threads`
table for a second anchor kind — cascaded. Widening the table forced nullable
`session_id`; nullable `session_id` forced the shared getter to drop its scope
parameter; dropping it removed an authorization check nothing tested. Each step
looked like a mechanical consequence of the previous one, so none was
re-evaluated as a decision.

**Why it was not caught earlier.** The plan committed to the shared-table design
in its research phase and never revisited it, so implementation inherited a
premise instead of testing it. There were no HTTP route tests and no
vertical-slice test, so the regression had nowhere to surface. The reviewers did
catch all of it — the process failure was archiving the task before their
findings were addressed.

**Class of bug.** _A schema change that silently relaxes an authorization
predicate._ The dangerous move is widening a table so a scoping column becomes
nullable: every query that scoped on it must now treat it as optional, and the
compiler is satisfied by simply removing the parameter. Nothing is deleted, no
type breaks, and the check evaporates.

**Process fix.** Added `.claude/rules/63-widening-a-table-can-delete-an-auth-check.md`.
