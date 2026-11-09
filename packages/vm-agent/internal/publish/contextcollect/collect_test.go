package contextcollect

import (
	"archive/tar"
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
)

func fixture(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for name, value := range files {
		p := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}
func bundle(t *testing.T, root string) map[string]string {
	t.Helper()
	var out bytes.Buffer
	_, err := Collect(context.Background(), Options{Root: root}, &out)
	if err != nil {
		t.Fatal(err)
	}
	z, err := zstd.NewReader(&out)
	if err != nil {
		t.Fatal(err)
	}
	defer z.Close()
	tr := tar.NewReader(z)
	files := map[string]string{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		files[h.Name] = string(b)
	}
	return files
}
func TestOverridesAndRuntimeSecrets(t *testing.T) {
	root := fixture(t, map[string]string{"compose.yaml": "services:\n  web:\n    build: ./old\n    env_file: runtime.env\n    environment:\n      SECRET: ${SECRET:?required}\n", "compose.override.yaml": "services:\n  web:\n    build: ./app\n", "runtime.env": "SECRET=must-never-leak", ".env": "LOCAL_SECRET=never-leak", "app/Dockerfile": "FROM scratch\n", "app/source": "yes", "old/Dockerfile": "FROM scratch\n"})
	var out bytes.Buffer
	_, err := Collect(context.Background(), Options{Root: root, SecretKeys: []string{"SECRET"}}, &out)
	if err != nil {
		t.Fatal(err)
	}
	files := bundleWithSecrets(t, root)
	if files["runtime.env"] != "" {
		t.Fatal("runtime secret leaked")
	}
	if _, ok := files["compose.override.yaml"]; !ok {
		t.Fatal("override missing")
	}
	if files["app/source"] != "yes" {
		t.Fatal("override context missing")
	}
	if _, ok := files["old/Dockerfile"]; ok {
		t.Fatal("overridden context collected")
	}
	for _, b := range files {
		if strings.Contains(b, "must-never-leak") || strings.Contains(b, "LOCAL_SECRET=") {
			t.Fatal("secret content leaked")
		}
	}
}
func bundleWithSecrets(t *testing.T, root string) map[string]string {
	t.Helper() // Same placeholder as node publish, without host env.
	var out bytes.Buffer
	_, err := Collect(context.Background(), Options{Root: root, SecretKeys: []string{"SECRET"}}, &out)
	if err != nil {
		t.Fatal(err)
	}
	z, _ := zstd.NewReader(&out)
	defer z.Close()
	tr := tar.NewReader(z)
	files := map[string]string{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(tr)
		files[h.Name] = string(b)
	}
	return files
}
func TestIgnoreDocumentedMatrix(t *testing.T) { // https://docs.docker.com/build/concepts/context/#dockerignore-files
	cases := []struct {
		name, patterns string
		keep, drop     []string
	}{
		{"globstar", "**/*.log\n!keep.log\n", []string{"keep.log", "source"}, []string{"a/nested.log", "root.log"}},
		{"last rule wins", "*.txt\n!keep.txt\nkeep.txt\n", []string{"source"}, []string{"keep.txt"}},
		{"ignored parent exception", "cache\n!cache/keep\n", []string{"cache/keep"}, []string{"cache/drop"}},
		{"clean comments", "# comment\n./trash/\n", []string{"source"}, []string{"trash/file"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := map[string]string{"compose.yaml": "services:\n  web:\n    build: .\n", "Dockerfile": "FROM scratch\n", ".dockerignore": tc.patterns}
			for _, n := range append(tc.keep, tc.drop...) {
				f[n] = "payload"
			}
			files := bundle(t, fixture(t, f))
			for _, n := range tc.keep {
				if _, ok := files[n]; !ok {
					t.Errorf("excluded Docker input %s", n)
				}
			}
			for _, n := range tc.drop {
				if _, ok := files[n]; ok {
					t.Errorf("ignored %s included", n)
				}
			}
		})
	}
}
func TestDockerfileIgnoreUnion(t *testing.T) {
	root := fixture(t, map[string]string{"compose.yaml": "services:\n  web:\n    build: .\n", "Dockerfile": "FROM scratch\n", ".dockerignore": "root-only\nboth\n", "Dockerfile.dockerignore": "file-only\nboth\n", "root-only": "yes", "file-only": "yes", "both": "no"})
	files := bundle(t, root)
	for _, n := range []string{"root-only", "file-only", "Dockerfile.dockerignore", ".dockerignore"} {
		if _, ok := files[n]; !ok {
			t.Fatal("missing union entry", n)
		}
	}
	if _, ok := files["both"]; ok {
		t.Fatal("both filters exclude")
	}
}
func TestRejectEscapesAndRemoteContexts(t *testing.T) {
	for _, c := range []string{"../outside", "https://example.com/repo.git", "git@example.com:repo.git"} {
		t.Run(c, func(t *testing.T) {
			root := fixture(t, map[string]string{"compose.yaml": "services:\n  web:\n    build: " + c + "\n"})
			_, err := Collect(context.Background(), Options{Root: root}, io.Discard)
			if err == nil {
				t.Fatal("accepted unsafe context")
			}
		})
	}
	root := fixture(t, map[string]string{"compose.yaml": "services:\n  web:\n    build: .\n", "Dockerfile": "FROM scratch\n"})
	if err := os.Symlink(t.TempDir(), filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if _, err := Collect(context.Background(), Options{Root: root}, io.Discard); err == nil {
		t.Fatal("accepted escaping symlink")
	}
}
func TestByteAndDeadlineBounds(t *testing.T) {
	root := fixture(t, map[string]string{"compose.yaml": "services:\n  web:\n    build: .\n", "Dockerfile": "FROM scratch\n", "big": strings.Repeat("x", 20000)})
	if _, err := Collect(context.Background(), Options{Root: root, MaxBytes: 4096}, io.Discard); err == nil {
		t.Fatal("size limit not enforced")
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if _, err := Collect(ctx, Options{Root: root}, io.Discard); err == nil {
		t.Fatal("deadline ignored")
	}
}
