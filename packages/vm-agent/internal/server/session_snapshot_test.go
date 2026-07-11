package server

import (
	"archive/tar"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestCreateHomeTarExcludesCachesAndRecordsOversizedFiles(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".codex-session.jsonl"), []byte("session"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".cache"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".cache", "ignored"), []byte("cache"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "large.bin"), []byte("0123456789"), 0o600); err != nil {
		t.Fatal(err)
	}

	tarPath, skipped, err := createHomeTar(func() (string, error) { return home, nil }, 8, 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tarPath)

	if len(skipped) != 1 {
		t.Fatalf("skipped len = %d, want 1: %#v", len(skipped), skipped)
	}
	if skipped[0].Path != "~/large.bin" {
		t.Fatalf("skipped path = %q, want ~/large.bin", skipped[0].Path)
	}

	names := tarNames(t, tarPath)
	if !containsString(names, ".codex-session.jsonl") {
		t.Fatalf("tar names missing session file: %#v", names)
	}
	if containsString(names, ".cache/ignored") {
		t.Fatalf("tar names included cache file: %#v", names)
	}
	if containsString(names, "large.bin") {
		t.Fatalf("tar names included oversized file: %#v", names)
	}
}

func TestCreateWIPBundleDegradesDuringMerge(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	repo := t.TempDir()
	runGit(t, repo, "init")
	runGit(t, repo, "config", "user.email", "sam@example.test")
	runGit(t, repo, "config", "user.name", "SAM")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("base"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", "README.md")
	runGit(t, repo, "commit", "-m", "base")
	if err := os.WriteFile(filepath.Join(repo, ".git", "MERGE_HEAD"), []byte("deadbeef"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, bundlePath, skipped, err := createWIPBundle(context.Background(), repo, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if bundlePath != "" {
		t.Fatalf("bundlePath = %q, want empty during merge", bundlePath)
	}
	if len(skipped) != 1 || skipped[0].Reason != "git operation in progress" {
		t.Fatalf("skipped = %#v, want git operation degradation", skipped)
	}
}

func tarNames(t *testing.T, path string) []string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	tr := tar.NewReader(f)
	var names []string
	for {
		header, err := tr.Next()
		if err == io.EOF {
			return names
		}
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, header.Name)
	}
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, out)
	}
}

func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}
