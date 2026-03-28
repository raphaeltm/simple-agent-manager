# File Raw Endpoint Security Hardening

**Created**: 2026-03-28
**Source**: Security auditor review of image rendering feature PR

## Problem

The security auditor identified several findings during the image rendering feature review that were deferred from the initial PR as they require broader architectural changes.

## Findings

### HIGH: JWT Terminal Token in FileViewerPanel `<img src>` URL
- `FileViewerPanel` uses `getFileRawUrl()` which places the JWT token as a query parameter
- Token appears in browser history, server logs, referrer headers
- The `ChatFilePanel` path correctly uses the API proxy (no token in URL)
- **Fix**: Route `FileViewerPanel` image requests through the API proxy pattern, or use `fetch()` + `createObjectURL()` to keep token out of URL

### MEDIUM: Size Limit Bypass via Absent Content-Length
- API proxy checks `Content-Length` header but defaults to 0 if absent
- Chunked transfer encoding or missing header bypasses the limit
- **Fix**: Enforce limit via streaming byte counter using `TransformStream`

### MEDIUM: Symlink Following in handleFileRaw
- `cat` follows symlinks — a symlink inside workdir pointing to `/etc/passwd` etc. will be served
- The stat `%F` check (added in review fix) catches symlinks when stat'd directly, but symlinks resolved through path components are not caught
- **Fix**: Use `readlink -f` to resolve canonical path and verify it remains within workDir

### LOW: MIME Type Relies Solely on Extension
- A file named `evil.svg` with PNG content gets SVG MIME type
- A file named `image.png` with SVG content gets PNG MIME type (no SVG CSP applied)
- `nosniff` provides primary protection but magic-byte detection would add defense-in-depth
- **Fix**: Read first 512 bytes and check for SVG markers regardless of extension

## Acceptance Criteria

- [ ] `FileViewerPanel` does not expose JWT tokens in `<img src>` URLs
- [ ] Response body size enforced via streaming byte counter, not just Content-Length header
- [ ] Symlinks resolved to canonical path and validated against workDir boundary
- [ ] SVG content detection via magic bytes as defense-in-depth alongside extension-based MIME
