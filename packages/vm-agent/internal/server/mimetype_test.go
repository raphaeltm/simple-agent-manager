package server

import (
	"mime"
	"testing"
)

// TestResolveContentType_CuratedTypes proves the curated text/document
// extensions resolve to their canonical IANA Content-Types.
func TestResolveContentType_CuratedTypes(t *testing.T) {
	tests := []struct {
		name     string
		filename string
		want     string
	}{
		{"markdown .md", "README.md", "text/markdown"},
		{"markdown .markdown", "notes.markdown", "text/markdown"},
		{"plain .txt", "notes.txt", "text/plain"},
		{"plain .log", "server.log", "text/plain"},
		{"yaml .yaml", "config.yaml", "application/yaml"},
		{"yaml .yml", "config.yml", "application/yaml"},
		{"toml .toml", "Cargo.toml", "application/toml"},
		{"csv .csv", "data.csv", "text/csv"},
		{"json .json", "package.json", "application/json"},
		{"xml .xml", "pom.xml", "application/xml"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := resolveContentType(tt.filename); got != tt.want {
				t.Errorf("resolveContentType(%q) = %q, want %q", tt.filename, got, tt.want)
			}
		})
	}
}

// TestResolveContentType_HostMimeDBIndependent is the discriminating test for
// the bug class: content-type resolution MUST NOT depend on the host's
// /etc/mime.types database.
//
// mime.AddExtensionType injects an entry into the SAME in-process table that
// /etc/mime.types populates. Because resolveContentType consults the curated
// map BEFORE mime.TypeByExtension, the poisoned host entry must be ignored for
// a curated extension. A mime.TypeByExtension-first implementation (the pre-fix
// behavior) would return the poisoned value and fail this test — and on a host
// that ships media-types it would silently resolve .md anyway, so this poison
// approach is the only reliable way to prove host-independence in CI.
func TestResolveContentType_HostMimeDBIndependent(t *testing.T) {
	// Simulate a host /etc/mime.types that maps .md to a bogus type.
	if err := mime.AddExtensionType(".md", "application/x-poisoned-by-host"); err != nil {
		t.Fatalf("failed to seed host mime table: %v", err)
	}

	if got := resolveContentType("readme.md"); got != "text/markdown" {
		t.Errorf("resolveContentType ignored the curated map and deferred to the host mime DB: got %q, want %q", got, "text/markdown")
	}

	// Sanity: the poison IS present in the host table, proving the test would
	// have detected a mime-first regression rather than passing vacuously.
	if hostType := mime.TypeByExtension(".md"); hostType != "application/x-poisoned-by-host" {
		t.Fatalf("expected host mime table to return the seeded poison, got %q", hostType)
	}
}

// TestResolveContentType_BuiltinAndFallback proves non-curated extensions still
// flow through mime.TypeByExtension (Go's built-in table) and that unknown
// extensions fall back to application/octet-stream.
func TestResolveContentType_BuiltinAndFallback(t *testing.T) {
	// .png is in Go's built-in table and must NOT be shadowed by the curated map.
	if got := resolveContentType("logo.png"); got != "image/png" {
		t.Errorf("resolveContentType(logo.png) = %q, want image/png", got)
	}
	// .svg resolves via Go's built-in table to image/svg+xml so the SVG CSP
	// branch in handleFileRaw still triggers.
	if got := resolveContentType("icon.svg"); got != "image/svg+xml" {
		t.Errorf("resolveContentType(icon.svg) = %q, want image/svg+xml", got)
	}
	// Unknown extension → octet-stream.
	if got := resolveContentType("archive.unknownext"); got != "application/octet-stream" {
		t.Errorf("resolveContentType(archive.unknownext) = %q, want application/octet-stream", got)
	}
	// No extension → octet-stream.
	if got := resolveContentType("Makefile"); got != "application/octet-stream" {
		t.Errorf("resolveContentType(Makefile) = %q, want application/octet-stream", got)
	}
}

// TestResolveContentType_CaseInsensitive proves uppercase extensions resolve
// identically (agents and users produce both).
func TestResolveContentType_CaseInsensitive(t *testing.T) {
	cases := map[string]string{
		"README.MD":   "text/markdown",
		"CONFIG.YAML": "application/yaml",
		"DATA.CSV":    "text/csv",
	}
	for filename, want := range cases {
		if got := resolveContentType(filename); got != want {
			t.Errorf("resolveContentType(%q) = %q, want %q", filename, got, want)
		}
	}
}
