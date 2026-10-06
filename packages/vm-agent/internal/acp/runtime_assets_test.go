package acp

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestApplyStandaloneRuntimeFilesWritesRelativeFiles(t *testing.T) {
	t.Parallel()

	workDir := t.TempDir()
	err := applyStandaloneRuntimeFiles(workDir, []RuntimeFile{{
		Path:    "config/app.env",
		Content: "SAM_RUNTIME_ASSET_TEST=present\n",
	}})
	if err != nil {
		t.Fatalf("applyStandaloneRuntimeFiles returned error: %v", err)
	}

	content, err := os.ReadFile(filepath.Join(workDir, "config", "app.env"))
	if err != nil {
		t.Fatalf("read runtime file: %v", err)
	}
	if string(content) != "SAM_RUNTIME_ASSET_TEST=present\n" {
		t.Fatalf("content = %q", string(content))
	}
}

func TestApplyStandaloneRuntimeFilesRejectsTraversal(t *testing.T) {
	t.Parallel()

	err := applyStandaloneRuntimeFiles(t.TempDir(), []RuntimeFile{{
		Path:    "../secret.txt",
		Content: "nope",
	}})
	if err == nil {
		t.Fatal("expected traversal path to be rejected")
	}
}

func TestApplyStandaloneRuntimeFilesWritesSecretFiles0600(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX file mode assertion")
	}

	workDir := t.TempDir()
	err := applyStandaloneRuntimeFiles(workDir, []RuntimeFile{{
		Path:     ".secrets/token",
		Content:  "secret",
		IsSecret: true,
	}})
	if err != nil {
		t.Fatalf("applyStandaloneRuntimeFiles returned error: %v", err)
	}

	info, err := os.Stat(filepath.Join(workDir, ".secrets", "token"))
	if err != nil {
		t.Fatalf("stat runtime file: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("secret file mode = %o, want 0600", perm)
	}
}

func TestResolveStandaloneRuntimeFilePathExpandsHome(t *testing.T) {
	t.Parallel()

	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("home directory unavailable")
	}

	got, err := resolveStandaloneRuntimeFilePath(t.TempDir(), "~/.sam/config")
	if err != nil {
		t.Fatalf("resolveStandaloneRuntimeFilePath returned error: %v", err)
	}
	want := filepath.Join(home, ".sam", "config")
	if got != want {
		t.Fatalf("path = %q, want %q", got, want)
	}
}
