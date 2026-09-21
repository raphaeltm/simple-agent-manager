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

func TestCreateWIPBundleSkipsCleanRemoteCommit(t *testing.T) {
	repo, _ := initSnapshotRemoteRepo(t)
	state, err := captureStandaloneSnapshotGitState(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	base, bundlePath, _, err := createWIPBundle(context.Background(), repo, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if bundlePath != "" {
		defer os.Remove(bundlePath)
		t.Fatalf("bundlePath = %q, want no bundle for a clean remotely reachable HEAD", bundlePath)
	}
	if base != state.BaseCommit || state.BaseCommit != gitOutput(t, repo, "rev-parse", "HEAD") {
		t.Fatalf("captured base = %q, want current HEAD", state.BaseCommit)
	}
	if state.Git == nil || state.Git.Branch != "main" || state.Git.Upstream != "origin/main" {
		t.Fatalf("captured git metadata = %#v", state.Git)
	}
}

func TestCleanLocalOnlyCommitBundlesAndRestoresExactGitState(t *testing.T) {
	repo, remote := initSnapshotRemoteRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "local-only.txt"), []byte("local commit"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", "local-only.txt")
	runGit(t, repo, "commit", "-m", "local only")
	wantHead := gitOutput(t, repo, "rev-parse", "HEAD")

	state, err := captureStandaloneSnapshotGitState(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	_, bundlePath, _, err := createWIPBundle(context.Background(), repo, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if bundlePath == "" {
		t.Fatal("clean local-only commit did not produce a Git bundle")
	}
	defer os.Remove(bundlePath)

	restored := filepath.Join(t.TempDir(), "restored")
	runGit(t, filepath.Dir(restored), "clone", "--single-branch", "--branch", "main", remote, restored)
	server := serveSnapshotBundle(t, bundlePath)
	defer server.Close()
	s := &Server{config: &config.Config{ControlPlaneURL: server.URL}}
	if err := s.downloadAndRestoreWIPWithGitState(context.Background(), server.URL, "token", time.Second, restored, state); err != nil {
		t.Fatal(err)
	}
	if err := validateStandaloneSnapshotGitState(context.Background(), restored, state); err != nil {
		t.Fatal(err)
	}
	if got := gitOutput(t, restored, "rev-parse", "HEAD"); got != wantHead {
		t.Fatalf("restored HEAD = %q, want local-only commit %q", got, wantHead)
	}
	if got := gitOutput(t, restored, "status", "--porcelain=v1"); got != "" {
		t.Fatalf("restored clean snapshot status = %q, want clean", got)
	}
}

func TestRestoreCleanRemoteCommitFromMain(t *testing.T) {
	seed, remote := initSnapshotRemoteRepo(t)
	runGit(t, seed, "checkout", "-b", "sam/saved-task")
	if err := os.WriteFile(filepath.Join(seed, "saved.txt"), []byte("saved"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, seed, "add", "saved.txt")
	runGit(t, seed, "commit", "-m", "saved task")
	wantHead := gitOutput(t, seed, "rev-parse", "HEAD")
	runGit(t, seed, "push", "-u", "origin", "sam/saved-task")
	state, err := captureStandaloneSnapshotGitState(context.Background(), seed)
	if err != nil {
		t.Fatal(err)
	}

	restored := filepath.Join(t.TempDir(), "restored")
	runGit(t, filepath.Dir(restored), "clone", "--single-branch", "--branch", "main", remote, restored)
	if err := restoreStandaloneSnapshotGitState(context.Background(), restored, state); err != nil {
		t.Fatal(err)
	}
	if got := gitOutput(t, restored, "rev-parse", "HEAD"); got != wantHead {
		t.Fatalf("restored HEAD = %q, want saved commit %q", got, wantHead)
	}
	if got := gitOutput(t, restored, "branch", "--show-current"); got != "sam/saved-task" {
		t.Fatalf("restored branch = %q, want sam/saved-task", got)
	}
}

func TestRestoreDetachedSnapshotGitState(t *testing.T) {
	seed, remote := initSnapshotRemoteRepo(t)
	wantHead := gitOutput(t, seed, "rev-parse", "HEAD")
	runGit(t, seed, "checkout", "--detach", wantHead)
	state, err := captureStandaloneSnapshotGitState(context.Background(), seed)
	if err != nil {
		t.Fatal(err)
	}
	if state.Git == nil || !state.Git.Detached || state.Git.Branch != "" {
		t.Fatalf("captured detached metadata = %#v", state.Git)
	}

	restored := filepath.Join(t.TempDir(), "restored")
	runGit(t, filepath.Dir(restored), "clone", "--branch", "main", remote, restored)
	if err := restoreStandaloneSnapshotGitState(context.Background(), restored, state); err != nil {
		t.Fatal(err)
	}
	if got := gitOutput(t, restored, "rev-parse", "HEAD"); got != wantHead {
		t.Fatalf("restored detached HEAD = %q, want %q", got, wantHead)
	}
	if got := gitOutput(t, restored, "branch", "--show-current"); got != "" {
		t.Fatalf("restored branch = %q, want detached HEAD", got)
	}
}

func TestRestoreDirtySnapshotMovesToSavedCommitBeforeApplyingWIP(t *testing.T) {
	seed, remote := initSnapshotRemoteRepo(t)
	runGit(t, seed, "checkout", "-b", "sam/saved-task")
	if err := os.WriteFile(filepath.Join(seed, "saved.txt"), []byte("saved"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, seed, "add", "saved.txt")
	runGit(t, seed, "commit", "-m", "saved task")
	runGit(t, seed, "push", "-u", "origin", "sam/saved-task")
	wantHead := gitOutput(t, seed, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(seed, "saved.txt"), []byte("dirty snapshot"), 0o600); err != nil {
		t.Fatal(err)
	}
	state, err := captureStandaloneSnapshotGitState(context.Background(), seed)
	if err != nil {
		t.Fatal(err)
	}
	_, bundlePath, _, err := createWIPBundle(context.Background(), seed, 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(bundlePath)

	restored := filepath.Join(t.TempDir(), "restored")
	runGit(t, filepath.Dir(restored), "clone", "--branch", "main", remote, restored)
	server := serveSnapshotBundle(t, bundlePath)
	defer server.Close()
	s := &Server{config: &config.Config{ControlPlaneURL: server.URL}}
	if err := s.downloadAndRestoreWIPWithGitState(context.Background(), server.URL, "token", time.Second, restored, state); err != nil {
		t.Fatal(err)
	}
	if got := gitOutput(t, restored, "rev-parse", "HEAD"); got != wantHead {
		t.Fatalf("restored HEAD = %q, want saved commit %q", got, wantHead)
	}
	if got := gitOutput(t, restored, "diff", "--", "saved.txt"); !strings.Contains(got, "dirty snapshot") {
		t.Fatalf("restored WIP diff = %q, want dirty snapshot", got)
	}
}

func TestValidateSnapshotGitStateRejectsWrongHead(t *testing.T) {
	repo := initSnapshotTestRepo(t)
	actual := gitOutput(t, repo, "rev-parse", "HEAD")
	state := snapshotGitState{BaseCommit: strings.Repeat("a", 40)}
	err := validateStandaloneSnapshotGitState(context.Background(), repo, state)
	if err == nil || !strings.Contains(err.Error(), state.BaseCommit) || !strings.Contains(err.Error(), actual) {
		t.Fatalf("validation error = %v, want expected and actual commit diagnostics", err)
	}
}

func TestSnapshotRestoreGitStateRejectsContradictoryBaseCommit(t *testing.T) {
	restore := &snapshotRestoreResponse{
		BaseCommit: strings.Repeat("a", 40),
		Manifest:   &snapshotManifest{BaseCommit: strings.Repeat("b", 40)},
	}
	_, err := snapshotRestoreGitState(restore)
	if err == nil || !strings.Contains(err.Error(), "metadata mismatch") {
		t.Fatalf("snapshotRestoreGitState error = %v, want metadata mismatch", err)
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

func initSnapshotRemoteRepo(t *testing.T) (string, string) {
	t.Helper()
	remote := filepath.Join(t.TempDir(), "remote.git")
	runGit(t, filepath.Dir(remote), "init", "--bare", remote)
	repo := initSnapshotTestRepo(t)
	runGit(t, repo, "branch", "-M", "main")
	runGit(t, repo, "remote", "add", "origin", remote)
	runGit(t, repo, "push", "-u", "origin", "main")
	return repo, remote
}

func serveSnapshotBundle(t *testing.T, bundlePath string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		f, err := os.Open(bundlePath)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer f.Close()
		_, _ = io.Copy(w, f)
	}))
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
