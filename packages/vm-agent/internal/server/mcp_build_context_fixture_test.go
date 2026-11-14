package server

import (
	"os"
	"path/filepath"
	"testing"
)

// Instant source tests need the real trusted base, which local developers may
// not have permission to create or write. Never create /workspaces for a test.
func buildContextTestDir(t *testing.T, base, prefix string) string {
	t.Helper()
	dir, err := os.MkdirTemp(base, prefix)
	if err != nil {
		t.Skipf("build-context fixture base %s unavailable: %v", base, err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Errorf("clean up build-context fixture: %v", err)
		}
	})
	return dir
}

func TestBuildContextFixtureUnavailableBaseSkips(t *testing.T) {
	base := t.TempDir()
	file := filepath.Join(base, "not-a-directory")
	if err := os.WriteFile(file, nil, 0600); err != nil {
		t.Fatal(err)
	}
	for _, unavailable := range []string{filepath.Join(base, "missing"), file} {
		skipped := false
		t.Run(filepath.Base(unavailable), func(t *testing.T) {
			defer func() { skipped = t.Skipped() }()
			buildContextTestDir(t, unavailable, "context-fixture-")
			t.Fatal("unavailable fixture base did not skip")
		})
		if !skipped {
			t.Error("unavailable fixture base must skip rather than fail")
		}
	}
}

func TestBuildContextFixtureCleansDirectory(t *testing.T) {
	base := t.TempDir()
	var fixture string
	t.Run("available", func(t *testing.T) {
		fixture = buildContextTestDir(t, base, "context-fixture-")
		if filepath.Dir(fixture) != base {
			t.Fatalf("fixture outside requested base: %s", fixture)
		}
		if err := os.WriteFile(filepath.Join(fixture, "marker"), nil, 0600); err != nil {
			t.Fatal(err)
		}
	})
	if _, err := os.Stat(fixture); !os.IsNotExist(err) {
		t.Fatalf("fixture was not removed: %v", err)
	}
}
