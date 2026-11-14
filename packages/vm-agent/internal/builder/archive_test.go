package builder

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/klauspost/compress/zstd"
)

func bundle(t *testing.T, headers []*tar.Header, content []byte) []byte {
	t.Helper()
	var b bytes.Buffer
	encoder, err := zstd.NewWriter(&b)
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(encoder)
	for _, h := range headers {
		if err = tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			if _, err = tw.Write(content[:h.Size]); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err = tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err = encoder.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func TestExtractPortableContext(t *testing.T) {
	raw := bundle(t, []*tar.Header{{Name: "ctx/file", Typeflag: tar.TypeReg, Mode: 0755, Size: 4}, {Name: "runtime.env", Typeflag: tar.TypeReg, Mode: 0600}, {Name: "link", Typeflag: tar.TypeSymlink, Linkname: "ctx/file"}}, []byte("test"))
	dir := t.TempDir()
	if err := Extract(context.Background(), bytes.NewReader(raw), dir, 8<<20); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"ctx/file", "link"} {
		value, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || string(value) != "test" {
			t.Fatalf("%s %q %v", name, value, err)
		}
	}
	info, err := os.Stat(filepath.Join(dir, "runtime.env"))
	if err != nil || info.Size() != 0 {
		t.Fatal("placeholder not empty")
	}
}
func TestExtractRejectsEscapeAndSpecialEntries(t *testing.T) {
	for _, header := range []*tar.Header{
		{Name: "../outside", Typeflag: tar.TypeReg}, {Name: "/outside", Typeflag: tar.TypeReg},
		{Name: "escape", Typeflag: tar.TypeSymlink, Linkname: "../outside"},
		{Name: "escape", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"},
		{Name: "fifo", Typeflag: tar.TypeFifo}, {Name: "device", Typeflag: tar.TypeChar},
		{Name: "hardlink", Typeflag: tar.TypeLink, Linkname: "/etc/passwd"},
	} {
		t.Run(header.Name+string(header.Typeflag), func(t *testing.T) {
			raw := bundle(t, []*tar.Header{header}, nil)
			if err := Extract(context.Background(), bytes.NewReader(raw), t.TempDir(), 8<<20); err == nil {
				t.Fatal("unsafe archive accepted")
			}
		})
	}
}
func TestExtractBoundsExpandedBytesAndDuplicateNames(t *testing.T) {
	raw := bundle(t, []*tar.Header{{Name: "large", Typeflag: tar.TypeReg, Size: 2 << 20}}, make([]byte, 2<<20))
	if err := Extract(context.Background(), bytes.NewReader(raw), t.TempDir(), 1<<20); err == nil {
		t.Fatal("expansion accepted")
	}
	raw = bundle(t, []*tar.Header{{Name: "same", Typeflag: tar.TypeReg}, {Name: "same", Typeflag: tar.TypeReg}}, nil)
	if err := Extract(context.Background(), bytes.NewReader(raw), t.TempDir(), 8<<20); err == nil {
		t.Fatal("duplicate accepted")
	}
}
func TestDownloadDigestSizeAndRedirect(t *testing.T) {
	payload := []byte("verified compressed bytes")
	digest := sha256.Sum256(payload)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "/ok", 302)
			return
		}
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	for _, tc := range []struct {
		name, url, sha string
		size           int64
		ok             bool
	}{
		{"owner", server.URL, hex.EncodeToString(digest[:]), int64(len(payload)), true},
		{"hash", server.URL, "0000000000000000000000000000000000000000000000000000000000000000", int64(len(payload)), false},
		{"size", server.URL, hex.EncodeToString(digest[:]), int64(len(payload) - 1), false},
		{"redirect", server.URL + "/redirect", hex.EncodeToString(digest[:]), int64(len(payload)), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, err := os.CreateTemp(t.TempDir(), "context")
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			err = Download(context.Background(), Client(DefaultCallbackTimeout), tc.url, tc.size, tc.sha, 1024, f)
			if (err == nil) != tc.ok {
				t.Fatalf("download err %v", err)
			}
		})
	}
}
