package server

import (
	"mime"
	"path/filepath"
	"strings"
)

// unknownContentType is the fallback served when an extension cannot be mapped
// to a known media type.
const unknownContentType = "application/octet-stream"

// fallbackContentTypes maps common text/document file extensions to their
// Content-Type. It is consulted ONLY when mime.TypeByExtension returns empty.
//
// Go's mime package seeds a built-in table (html, htm, png, jpg, jpeg, gif,
// svg, pdf, json, xml, css, js, webp, wasm, ...) before it ever reads the host
// mime database, so those extensions always resolve. But the built-in table
// does NOT include .md/.markdown/.txt/.log/.yaml/.yml/.toml/.csv — those depend
// on the host mime database that Go's mime.initMimeUnix loads (shared-mime-info's
// /usr/share/mime/globs2, or failing that /etc/mime.types from the media-types
// package). Full Ubuntu VM nodes ship one of those, but the minimal Debian image
// used by the cf-container Instant runtime ships neither, so on that runtime
// those extensions resolved to "" and the handler fell back to
// application/octet-stream. That broke library preview for agent-uploaded
// markdown (the stored library mimeType is whatever Content-Type this agent
// returns). This in-process table makes resolution deterministic regardless of
// the host mime database.
//
// Keep the extension → media-type mapping in sync with the TS resolver in
// packages/shared/src/mime.ts. (.json/.xml are also covered by Go's built-in
// table; they are listed here as belt-and-suspenders so the resolver is correct
// even if the built-in table is ever unavailable.) See
// .claude/rules/51-vm-agent-no-host-mime-dependency.md.
var fallbackContentTypes = map[string]string{
	".md":       "text/markdown; charset=utf-8",
	".markdown": "text/markdown; charset=utf-8",
	".txt":      "text/plain; charset=utf-8",
	".log":      "text/plain; charset=utf-8",
	".csv":      "text/csv; charset=utf-8",
	".yaml":     "application/yaml",
	".yml":      "application/yaml",
	".toml":     "application/toml",
	".json":     "application/json",
	".xml":      "application/xml",
}

// mimeTypeByExtension indirects mime.TypeByExtension so tests can simulate a
// host with NO mime database at all — the exact cf-container scenario. Go's mime
// table is cached via sync.Once and cannot otherwise be reset in-process, so
// without this indirection a regression test cannot force the empty-result path
// and therefore cannot prove that resolveContentType actually falls through to
// the curated fallback (on a dev/CI host with a real mime database,
// mime.TypeByExtension resolves the curated extensions itself and the
// fallthrough is never exercised). Overridden in tests only.
var mimeTypeByExtension = mime.TypeByExtension

// resolveContentType determines the HTTP Content-Type for a file name WITHOUT
// depending on the host's mime database. Resolution order:
//  1. mimeTypeByExtension (Go's built-in table plus any host mime database),
//  2. the curated fallbackContentTypes table for common text/doc extensions,
//  3. application/octet-stream.
//
// It accepts either a bare file name or a path; only the extension is used.
func resolveContentType(nameOrPath string) string {
	ext := strings.ToLower(filepath.Ext(nameOrPath))
	if ct := mimeTypeByExtension(ext); ct != "" {
		return ct
	}
	return fallbackContentType(ext)
}

// fallbackContentType looks up the curated table for an extension (which must
// include the leading dot, e.g. ".md"), returning application/octet-stream when
// the extension is unknown. It is a pure map lookup with NO dependence on the
// host mime database — this is the deterministic guarantee the resolver relies
// on, and the discriminating behavior the regression test exercises directly.
func fallbackContentType(ext string) string {
	if ct, ok := fallbackContentTypes[strings.ToLower(ext)]; ok {
		return ct
	}
	return unknownContentType
}
