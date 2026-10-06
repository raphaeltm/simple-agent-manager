package server

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
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
	mustWriteSnapshotFile(t, repo, "README.md", "staged")
	runGit(t, repo, "add", "README.md")
	mustWriteSnapshotFile(t, repo, "README.md", "staged and unstaged")
	mustWriteSnapshotFile(t, repo, "untracked.txt", "untracked")
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

	server := serveSnapshotBundle(t, bundlePath)
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

	server := serveSnapshotBundle(t, bundlePath)
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

func TestCreateWIPBundlePreservesCleanRemoteCommit(t *testing.T) {
	repo, _ := initSnapshotRemoteRepo(t)
	state, err := captureStandaloneSnapshotGitState(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	base, bundlePath, _, err := createWIPBundle(context.Background(), repo, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if bundlePath == "" {
		t.Fatal("clean remotely reachable HEAD did not produce a Git bundle")
	}
	defer os.Remove(bundlePath)
	if base != state.BaseCommit || state.BaseCommit != gitOutput(t, repo, "rev-parse", "HEAD") {
		t.Fatalf("captured base = %q, want current HEAD", state.BaseCommit)
	}
	if state.Git == nil || state.Git.Branch != "main" || state.Git.Upstream != "origin/main" {
		t.Fatalf("captured git metadata = %#v", state.Git)
	}
}

func TestCaptureWIPUploadsAndRestoresCleanLocalOnlyCommit(t *testing.T) {
	repo, remote := initSnapshotRemoteRepo(t)
	runGit(t, repo, "checkout", "-b", "sam/local-only-capture")
	if err := os.WriteFile(filepath.Join(repo, "local-only.txt"), []byte("preserved"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", "local-only.txt")
	runGit(t, repo, "commit", "-m", "local only capture")
	wantHead := gitOutput(t, repo, "rev-parse", "HEAD")

	var uploaded []byte
	artifactServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			var err error
			uploaded, err = io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		case http.MethodGet:
			_, _ = w.Write(uploaded)
		default:
			http.Error(w, "unexpected method", http.StatusMethodNotAllowed)
		}
	}))
	defer artifactServer.Close()

	server := &Server{config: &config.Config{ControlPlaneURL: artifactServer.URL}}
	prepare := &snapshotPrepareResponse{}
	prepare.Upload.WIP = "/wip"
	manifest := &snapshotManifest{Artifacts: map[string]snapshotArtifact{}}
	capture := snapshotArtifactCapture{
		server:      server,
		workDir:     repo,
		token:       "callback-token",
		prepare:     prepare,
		threshold:   defaultSnapshotEntryThresholdBytes,
		budget:      defaultSnapshotTotalBudgetBytes,
		idleTimeout: time.Second,
		progress:    &snapshotProgressReporter{},
		manifest:    manifest,
	}
	if failed := capture.captureWIP(context.Background()); failed {
		t.Fatalf("captureWIP failed: skipped=%#v", manifest.Skipped)
	}
	if len(uploaded) == 0 {
		t.Fatal("captureWIP uploaded no Git bundle")
	}
	if manifest.BaseCommit != wantHead {
		t.Fatalf("manifest baseCommit = %q, want %q", manifest.BaseCommit, wantHead)
	}
	if manifest.Git == nil || manifest.Git.Branch != "sam/local-only-capture" || manifest.Git.Detached {
		t.Fatalf("manifest Git metadata = %#v", manifest.Git)
	}

	bundlePath := filepath.Join(t.TempDir(), "captured.bundle")
	if err := os.WriteFile(bundlePath, uploaded, 0o600); err != nil {
		t.Fatal(err)
	}
	if heads := gitOutput(t, repo, "bundle", "list-heads", bundlePath); !strings.Contains(heads, "/worktree") || !strings.Contains(heads, "/index") {
		t.Fatalf("uploaded bundle heads = %q", heads)
	}
	size, checksum, err := snapshotFileIdentity(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	artifact, ok := manifest.Artifacts["wip"]
	if !ok || artifact.SizeBytes != size || artifact.SHA256 != checksum {
		t.Fatalf("manifest WIP artifact = %#v, want size=%d sha=%s", artifact, size, checksum)
	}

	restored := filepath.Join(t.TempDir(), "restored")
	runGit(t, filepath.Dir(restored), "clone", "--single-branch", "--branch", "main", remote, restored)
	state := snapshotGitState{BaseCommit: manifest.BaseCommit, Git: manifest.Git}
	if err := server.downloadAndRestoreWIPWithGitState(context.Background(), artifactServer.URL+"/wip", "", time.Second, restored, state); err != nil {
		t.Fatal(err)
	}
	if got := gitOutput(t, restored, "rev-parse", "HEAD"); got != wantHead {
		t.Fatalf("restored HEAD = %q, want %q", got, wantHead)
	}
	if got := gitOutput(t, restored, "branch", "--show-current"); got != "sam/local-only-capture" {
		t.Fatalf("restored branch = %q", got)
	}
	if got := gitOutput(t, restored, "status", "--porcelain=v1"); got != "" {
		t.Fatalf("restored worktree is dirty: %q", got)
	}
}

func TestCreateWIPBundlePreservesHeadWhenRemoteTrackingRefIsStale(t *testing.T) {
	repo, remote := initSnapshotRemoteRepo(t)
	runGit(t, repo, "checkout", "-b", "sam/stale-task")
	if err := os.WriteFile(filepath.Join(repo, "stale.txt"), []byte("must survive"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", "stale.txt")
	runGit(t, repo, "commit", "-m", "stale remote task")
	runGit(t, repo, "push", "-u", "origin", "sam/stale-task")
	runGit(t, remote, "update-ref", "-d", "refs/heads/sam/stale-task")

	if got := gitOutput(t, repo, "rev-parse", "refs/remotes/origin/sam/stale-task"); got == "" {
		t.Fatal("expected stale remote-tracking ref to remain locally")
	}
	_, bundlePath, _, err := createWIPBundle(context.Background(), repo, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if bundlePath == "" {
		t.Fatal("stale remote-tracking ref suppressed the required Git bundle")
	}
	defer os.Remove(bundlePath)
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
	seed, remote, wantHead := createRemoteTaskCommit(t, "sam/saved-task", "saved.txt")
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

func TestContainerCleanLocalOnlyCommitBundlesAndRestoresExactGitState(t *testing.T) {
	repo, remote := initSnapshotRemoteRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "container-local.txt"), []byte("container local commit"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", "container-local.txt")
	runGit(t, repo, "commit", "-m", "container local only")
	wantHead := gitOutput(t, repo, "rev-parse", "HEAD")

	s := &Server{config: &config.Config{Role: config.RoleStandalone}}
	target := &containerSnapshotTarget{workDir: repo}
	state, bundlePath := captureContainerSnapshotBundle(t, s, target)
	if bundlePath == "" {
		t.Fatal("clean local-only container snapshot did not produce a Git bundle")
	}
	defer os.Remove(bundlePath)

	restored := filepath.Join(t.TempDir(), "restored")
	runGit(t, filepath.Dir(restored), "clone", "--single-branch", "--branch", "main", remote, restored)
	restoreContainerSnapshotBundle(t, s, restored, bundlePath, state)
	if got := gitOutput(t, restored, "rev-parse", "HEAD"); got != wantHead {
		t.Fatalf("restored container HEAD = %q, want local-only commit %q", got, wantHead)
	}
	if got := gitOutput(t, restored, "status", "--porcelain=v1"); got != "" {
		t.Fatalf("restored container snapshot status = %q, want clean", got)
	}
}

func TestContainerDirtySnapshotRestoresSavedCommitBeforeWIP(t *testing.T) {
	seed, remote, wantHead := createRemoteTaskCommit(t, "sam/container-task", "container-task.txt")
	if err := os.WriteFile(filepath.Join(seed, "container-task.txt"), []byte("dirty container snapshot"), 0o600); err != nil {
		t.Fatal(err)
	}

	s := &Server{config: &config.Config{Role: config.RoleStandalone}}
	target := &containerSnapshotTarget{workDir: seed}
	state, bundlePath := captureContainerSnapshotBundle(t, s, target)
	defer os.Remove(bundlePath)

	restored := filepath.Join(t.TempDir(), "restored")
	runGit(t, filepath.Dir(restored), "clone", "--branch", "main", remote, restored)
	restoreContainerSnapshotBundle(t, s, restored, bundlePath, state)
	if got := gitOutput(t, restored, "rev-parse", "HEAD"); got != wantHead {
		t.Fatalf("restored container HEAD = %q, want saved commit %q", got, wantHead)
	}
	if got := gitOutput(t, restored, "diff", "--", "container-task.txt"); !strings.Contains(got, "dirty container snapshot") {
		t.Fatalf("restored container WIP diff = %q, want dirty snapshot", got)
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

func TestValidateCapturedSnapshotGitStateRejectsCheckoutDuringCapture(t *testing.T) {
	repo := initSnapshotTestRepo(t)
	state, err := captureStandaloneSnapshotGitState(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "checkout", "-b", "changed-during-capture")
	err = validateCapturedSnapshotGitState(context.Background(), standaloneSnapshotGit(repo), state)
	if err == nil || !strings.Contains(err.Error(), "changed during capture") {
		t.Fatalf("capture coherence error = %v, want changed-during-capture diagnostics", err)
	}
}

func TestCaptureSnapshotGitStateOmitsNonCanonicalUpstream(t *testing.T) {
	repo := initSnapshotTestRepo(t)
	runGit(t, repo, "remote", "add", "backup", filepath.Join(t.TempDir(), "backup.git"))
	branch := gitOutput(t, repo, "branch", "--show-current")
	runGit(t, repo, "update-ref", "refs/remotes/backup/"+branch, "HEAD")
	runGit(t, repo, "config", "branch."+branch+".remote", "backup")
	runGit(t, repo, "config", "branch."+branch+".merge", "refs/heads/"+branch)
	state, err := captureStandaloneSnapshotGitState(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	if state.Git == nil || state.Git.Branch != branch || state.Git.Upstream != "" || state.Git.Remote != "" {
		t.Fatalf("captured Git metadata = %#v, want branch-only metadata", state.Git)
	}
	if err := validateCapturedSnapshotGitState(context.Background(), standaloneSnapshotGit(repo), state); err != nil {
		t.Fatalf("validate branch-only metadata: %v", err)
	}
}

func TestEnsureSnapshotUpstreamAvailableFetchesExactRemoteTrackingRef(t *testing.T) {
	repo, _ := initSnapshotRemoteRepo(t)
	runGit(t, repo, "update-ref", "-d", "refs/remotes/origin/main")
	runGit(t, repo, "branch", "origin/main", "HEAD")
	state := snapshotGitState{Git: &snapshotGitMetadata{
		Branch:   "main",
		Upstream: "origin/main",
		Remote:   "origin",
	}}
	if err := ensureSnapshotUpstreamAvailable(context.Background(), standaloneSnapshotGit(repo), state); err != nil {
		t.Fatal(err)
	}
	if got := gitOutput(t, repo, "show-ref", "--verify", "refs/remotes/origin/main"); got == "" {
		t.Fatal("exact remote-tracking ref was not fetched")
	}
}

func TestTerminalRestoreReportRejectsHeadChangedDuringHarnessResume(t *testing.T) {
	repo := initSnapshotTestRepo(t)
	savedState, err := captureStandaloneSnapshotGitState(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "later.txt"), []byte("later"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", "later.txt")
	runGit(t, repo, "commit", "-m", "simulate harness changing HEAD")
	actualHead := gitOutput(t, repo, "rev-parse", "HEAD")

	var reports []map[string]string
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/session-snapshot/restore-result") {
			http.NotFound(w, r)
			return
		}
		var payload map[string]string
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		reports = append(reports, payload)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer controlPlane.Close()

	s := &Server{config: &config.Config{ControlPlaneURL: controlPlane.URL}}
	err = s.reportRestoredSnapshotIfGitStateMatches(
		context.Background(),
		"workspace-1",
		"chat-1",
		"callback-token",
		func() error { return validateStandaloneSnapshotGitState(context.Background(), repo, savedState) },
	)
	if err == nil || !strings.Contains(err.Error(), savedState.BaseCommit) || !strings.Contains(err.Error(), actualHead) {
		t.Fatalf("terminal validation error = %v, want expected and actual HEAD diagnostics", err)
	}
	if len(reports) != 1 || reports[0]["status"] != "git_mismatch" {
		t.Fatalf("restore reports = %#v, want one git_mismatch report", reports)
	}
	for _, report := range reports {
		if report["status"] == "restored" {
			t.Fatalf("terminal mismatch emitted restored report: %#v", reports)
		}
	}
}

func TestSnapshotRestoreDiagnosticRedactsCredentialURLsAndCapsOutput(t *testing.T) {
	s := &Server{config: &config.Config{ErrorReportStringBytes: 96}}
	diagnostic := s.snapshotRestoreDiagnostic(
		"fatal:\nhttps://git-user:user-password@example.invalid/repo.git?access_token=query-secret " + strings.Repeat("x", 200),
	)
	for _, secret := range []string{"git-user", "user-password", "query-secret"} {
		if strings.Contains(diagnostic, secret) {
			t.Fatalf("diagnostic leaked %q: %q", secret, diagnostic)
		}
	}
	if len(diagnostic) > 96 {
		t.Fatalf("diagnostic length = %d, want at most 96 bytes", len(diagnostic))
	}
	if strings.ContainsAny(diagnostic, "\r\n\x00") {
		t.Fatalf("diagnostic retained control characters: %q", diagnostic)
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

func mustWriteSnapshotFile(t *testing.T, repo, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(repo, name), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func createRemoteTaskCommit(t *testing.T, branch, file string) (string, string, string) {
	t.Helper()
	seed, remote := initSnapshotRemoteRepo(t)
	runGit(t, seed, "checkout", "-b", branch)
	mustWriteSnapshotFile(t, seed, file, "saved")
	runGit(t, seed, "add", file)
	runGit(t, seed, "commit", "-m", "saved task")
	runGit(t, seed, "push", "-u", "origin", branch)
	return seed, remote, gitOutput(t, seed, "rev-parse", "HEAD")
}

func captureContainerSnapshotBundle(t *testing.T, s *Server, target *containerSnapshotTarget) (snapshotGitState, string) {
	t.Helper()
	state, err := captureSnapshotGitState(context.Background(), func(ctx context.Context, env []string, args ...string) (string, error) {
		return s.containerGit(ctx, target, env, args...)
	})
	if err != nil {
		t.Fatal(err)
	}
	_, bundlePath, _, err := s.createContainerWIPBundle(context.Background(), target, 1024, 1<<30, nil)
	if err != nil {
		t.Fatal(err)
	}
	return state, bundlePath
}

func restoreContainerSnapshotBundle(t *testing.T, s *Server, restored, bundlePath string, state snapshotGitState) {
	t.Helper()
	bundleServer := serveSnapshotBundle(t, bundlePath)
	t.Cleanup(bundleServer.Close)
	s.config.ControlPlaneURL = bundleServer.URL
	target := &containerSnapshotTarget{workDir: restored}
	if err := s.downloadAndRestoreContainerWIPWithGitState(context.Background(), target, bundleServer.URL, "token", time.Second, 1<<30, state); err != nil {
		t.Fatal(err)
	}
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
