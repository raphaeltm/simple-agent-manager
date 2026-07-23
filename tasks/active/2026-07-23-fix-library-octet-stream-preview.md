# Fix: agent-uploaded text/markdown files stored as `application/octet-stream` won't preview

**Date:** 2026-07-23
**Status:** active
**Constraint:** SKIP STAGING — Raphaël explicitly instructed this task skips staging deploy + verification. Evidence = local tests, `pnpm typecheck/lint/build`, `go test ./...`, `/do` Phase 5 specialist reviewers, green CI. Merge authorized via `/do` Phase 7 **only if** CI green + no unresolved CRITICAL/HIGH review findings.

## Problem

When an agent uploads a text/markdown file into the project file library (via the
`upload_to_library` MCP tool), the file lands with `mimeType = application/octet-stream`.
The library preview (web modal + API `/preview` endpoint) gates strictly on the MIME
type, so the file **refuses to render** — the user can only download it. Browser-uploaded
files are unaffected because that path uses the browser-provided `file.type`.

### Root cause (verified in code)

The library `mimeType` is whatever `Content-Type` the vm-agent's file-download endpoint
returns. The vm-agent derives that via Go's `mime.TypeByExtension(...)`, which depends on
the host's `/etc/mime.types`. On the **cf-container Instant runtime** the vm-agent runs
inside a minimal Debian 12 image that has **no `/etc/mime.types`** and no `media-types`
package, so `.md`/`.txt`/`.yaml`/etc. resolve to empty and fall back to
`application/octet-stream`. `upload_to_library` stores that as the library `mimeType`, and
both the web preview and the API preview endpoint gate strictly on the MIME type, so the
file never previews. Full-Ubuntu VM nodes ship `media-types`, which is why this only
started biting when sessions moved to Instant containers.

**Class of bug:** vm-agent behavior that silently changes with the runtime/base image
(depends on a host-provided OS file). Go's built-in MIME table covers `.json/.xml/.svg/.pdf/.png/...`
but **not** `.md/.markdown/.txt/.log/.yaml/.yml/.toml/.csv`, so exactly those break on a
minimal container.

### Verified code anchors

- vm-agent download Content-Type fallback → octet-stream:
  - `packages/vm-agent/internal/server/file_transfer.go:315-322` (`handleFileDownload`)
  - `packages/vm-agent/internal/server/files.go:301-306` (`handleFileRaw`) — also has SVG CSP at `:316-319` and `nosniff` at `:314`.
- MCP upload stores the download Content-Type as the library `mimeType`:
  - `apps/api/src/routes/mcp/library-tools.ts:223` (reads `Content-Type` header), `:421` (`handleUploadToLibrary`), `:566` (`handleReplaceLibraryFile`).
- Web preview predicates + previewable set: `apps/web/src/lib/file-utils.ts:1-57` (`baseMimeType`, `isPreviewableMime`, `isMarkdownMime`, `isHtmlMime`, `isPreviewableImageMime`, `isPdfMime`, `PREVIEWABLE_MIMES`).
  - Consumers: `FilePreviewModal.tsx:48-51`, `FileGridCard.tsx:22`, `FileListItem.tsx:34`, `FileActionsMenu.tsx:84`, `DocumentCard.tsx:59-61` (chat tool card).
- API preview/serve route gates on MIME + sets response Content-Type: `apps/api/src/routes/library.ts:299-357` (`PREVIEWABLE_MIMES.has(...)` at `:311`; neutralization: HTML → `text/plain` at `:336-338`, CSP at `:339-343`).
- Web HTML sandboxing (must NOT be weakened): `apps/web/src/components/shared-file-viewer/HtmlViewer.tsx` (DOMPurify sanitize + sandboxed iframe srcDoc + CSP meta). API preview serves HTML as `text/plain; charset=utf-8` with CSP `default-src 'none'`; SVG is **not** in `PREVIEWABLE_MIMES` (never previews).

## Fix — two layers (both in this PR)

### Layer 1 — root cause (vm-agent Go), deterministic regardless of host MIME DB

Add ONE shared, tested helper (`packages/vm-agent/internal/server/mimetype.go`) used by
BOTH `file_transfer.go` and `files.go` that resolves a filename → Content-Type
**independent of `/etc/mime.types`**:

