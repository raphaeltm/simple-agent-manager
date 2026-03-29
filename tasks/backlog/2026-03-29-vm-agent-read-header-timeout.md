# Switch VM Agent HTTP Server from ReadTimeout to ReadHeaderTimeout

## Problem

The VM agent HTTP server uses `ReadTimeout` (default: 15s) which applies to the entire request body read, not just headers. With the increased file upload limit (50MB per file), uploads over moderate connections (e.g., 5 Mbps ≈ 80s for 50MB) will be silently killed by the server before the handler finishes reading the body.

## Context

Discovered during Go specialist review of PR increasing file upload limits to 50MB. Pre-existing issue that becomes more impactful at larger file sizes.

**Location**: `packages/vm-agent/internal/server/server.go:421`

## Acceptance Criteria

- [ ] Replace `ReadTimeout` with `ReadHeaderTimeout` in the HTTP server configuration
- [ ] `ReadHeaderTimeout` protects against slowloris attacks on headers
- [ ] Body-read timing governed by handler context timeouts (`FileUploadTimeout`, etc.)
- [ ] Test that large file uploads don't time out at the server level
