package server

import (
	"mime"
	"path/filepath"
	"strings"
)

// curatedContentTypes maps common text/document file extensions to their
// canonical IANA Content-Types.
//
// This map is the AUTHORITATIVE source for these extensions and is consulted
// BEFORE mime.TypeByExtension so that content-type resolution does NOT depend
// on the host's /etc/mime.types database. That database is present on the
// full Ubuntu VM host (via the media-types package) but ABSENT on the minimal
// Debian cf-container Instant image — where Go's mime.TypeByExtension returns
// "" for these extensions and callers fall back to application/octet-stream.
// A markdown file uploaded by an agent inside a container then lands in the
// project file library as octet-stream and refuses to preview.
//
// Only inert text/document types belong here — never image/PDF types, which
// Go resolves deterministically from its own built-in table and which must
// keep flowing through mime.TypeByExtension.
//
// This is a curated static type table, not a Constitution Principle XI
// hardcoded configuration value. See .claude/rules/51-vm-agent-no-host-mime-db.md.
var curatedContentTypes = map[string]string{
	".md":       "text/markdown",
	".markdown": "text/markdown",
	".txt":      "text/plain",
	".log":      "text/plain",
	".yaml":     "application/yaml",
	".yml":      "application/yaml",
	".toml":     "application/toml",
	".csv":      "text/csv",
	".json":     "application/json",
	".xml":      "application/xml",
}

// resolveContentType resolves an HTTP Content-Type for the given filename in a
// way that is independent of the host's /etc/mime.types database.
//
// Resolution order:
//  1. curated in-process map — authoritative for common text/document
//     extensions so behavior is identical on a full Ubuntu VM host and on the
//     minimal cf-container image.
//  2. mime.TypeByExtension — the Go/OS answer for everything else (images,
//     PDF, etc., which Go resolves from its built-in table).
//  3. application/octet-stream — final fallback for unknown extensions.
//
// The caller is responsible for stripping any header-unsafe characters (e.g.
// CRLF) from the filename before it reaches an HTTP header; this function only
// inspects the extension.
func resolveContentType(filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))
	if ct, ok := curatedContentTypes[ext]; ok {
		return ct
	}
	if ct := mime.TypeByExtension(ext); ct != "" {
		return ct
	}
	return "application/octet-stream"
}
