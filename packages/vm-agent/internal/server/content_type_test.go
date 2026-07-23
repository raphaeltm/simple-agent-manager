package server

import (
	"strings"
	"testing"
)

// TestFallbackContentType is the discriminating test for the bug class. It
// exercises the curated fallback table DIRECTLY — a pure map lookup with ZERO
// dependence on mime.TypeByExtension or the host's /etc/mime.types. It therefore
// asserts the exact bytes the resolver produces on a host that has no
// media-types package installed (the minimal cf-container image), which is the
// runtime that produced the octet-stream bug.
//
// Go's mime table is cached via sync.Once and cannot be reset in-process to
// simulate "no host mime DB", so testing this pure function is how we prove the
// container behavior deterministically.
func TestFallbackContentType(t *testing.T) {
	tests := []struct {
		ext  string
		want string
	}{
		{".md", "text/markdown; charset=utf-8"},
		{".markdown", "text/markdown; charset=utf-8"},
		{".txt", "text/plain; charset=utf-8"},
		{".log", "text/plain; charset=utf-8"},
		{".csv", "text/csv; charset=utf-8"},
		{".yaml", "application/yaml"},
		{".yml", "application/yaml"},
		{".toml", "application/toml"},
		{".json", "application/json"},
		{".xml", "application/xml"},
		// Case-insensitivity: uppercase extensions resolve identically.
		{".MD", "text/markdown; charset=utf-8"},
		{".YAML", "application/yaml"},
		// Unknown / no extension → octet-stream (never a wrong guess).
		{".bin", "application/octet-stream"},
		{".unknownext", "application/octet-stream"},
		{"", "application/octet-stream"},
	}

	for _, tc := range tests {
		t.Run(tc.ext, func(t *testing.T) {
			if got := fallbackContentType(tc.ext); got != tc.want {
				t.Errorf("fallbackContentType(%q) = %q, want %q", tc.ext, got, tc.want)
			}
		})
	}
}

// TestResolveContentType verifies the end-to-end resolver. It asserts only
// properties that hold on ANY host — whether or not /etc/mime.types is present —
// because mime.TypeByExtension is consulted first and different hosts map the
// same extension to variant media types (e.g. this box maps .yaml to
// application/x-yaml while the in-process fallback uses application/yaml). The
// host-invariant guarantees are:
//   - the curated text/doc extensions NEVER resolve to octet-stream (the bug),
//   - markdown resolves to the text/markdown family (the reported symptom; the
//     Debian/Ubuntu media-types value and the fallback agree exactly, so it is
//     deterministic across the VM host and the cf-container image),
//   - extensions in Go's built-in table resolve to their standard family.
func TestResolveContentType(t *testing.T) {
	// notOctet: the bug-fix guarantee — must resolve to some real media type on
	// every host, never application/octet-stream.
	notOctet := []string{
		"README.md", "notes.markdown", "log.txt", "app.log",
		"config.yaml", "config.yml", "Cargo.toml", "data.csv",
		"/workspace/docs/guide.md",
	}
	for _, name := range notOctet {
		t.Run("not_octet/"+name, func(t *testing.T) {
			if got := resolveContentType(name); got == unknownContentType {
				t.Errorf("resolveContentType(%q) = %q, expected a resolved media type, not octet-stream", name, got)
			}
		})
	}

	// family: deterministic media-type family across hosts (fallback agrees with
	// the standard OS/built-in value, or Go's built-in table always applies).
	family := []struct {
		input string
		want  string
	}{
		{"README.md", "text/markdown"},
		{"docs/guide.markdown", "text/markdown"},
		{"index.html", "text/html"},
		{"logo.png", "image/png"},
		{"icon.svg", "image/svg"},
		{"report.pdf", "application/pdf"},
		{"package.json", "application/json"},
	}
	for _, tc := range family {
		t.Run("family/"+tc.input, func(t *testing.T) {
			if got := resolveContentType(tc.input); !strings.HasPrefix(got, tc.want) {
				t.Errorf("resolveContentType(%q) = %q, want prefix %q", tc.input, got, tc.want)
			}
		})
	}

	// octet: genuinely unknown extensions and no-extension names → octet-stream.
	octet := []string{"blob.unknownext", "archive.zzz", "Makefile", "noext"}
	for _, name := range octet {
		t.Run("octet/"+name, func(t *testing.T) {
			if got := resolveContentType(name); got != unknownContentType {
				t.Errorf("resolveContentType(%q) = %q, want %q", name, got, unknownContentType)
			}
		})
	}
}

// TestResolveContentType_NoHostMimeDatabase proves the WIRING that the bug was
// about: that resolveContentType actually falls through to the curated
// fallbackContentTypes table when the host mime lookup returns empty. On any
// dev/CI host with a real mime database, mime.TypeByExtension resolves the
// curated extensions itself, so the fallthrough is never exercised and a test
// that relied on the real lookup could NOT distinguish the fixed code from a
// regression that dropped the fallback call. Here we override mimeTypeByExtension
// to always return "" — exactly the minimal cf-container scenario — so the
// assertions can ONLY pass if the fallback is wired in. This test must fail if
// resolveContentType stops calling fallbackContentType (verified discriminating).
func TestResolveContentType_NoHostMimeDatabase(t *testing.T) {
	orig := mimeTypeByExtension
	mimeTypeByExtension = func(string) string { return "" } // no host mime DB at all
	t.Cleanup(func() { mimeTypeByExtension = orig })

	tests := []struct {
		input string
		want  string
	}{
		{"README.md", "text/markdown; charset=utf-8"},
		{"notes.markdown", "text/markdown; charset=utf-8"},
		{"log.txt", "text/plain; charset=utf-8"},
		{"app.log", "text/plain; charset=utf-8"},
		{"data.csv", "text/csv; charset=utf-8"},
		{"config.yaml", "application/yaml"},
		{"config.yml", "application/yaml"},
		{"Cargo.toml", "application/toml"},
		{"package.json", "application/json"},
		{"data.xml", "application/xml"},
		{"/workspace/docs/guide.md", "text/markdown; charset=utf-8"},
		// Unknown / no extension still → octet-stream when the host DB is empty.
		{"blob.unknownext", unknownContentType},
		{"Makefile", unknownContentType},
	}

	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			if got := resolveContentType(tc.input); got != tc.want {
				t.Errorf("resolveContentType(%q) with no host mime DB = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}
