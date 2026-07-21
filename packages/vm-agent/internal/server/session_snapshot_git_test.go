package server

import (
	"archive/tar"
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

func TestCreateWIPBundlePreservesBranchAndIndex(t *testing.T) {
	repo := initSnapshotTestRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("staged"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", "README.md")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("staged and unstaged"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "untracked.txt"), []byte("untracked"), 0o600); err != nil {
		t.Fatal(err)
	}
	beforeStatus := gitOutput(t, repo, "status", "--porcelain=v1")
	beforeHead := gitOutput(t, repo, "rev-parse", "HEAD")
	beforeBranch := gitOutput(t, repo, "branch", "--show-current")

	_, bundlePath, _, err := createWIPBundle(context.Background(), repo, 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(bundlePath)

	if got := gitOutput(t, repo, "status", "--porcelain=v1"); got != beforeStatus {
		t.Fatalf("status changed by snapshot:\nwant %q\n got %q", beforeStatus, got)
	}
	if got := gitOutput(t, repo, "rev-parse", "HEAD"); got != beforeHead {
		t.Fatalf("HEAD changed by snapshot: want %s, got %s", beforeHead, got)
	}
	if got := gitOutput(t, repo, "branch", "--show-current"); got != beforeBranch {
		t.Fatalf("branch changed by snapshot: want %s, got %s", beforeBranch, got)
	}
}

func TestDownloadAndRestoreWIPKeepsOriginalBranch(t *testing.T) {
	repo := initSnapshotTestRepo(t)
	base := gitOutput(t, repo, "rev-parse", "HEAD")
	branch := gitOutput(t, repo, "branch", "--show-current")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("restored change"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, bundlePath, _, err := createWIPBundle(context.Background(), repo, 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(bundlePath)
	runGit(t, repo, "reset", "--hard", base)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		f, openErr := os.Open(bundlePath)
		if openErr != nil {
			http.Error(w, openErr.Error(), http.StatusInternalServerError)
			return
		}
		defer f.Close()
		_, _ = io.Copy(w, f)
	}))
	defer server.Close()
	s := &Server{config: &config.Config{ControlPlaneURL: server.URL}}
	if err := s.downloadAndRestoreWIP(context.Background(), server.URL, "token", time.Second, repo, base); err != nil {
		t.Fatal(err)
	}
	if got := gitOutput(t, repo, "branch", "--show-current"); got != branch {
		t.Fatalf("branch changed by restore: want %s, got %s", branch, got)
	}
	if got := strings.TrimSpace(gitOutput(t, repo, "diff", "--", "README.md")); got == "" {
		t.Fatal("restored WIP is missing")
	}
}

func TestDownloadAndRestoreWIPPreservesIndexAndWorktree(t *testing.T) {
	repo := initSnapshotTestRepo(t)
	base := gitOutput(t, repo, "rev-parse", "HEAD")

	stagedPath := filepath.Join(repo, "staged.txt")
	if err := os.WriteFile(stagedPath, []byte("staged"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", "staged.txt")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("staged readme"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", "README.md")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("staged readme\nunstaged readme"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "untracked.txt"), []byte("untracked"), 0o600); err != nil {
		t.Fatal(err)
	}

	wantStatus := gitOutput(t, repo, "status", "--porcelain=v1")
	_, bundlePath, _, err := createWIPBundle(context.Background(), repo, 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(bundlePath)

	runGit(t, repo, "reset", "--hard", base)
	if err := os.RemoveAll(stagedPath); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(repo, "untracked.txt")); err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		f, openErr := os.Open(bundlePath)
		if openErr != nil {
			http.Error(w, openErr.Error(), http.StatusInternalServerError)
			return
		}
		defer f.Close()
		_, _ = io.Copy(w, f)
	}))
	defer server.Close()

	s := &Server{config: &config.Config{ControlPlaneURL: server.URL}}
	if err := s.downloadAndRestoreWIP(context.Background(), server.URL, "token", time.Second, repo, base); err != nil {
		t.Fatal(err)
	}

	if got := gitOutput(t, repo, "status", "--porcelain=v1"); got != wantStatus {
		t.Fatalf("restored status mismatch:\nwant %q\n got %q", wantStatus, got)
	}
	if got := gitOutput(t, repo, "show", ":staged.txt"); got != "staged" {
		t.Fatalf("staged file index content = %q, want staged", got)
	}
	if got := gitOutput(t, repo, "show", ":README.md"); got != "staged readme" {
		t.Fatalf("README index content = %q, want staged readme", got)
	}
	if got, err := os.ReadFile(filepath.Join(repo, "README.md")); err != nil || string(got) != "staged readme\nunstaged readme" {
		t.Fatalf("README worktree content = %q, %v", got, err)
	}
}

func initSnapshotTestRepo(t *testing.T) string {
	t.Helper()
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
	return repo
}

func gitOutput(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestDownloadAndExtractTarRejectsExistingHomeSymlink(t *testing.T) {
	home := t.TempDir()
	outside := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.Symlink(outside, filepath.Join(home, "linked")); err != nil {
		t.Fatal(err)
	}
	var tarBody bytes.Buffer
	tw := tar.NewWriter(&tarBody)
	writeTarFile(t, tw, "linked/credential", "secret")
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(tarBody.Bytes())
	}))
	defer server.Close()
	s := &Server{config: &config.Config{ControlPlaneURL: server.URL}}
	if err := s.downloadAndExtractTar(context.Background(), server.URL, "token", time.Second); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("error = %v, want symlink rejection", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "credential")); !os.IsNotExist(err) {
		t.Fatalf("outside credential stat err = %v, want not exist", err)
	}
}
