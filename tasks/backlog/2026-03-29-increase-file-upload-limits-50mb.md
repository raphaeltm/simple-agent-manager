# Increase File Upload Size Limits to 50MB

## Problem

The per-file upload limit is currently 10MB (`FILE_UPLOAD_MAX_BYTES`). Users need to upload larger files (up to 50MB). All related size limits across the stack must be raised to support 50MB files end-to-end.

## Research Findings

### VM Agent (`packages/vm-agent/internal/config/config.go`)

| Setting | Current Default | New Default |
|---------|----------------|-------------|
| `FILE_UPLOAD_MAX_BYTES` (line 342) | 10MB | **50MB** |
| `FILE_UPLOAD_BATCH_MAX_BYTES` (line 343) | 50MB | **250MB** |
| `FILE_RAW_MAX_SIZE` (line 338) | 25MB | **50MB** |
| `FILE_DOWNLOAD_MAX_BYTES` (line 346) | 50MB | 50MB (already sufficient) |
| `FILE_UPLOAD_TIMEOUT` (line 344) | 60s | **120s** (larger files need more time) |
| `FILE_DOWNLOAD_TIMEOUT` (line 345) | 30s | **60s** |
| `FILE_RAW_TIMEOUT` (line 339) | 30s | **60s** |

Comments on struct fields (lines 158-166) also reference old defaults.

### API Worker (`apps/api/src/routes/projects/files.ts`)

| Setting | Current Default | New Default |
|---------|----------------|-------------|
| `DEFAULT_FILE_RAW_PROXY_MAX_BYTES` (line 20) | 25MB | **50MB** |
| `DEFAULT_FILE_UPLOAD_BATCH_MAX_BYTES` (line 22) | 50MB | **250MB** |
| `DEFAULT_FILE_DOWNLOAD_MAX_BYTES` (line 28) | 50MB | 50MB (already sufficient) |
| `DEFAULT_FILE_UPLOAD_TIMEOUT_MS` (line 24) | 60000 | **120000** |
| `DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS` (line 26) | 30000 | **60000** |

### API Env interface (`apps/api/src/index.ts` lines 372-381)

Comment defaults reference old values — update comments for `FILE_RAW_PROXY_MAX_BYTES` (25MB→50MB).

### Web UI (`apps/web/src/lib/file-utils.ts`)

| Setting | Current Default | Decision |
|---------|----------------|----------|
| `VITE_FILE_PREVIEW_INLINE_MAX_BYTES` (line 18) | 10MB | Keep as-is (UX: auto-rendering 50MB images is bad) |
| `VITE_FILE_PREVIEW_LOAD_MAX_BYTES` (line 25) | 25MB | Raise to **50MB** (must match raw max for click-to-load) |

### Tests

- `apps/web/tests/unit/lib/file-utils.test.ts` lines 72-73: asserts default values — update `FILE_PREVIEW_LOAD_MAX_BYTES` assertion.

### Documentation

- `apps/api/.env.example` lines 287-301: multiple default values documented
- `apps/www/src/content/docs/docs/reference/configuration.md` lines 243-258, 276-277: config reference tables
- `apps/www/src/content/docs/docs/guides/chat-features.md` line 40: "10 MB" user-facing doc
- `packages/vm-agent/.env.example` lines 48-49: raw file config reference
- `CLAUDE.md`: mentions defaults in recent changes section

## Implementation Checklist

- [ ] **VM Agent config** — Update defaults in `config.go`:
  - `FILE_UPLOAD_MAX_BYTES`: 10MB → 50MB
  - `FILE_UPLOAD_BATCH_MAX_BYTES`: 50MB → 250MB
  - `FILE_RAW_MAX_SIZE`: 25MB → 50MB
  - `FILE_UPLOAD_TIMEOUT`: 60s → 120s
  - `FILE_DOWNLOAD_TIMEOUT`: 30s → 60s
  - `FILE_RAW_TIMEOUT`: 30s → 60s
  - Update struct field comments (lines 158-166)
- [ ] **API Worker** — Update defaults in `files.ts`:
  - `DEFAULT_FILE_RAW_PROXY_MAX_BYTES`: 25MB → 50MB
  - `DEFAULT_FILE_UPLOAD_BATCH_MAX_BYTES`: 50MB → 250MB
  - `DEFAULT_FILE_UPLOAD_TIMEOUT_MS`: 60000 → 120000
  - `DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS`: 30000 → 60000
- [ ] **API Env interface** — Update comments in `index.ts` for changed defaults
- [ ] **Web UI** — Update `file-utils.ts`:
  - `VITE_FILE_PREVIEW_LOAD_MAX_BYTES`: 25MB → 50MB
  - Update comment text
- [ ] **Tests** — Update `file-utils.test.ts` assertion for `FILE_PREVIEW_LOAD_MAX_BYTES`
- [ ] **Documentation updates** (same commit):
  - `apps/api/.env.example`: update all changed default values
  - `packages/vm-agent/.env.example`: update raw file default comment
  - `apps/www/src/content/docs/docs/reference/configuration.md`: update all tables
  - `apps/www/src/content/docs/docs/guides/chat-features.md`: update "10 MB" → "50 MB"
  - `apps/web/.env.example`: update preview load threshold
  - `CLAUDE.md`: update recent changes references if needed

## Acceptance Criteria

- [ ] `FILE_UPLOAD_MAX_BYTES` defaults to 50MB (52428800)
- [ ] `FILE_UPLOAD_BATCH_MAX_BYTES` defaults to 250MB (262144000)
- [ ] `FILE_RAW_MAX_SIZE` and `FILE_RAW_PROXY_MAX_BYTES` default to 50MB
- [ ] Timeouts increased proportionally for larger files
- [ ] All limits remain configurable via environment variables
- [ ] All documentation reflects new defaults
- [ ] Tests pass with updated assertions
- [ ] Staging verification: upload a file >10MB successfully
