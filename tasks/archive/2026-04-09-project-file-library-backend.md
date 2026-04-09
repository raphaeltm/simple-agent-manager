# Project File Library — Backend Core

## Problem Statement

Build the backend foundation for a per-project file library that enables users and agents to upload, manage, and retrieve encrypted files associated with a project. This is Part 1 of the feature — shared types, D1 schema, file encryption, library service, and API routes.

## Research Findings

### Existing Patterns
- **Encryption**: `apps/api/src/services/encryption.ts` uses AES-256-GCM via Web Crypto API with base64 encoding. For file encryption, we need envelope encryption (DEK per file, wrapped by platform ENCRYPTION_KEY).
- **Schema**: Drizzle ORM on D1 SQLite. Tables use `text()` for IDs, `integer()` for timestamps. Migrations in `apps/api/src/db/migrations/` — next is `0036`.
- **Shared types**: Domain files in `packages/shared/src/types/` with barrel re-exports in `index.ts`. Constants like `ATTACHMENT_DEFAULTS` follow `{ KEY: value }` pattern with JSDoc noting env var names.
- **Routes**: Hono subrouters with per-route middleware (`requireAuth(), requireApproved()`). Auth via `getUserId(c)`, ownership via `requireOwnedProject()`. Mounted in `index.ts`.
- **R2**: Single `R2` binding in wrangler.toml for agent binaries. Can reuse for library files (different key prefix). `R2Bucket` type available on `Env`.
- **Env**: All configurable limits as optional `string?` on `Env` interface in `apps/api/src/index.ts`.
- **Tests**: Unit tests mock R2 with `vi.fn()`. Integration tests use `@cloudflare/vitest-pool-workers` with Miniflare. Route tests use Hono's `app.fetch()` pattern.

### Key Files
- `apps/api/src/services/encryption.ts` — base encryption pattern
- `apps/api/src/db/schema.ts` — Drizzle schema
- `packages/shared/src/types/task.ts` — ATTACHMENT_DEFAULTS pattern
- `apps/api/src/routes/tasks/upload.ts` — file upload route pattern
- `apps/api/src/index.ts` — Env interface + route mounting
- `apps/api/wrangler.toml` — R2 binding

## Implementation Checklist

### 1. Shared Types
- [ ] Create `packages/shared/src/types/library.ts` with `ProjectFile`, `ProjectFileTag`, request/response types
- [ ] Add `LIBRARY_DEFAULTS` constant with configurable limits
- [ ] Export from `packages/shared/src/types/index.ts`
- [ ] Build shared package

### 2. D1 Migration
- [ ] Create `apps/api/src/db/migrations/0036_project_file_library.sql` with `project_files`, `project_file_tags` tables
- [ ] Add indexes for common queries (project_id, status, upload_source)

### 3. Drizzle Schema
- [ ] Add `projectFiles` and `projectFileTags` tables to `apps/api/src/db/schema.ts`

### 4. Env Interface
- [ ] Add `LIBRARY_UPLOAD_MAX_BYTES`, `LIBRARY_MAX_FILES_PER_PROJECT`, `LIBRARY_MAX_TAGS_PER_FILE`, `LIBRARY_DOWNLOAD_TIMEOUT_MS` to Env interface

### 5. File Encryption Service
- [ ] Create `apps/api/src/services/file-encryption.ts` with envelope encryption (DEK per file, wrapped by KEK)
- [ ] `encryptFile()` — generate DEK, encrypt data, wrap DEK with ENCRYPTION_KEY
- [ ] `decryptFile()` — unwrap DEK, decrypt data
- [ ] Unit tests for encrypt/decrypt round-trip

### 6. File Library Service
- [ ] Create `apps/api/src/services/file-library.ts` with CRUD operations
- [ ] `uploadFile()` — encrypt + R2 put + D1 insert
- [ ] `replaceFile()` — encrypt + R2 overwrite + D1 update
- [ ] `listFiles()` — query with filters (tag, type, source), sorting, pagination
- [ ] `getFile()` — metadata lookup
- [ ] `downloadFile()` — R2 get + decrypt
- [ ] `deleteFile()` — R2 delete + D1 delete
- [ ] `updateTags()` — add/remove tags with validation
- [ ] Unit tests for service functions

### 7. API Routes
- [ ] Create `apps/api/src/routes/library.ts` with all endpoints
- [ ] `POST /upload` — multipart upload
- [ ] `PUT /:fileId/replace` — replace file content
- [ ] `GET /` — list with filters
- [ ] `GET /:fileId` — metadata
- [ ] `GET /:fileId/download` — decrypt + stream
- [ ] `DELETE /:fileId` — delete
- [ ] `POST /:fileId/tags` — manage tags
- [ ] Mount at `/api/projects/:projectId/library` in index.ts
- [ ] Route-level auth (requireAuth, requireApproved, requireOwnedProject)

### 8. Wrangler & Config
- [ ] Verify R2 binding exists (reuse existing `R2` binding with `library/` key prefix)
- [ ] No new wrangler binding needed — reuse existing R2

### 9. Quality
- [ ] All limits configurable via env vars
- [ ] Integration tests for routes
- [ ] Contract tests for R2 key construction
- [ ] Typecheck passes
- [ ] Lint passes

## Acceptance Criteria
- [ ] File upload (multipart) creates encrypted R2 object + D1 metadata
- [ ] File download decrypts and streams the file correctly
- [ ] File replace updates content while preserving metadata
- [ ] File delete removes both R2 object and D1 record
- [ ] Tag CRUD works with validation (max tags, pattern enforcement)
- [ ] List files supports filtering by tag, mime type, upload source, with pagination
- [ ] All limits configurable via environment variables
- [ ] Encrypt/decrypt round-trip test passes with realistic data
- [ ] Project ownership enforced on all endpoints
- [ ] R2 key pattern is `library/{projectId}/{fileId}/{filename}`

## References
- Task spec in user prompt
- `apps/api/src/services/encryption.ts`
- `packages/shared/src/types/task.ts` (ATTACHMENT_DEFAULTS pattern)