1. A **curated in-process map** (authoritative for common text/doc extensions), checked
   FIRST so behavior is identical on a full Ubuntu host and the minimal cf-container image.
2. `mime.TypeByExtension` for everything else (images/PDF via Go's built-in table).
3. `application/octet-stream` final fallback.

> **Design note — curated map FIRST (deviates from a literal "mime.TypeByExtension first"):**
> Checking the curated map first is what makes the resolver *provably* host-independent
> for the extensions we care about (the stated GOAL) and makes the discriminating test
> possible: with mime-first, on a host that *has* `media-types`, `.md` resolves anyway and
> the fallback map is never exercised, so a test could not distinguish fixed from unfixed
> code (violates Rule 02 "proven discriminating"). Curated-first also yields the exact
> expected values the task lists (e.g. `.xml → application/xml`, which Go's built-in would
> otherwise intercept as `text/xml`). The curated map only contains inert text/doc types,
> so it never shadows a better OS answer for images/PDF.

Curated map (bare types, no charset, to match downstream base-type extraction):
`.md`/`.markdown` → `text/markdown`, `.txt`/`.log` → `text/plain`, `.yaml`/`.yml` →
`application/yaml`, `.toml` → `application/toml`, `.csv` → `text/csv`, `.json` →
`application/json`, `.xml` → `application/xml`.

Preserve existing behavior: CRLF-stripping of the filename in `file_transfer.go` (before
computing the type), and `X-Content-Type-Options: nosniff` + SVG CSP in `files.go`.

### Layer 2 — defense-in-depth + fixes ALREADY-stored files (web + API), no re-upload

Add shared TS helpers to `packages/shared/src/types/library.ts` (imported by both web and
API — DRY): `baseMimeType`, `isUnknownMimeType`, `mimeTypeFromFilename`,
`resolveEffectiveMimeType(mimeType, filename)`. When a stored file's `mimeType` is
`application/octet-stream` (or empty), resolve the effective type from the filename
extension for preview decisions.

- **Web** (`file-utils.ts` + consumers): `isPreviewableMime`/`isMarkdownMime`/`isHtmlMime`/
  `isPreviewableImageMime`/`isPdfMime` accept an optional `filename` and fall back via
  `resolveEffectiveMimeType`. Thread `file.filename` / `fileName` through
  `FilePreviewModal`, `FileGridCard`, `FileListItem`, `FileActionsMenu`, `DocumentCard`.
- **API** (`routes/library.ts` `/preview`): compute `resolveEffectiveMimeType(file.mimeType,
  file.filename)` and use it for BOTH the previewable gate and the served Content-Type, so
  the endpoint passes the gate and serves the correct type (e.g. `text/markdown`).
- **SECURITY (Rule "Fail closed" + File Preview v2):** the effective type MUST flow through
  the EXISTING neutralization branches. Extension-derived `text/html` still serves as
  `text/plain; charset=utf-8` with CSP `default-src 'none'`; extension-derived
  `image/svg+xml` is still excluded from `PREVIEWABLE_MIMES` (rejected). No sniffed HTML/SVG
  is ever served unsandboxed. Do NOT touch the `/download` route's `DANGEROUS_MIMES` path.

## Implementation Checklist

### Layer 1 — vm-agent
- [ ] Add `packages/vm-agent/internal/server/mimetype.go`: `curatedContentTypes` map + `resolveContentType(filename string) string` (curated → `mime.TypeByExtension` → octet-stream).
- [ ] `file_transfer.go handleFileDownload`: replace inline `mime.TypeByExtension`+fallback with `resolveContentType(fileName)` (keep CRLF-strip before the call).
- [ ] `files.go handleFileRaw`: replace inline logic with `resolveContentType(filepath.Base(filePath))` (keep `nosniff` + SVG CSP, which still trigger since `.svg` → `image/svg+xml`).
- [ ] Remove now-unused `mime` import from `files.go`/`file_transfer.go` if no longer referenced.

### Layer 2 — shared + web + API
- [ ] `packages/shared/src/types/library.ts`: add `baseMimeType`, `isUnknownMimeType`, internal `EXTENSION_TO_MIME`, `mimeTypeFromFilename`, `resolveEffectiveMimeType`.
- [ ] `apps/web/src/lib/file-utils.ts`: import shared helpers; `baseMimeType` re-exported from shared (source of truth); predicates accept optional `filename` and use `resolveEffectiveMimeType`.
- [ ] Thread filename: `FilePreviewModal.tsx`, `FileGridCard.tsx`, `FileListItem.tsx`, `FileActionsMenu.tsx`, `DocumentCard.tsx`.
- [ ] `apps/api/src/routes/library.ts` `/preview`: compute effective mime; gate + serve with it; preserve HTML→text/plain + CSP neutralization and SVG rejection.

### Tests (Rule 02 — the test that would have caught this)
- [ ] Go `mimetype_test.go`: table test (`.md`→text/markdown, `.txt`→text/plain, `.yaml`→application/yaml, `.toml`→application/toml, `.csv`→text/csv, `.json`→application/json, `.xml`→application/xml, `.markdown`, `.log`), unknown→octet-stream, non-curated known ext via builtin (`.png`→image/png), case-insensitive. **Discriminating host-independence test:** `mime.AddExtensionType(".md", "application/x-poisoned")` then assert `resolveContentType("x.md") == "text/markdown"` (proves curated map beats the host MIME DB).
- [ ] Shared unit test: `resolveEffectiveMimeType`/`mimeTypeFromFilename`/`isUnknownMimeType` (octet-stream `.md` → text/markdown; real binary no-ext → unchanged; non-octet mime is preserved verbatim; `.svg` → image/svg+xml but not previewable).
- [ ] Web `file-utils.test.ts`: `isMarkdownMime`/`isPreviewableMime` true for `{octet-stream, foo.md}`, false for `{octet-stream, no-ext binary}`; `isHtmlMime` true for octet-stream `.html`; SVG octet-stream NOT previewable-image.
- [ ] Web behavioral test: `FilePreviewModal` renders the markdown branch for an octet-stream `.md` file.
- [ ] API `library.test.ts`: preview route serves `text/markdown` (passes gate) for stored octet-stream + filename `.md`; octet-stream `.html` STILL served as `text/plain` with `default-src 'none'`; octet-stream `.svg` STILL rejected (400).

### Process fix (Rule 02 — target the class of bug)
- [ ] Add `.claude/rules/51-vm-agent-no-host-mime-db.md`: vm-agent must not depend on host-provided MIME databases / OS-specific files for behavior affecting product output; register needed mappings in-process with tests proving host-independence.
- [ ] PR "Post-Mortem" section: root cause, class of bug, process fix.

## Acceptance Criteria
- [ ] New agent uploads of `.md` (and the other curated types) get the correct `mimeType` from the vm-agent regardless of host MIME DB — proven by the Go host-independence test.
- [ ] Already-stored `application/octet-stream` files with a known extension preview correctly with NO re-upload — proven by web + API tests (esp. octet-stream `.md` → markdown preview).
- [ ] HTML/SVG security handling is unchanged: octet-stream `.html` served as `text/plain`+CSP, octet-stream `.svg` rejected — proven by API test.
- [ ] `pnpm lint && typecheck && test && build` green; `go test ./...` green in vm-agent.
- [ ] All `/do` Phase 5 reviewers PASS/ADDRESSED; CI green. Staging intentionally skipped (documented in PR).

## Verification note
Layer 1 is a vm-agent binary change; full E2E runtime verification (a fresh Instant node
downloading the new binary + a real agent upload) requires provisioning and is NOT possible
pre-merge under the skip-staging constraint. Layer 2 (web + API) is fully verifiable locally
and is what makes already-uploaded files previewable. This limitation is called out in the PR.

## References
- `.claude/rules/02-quality-gates.md` (regression + discriminating test + template-output-verification), `.claude/rules/13-staging-verification.md` + policy "Skip staging when explicitly requested", `.claude/rules/26-project-chat-first.md` (DocumentCard is the chat surface), `.claude/rules/18-file-size-limits.md`, Constitution Principle XI (curated static type table is not a hardcoded config value).
