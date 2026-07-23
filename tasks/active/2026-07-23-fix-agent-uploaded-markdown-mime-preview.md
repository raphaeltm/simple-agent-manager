# Fix agent-uploaded text/markdown files landing as `application/octet-stream` (library preview broken)

- **SAM task**: `01KY81Z9YY9X2RHGNG88Y45TMX`
- **Output branch**: `sam/fix-agent-uploaded-textmarkdown-y45tmx`
- **Date**: 2026-07-23
- **Staging**: INTENTIONALLY SKIPPED per explicit human instruction (policy: "Skip staging when explicitly requested for /do work"). Evidence = local tests + `pnpm` quality suite + `go test ./...` + Phase 5 specialist reviewers + green CI.

## Problem

Agent-uploaded `.md`/`.txt`/`.yaml`/etc. files land in the project file library with
`mimeType = application/octet-stream`. Both the web preview predicates and the API
`/preview` endpoint gate strictly on the stored MIME type, so those files never preview
(and the API refuses to serve them as their real type). Browser-uploaded files are
unaffected because that path uses the browser-provided `file.type`.

### Root cause (verified during research)

The library `mimeType` is whatever `Content-Type` the vm-agent's file-download endpoint
returns. The vm-agent derives that via Go's `mime.TypeByExtension(...)`.

- Go's `mime` package sets a **built-in** table first (`initMime` → `setMimeTypes(builtinTypesLower,…)`),
  then loads the OS mime DB (`/etc/mime.types`, `media-types` package). The built-in table
  covers `.html/.htm/.png/.jpg/.jpeg/.gif/.svg/.pdf/.json/.xml/.css/.js/.webp/.wasm` — but
  NOT `.md/.markdown/.txt/.log/.yaml/.yml/.toml/.csv/.avif`.
- On the **cf-container Instant runtime** the vm-agent runs inside a minimal Debian 12 image
  with **no `/etc/mime.types` and no `media-types` package**, so `.md` etc. resolve to empty
  → the handler falls back to `application/octet-stream`.
- A full Ubuntu VM node happens to ship `media-types`, so `.md` resolved correctly there.
  This bug only started biting when sessions moved to Instant containers.

Flow: `upload_to_library` (MCP) → `downloadFromWorkspace()` → GET `/workspaces/:id/files/download`
(`handleFileDownload`, `file_transfer.go`) → returns `Content-Type: application/octet-stream`
→ `library-tools.ts` stores that as `mimeType` → web + API preview gates reject it.

### Verified code anchors (2026-07-23)

- vm-agent download Content-Type (octet-stream fallback): `packages/vm-agent/internal/server/file_transfer.go:315-322` (`handleFileDownload`, the `upload_to_library` path).
- vm-agent raw Content-Type (same pattern): `packages/vm-agent/internal/server/files.go:301-306` (`handleFileRaw`, web file browser). Preserves `X-Content-Type-Options: nosniff` (`:314`) + SVG CSP (`:316-319`).
- MCP upload stores the download Content-Type as the library mimeType: `apps/api/src/routes/mcp/library-tools.ts:223` (`downloadFromWorkspace`) → `:421` (`upload_to_library`) / `:566` (`replace_library_file`).
- Web preview predicates + previewable set: `apps/web/src/lib/file-utils.ts:1-57`; modal branch selection `apps/web/src/components/library/FilePreviewModal.tsx:48-51`; also `FileGridCard.tsx:22`, `FileListItem.tsx:34`, `FileActionsMenu.tsx:84`, and chat card `project-message-view/tool-cards/DocumentCard.tsx:59-61`.
- API preview gate + serve headers: `apps/api/src/routes/library.ts:288-297` (`PREVIEWABLE_MIMES`), `:308-313` (gate), `:336-343` (HTML→`text/plain` + CSP).
- `mime` is used in `files.go` ONLY at `:303` (safe to drop the import after refactor); `file_transfer.go` still uses `mime.ParseMediaType` for uploads (keep import).

## Fix — two layers (both in this PR)

### Layer 1 — root cause, vm-agent (Go), independent of host mime DB

- CREATE `packages/vm-agent/internal/server/content_type.go`: a single shared
  `resolveContentType(filename)` used by BOTH `file_transfer.go` and `files.go`:
  1. try `mime.TypeByExtension` (Go built-in table + any OS mime DB),
  2. curated in-process fallback map for text/doc extensions Go's built-in misses,
  3. `application/octet-stream`.
  Fallback covers: `.md`/`.markdown`→`text/markdown`, `.txt`/`.log`→`text/plain`,
  `.yaml`/`.yml`→`application/yaml`, `.toml`→`application/toml`, `.csv`→`text/csv`,
  `.json`→`application/json`, `.xml`→`application/xml` (curated static table — NOT a
  Principle XI hardcoded value).
- MODIFY `file_transfer.go` `handleFileDownload`: use `resolveContentType(fileName)` after
  the existing CRLF-strip. MODIFY `files.go` `handleFileRaw`: use `resolveContentType(...)`,
  drop the now-unused `mime` import, preserve `nosniff` + SVG CSP.

### Layer 2 — defense-in-depth + fixes ALREADY-stored files (web + API), no re-upload

- CREATE `packages/shared/src/mime.ts` (DRY, used by web AND API):
  `normalizeMimeType`, `isUnknownMimeType`, `mimeTypeFromFilename` (curated extension map),
  `resolveEffectiveMimeType(storedMime, filename)` → returns the stored type when meaningful,
  else the filename-extension type, else octet-stream. Re-export from `packages/shared/src/index.ts`.
- MODIFY `apps/web/src/lib/file-utils.ts`: predicates accept an optional `filename` and use
  `resolveEffectiveMimeType`; thread `file.filename` through `FileGridCard`, `FileListItem`,
  `FileActionsMenu`, `FilePreviewModal`, `DocumentCard`. `baseMimeType` delegates to shared
  `normalizeMimeType`.
- MODIFY `apps/api/src/routes/library.ts` `/preview`: compute the effective type from the
  filename when the stored mime is octet-stream/empty, so the endpoint (a) passes the
  previewable gate and (b) serves the correct Content-Type. **Security: the effective type
  flows through the SAME `text/html`→`text/plain` + `default-src 'none'` CSP path; SVG stays
  non-previewable (rejected). No sniffed HTML/SVG is ever served unsandboxed.** Download route
  is left as-is (attachment + `nosniff` is already safe).

## Regression tests (rule 02 — the test that would have caught this)

- Go: `content_type_test.go` table test — `.md`→text/markdown, `.txt`→text/plain, `.yaml`→…,
  and a direct `fallbackContentType(...)` test proving the fallback does NOT depend on the host
  `/etc/mime.types` (discriminating; passes on a machine with no media-types installed).
- Shared: `packages/shared/tests/unit/mime.test.ts` — `resolveEffectiveMimeType` fallback,
  precedence (real stored type wins), unknown-extension → octet-stream.
- Web: `file-utils.test.ts` — `isMarkdownMime`/`isPreviewableMime` true for
  `{ mimeType: 'application/octet-stream', filename: 'foo.md' }`, false for octet-stream with no
  known extension; `FilePreviewModal`/`DocumentCard` behavioral test renders the markdown branch
  for an octet-stream `.md` file.
- API: `library.test.ts` — preview serves `text/markdown` (passes the gate) for octet-stream +
  `.md`; octet-stream `.html`/`.svg` still sandboxed/rejected (no security regression);
  octet-stream with no known extension still 400.

## Process fix (rule 02)

- CREATE `.claude/rules/51-vm-agent-no-host-mime-dependency.md`: vm-agent behavior affecting
  product output MUST NOT depend on host-provided mime databases or OS-specific files that
  differ between the Ubuntu VM host and the minimal cf-container image; register needed
  mappings in-process.

## Implementation checklist

- [ ] Layer 1: `content_type.go` shared resolver + fallback map
- [ ] Layer 1: wire `file_transfer.go` (`handleFileDownload`) to the resolver (keep CRLF strip)
- [ ] Layer 1: wire `files.go` (`handleFileRaw`) to the resolver, drop `mime` import, keep nosniff/SVG CSP
- [ ] Layer 1: `content_type_test.go` (table + host-independent fallback proof)
- [ ] Layer 2: `packages/shared/src/mime.ts` + index re-export
- [ ] Layer 2: shared `mime.test.ts`
- [ ] Layer 2: `file-utils.ts` predicates take optional filename + delegate to shared
- [ ] Layer 2: thread filename through FileGridCard / FileListItem / FileActionsMenu / FilePreviewModal / DocumentCard
- [ ] Layer 2: `library.ts` `/preview` effective-type gate + serve (preserve HTML/SVG safety)
- [ ] Layer 2: `file-utils.test.ts` octet-stream + filename cases
- [ ] Layer 2: FilePreviewModal + DocumentCard behavioral octet-stream `.md` tests
- [ ] Layer 2: `library.test.ts` octet-stream `.md` serves text/markdown; `.html`/`.svg` still safe; unknown-ext 400
- [ ] Process fix rule `51-*`
- [ ] `go test ./...` (vm-agent), `pnpm lint && typecheck && test && build`
- [ ] task-completion-validator + Phase 5 specialist reviewers
- [ ] PR with Post-Mortem + explicit "staging skipped per human instruction" + note that Layer 1 (binary) can't be runtime-verified pre-merge

## Acceptance criteria

- [ ] vm-agent `/files/download` + `/files/raw` return `text/markdown` (not octet-stream) for `.md` on a host WITHOUT `/etc/mime.types` (proven by the Go fallback test).
- [ ] An already-stored library file with `mimeType=application/octet-stream` + filename `.md` previews as markdown in the web UI (predicates + modal) — no re-upload.
- [ ] The API `/preview` route serves `text/markdown` and passes the previewable gate for that same file.
- [ ] Octet-stream `.html` is still served as inert `text/plain` with `default-src 'none'` CSP; octet-stream `.svg` is still rejected — no security regression.
- [ ] Process-fix rule added under `.claude/rules/`.

## Notes / risk

- Layer 1 is a vm-agent binary change; full end-to-end runtime verification (a fresh node
  downloading the new binary) is not possible pre-merge because staging is skipped. Called out
  in the PR. Layer 2 (web + API) is fully unit-testable locally and is what makes the
  already-uploaded files previewable — that is the user-visible fix.
- Existing octet-stream markdown fixtures live in this project's library under `/engineering/byo-nodes/`.
