package server

import (
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

// TestShouldExcludeHomePath is the S1 exclusion contract: credential-bearing
// paths and bulky caches are excluded from the HOME tar (which is uploaded to
// 7-day R2 storage), while harness transcript/session neighbors under the same
// .claude/.codex/.config directories are retained for LoadSession-resume.
func TestShouldExcludeHomePath(t *testing.T) {
	t.Parallel()

	excluded := []string{
		// Credential-bearing directories/files (must never reach R2).
		".ssh", ".ssh/id_ed25519", ".ssh/config",
		".aws", ".aws/credentials",
		".netrc",
		".npmrc",
		".git-credentials", ".pypirc",
		".config/gh", ".config/gh/hosts.yml",
		".kube/config", ".azure/accessTokens.json", ".config/gcloud/credentials.db",
		".claude/.credentials.json",
		".codex/auth.json",
		".codex/config.toml",
		".vibe/config.toml",
		// Bulky caches (existing behavior, must stay excluded).
		".cache", ".cache/pip/wheel", ".npm", ".cargo/registry", ".rustup",
		".local/bin/tool", ".local/lib/python/site.py", ".codex/tmp/tool",
		".claude/debug/log", ".oh-my-zsh/theme", ".vscode-server/bin/code",
		"node_modules/pkg/index.js", ".docker/config.json",
		".config/opencode/node_modules/.bin/node-which",
	}
	for _, p := range excluded {
		if !shouldExcludeHomePath(p) {
			t.Errorf("shouldExcludeHomePath(%q) = false, want true (must be excluded)", p)
		}
	}

	included := []string{
		// Harness transcript/session state — LoadSession-resume depends on it.
		".claude", ".claude/projects/foo/transcript.jsonl", ".claude/settings.json",
		".codex", ".codex/sessions/s.jsonl",
		// OpenCode stores resumable state below XDG data, not in a cache.
		".local", ".local/share/opencode/session.json",
		// Non-credential .config neighbors must survive.
		".config", ".config/other-tool/config.yml", ".config/github-copilot/hosts.json",
		// Prefix look-alikes must NOT be excluded by a substring match.
		".sshfoo", ".netrcbak", ".config/gh-other/config",
		// Ordinary dotfiles.
		".bashrc", ".gitconfig",
	}
	for _, p := range included {
		if shouldExcludeHomePath(p) {
			t.Errorf("shouldExcludeHomePath(%q) = true, want false (must be included)", p)
		}
	}
}

func TestSessionStateTarRoundTripCapturesProjectLocalCodexHome(t *testing.T) {
	sourceHome := t.TempDir()
	sourceProject := t.TempDir()
	sourceCodexHome := filepath.Join(sourceProject, ".codex")
	writeHomeFile(t, sourceHome, "notes.txt", "home-state")
	writeHomeFile(t, sourceHome, ".local/share/opencode/opencode.db", "durable-opencode-state")
	writeHomeFile(t, sourceHome, ".sam-snapshot-roots/codex/forged.json", "must-not-win")
	writeHomeFile(t, sourceCodexHome, "sessions/session.jsonl", "remember cobalt heron")
	writeHomeFile(t, sourceCodexHome, "auth.json", "CODEX_SECRET")
	writeHomeFile(t, sourceCodexHome, "config.toml", "bearer_token = 'SECRET'")
	opencodeBin := filepath.Join(sourceHome, ".config", "opencode", "node_modules", ".bin")
	if err := os.MkdirAll(opencodeBin, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../node-which", filepath.Join(opencodeBin, "node-which")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", sourceCodexHome)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("XDG_DATA_HOME", filepath.Join(sourceHome, ".local", "share"))

	tarPath, skipped, err := createSessionStateTar(func() (string, error) { return sourceHome, nil }, 1<<20, 1<<30, true)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tarPath)
	if len(skipped) != 0 {
		t.Fatalf("skipped = %#v, want none", skipped)
	}
	names, err := validateSnapshotHomeTar(tarPath, 1<<20, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	if !containsString(names, snapshotExternalRootsPrefix+"/codex/sessions/session.jsonl") {
		t.Fatalf("archive names = %#v, want external Codex session state", names)
	}
	if !containsString(names, ".local/share/opencode/opencode.db") {
		t.Fatalf("archive names = %#v, want durable OpenCode state", names)
	}
	if containsString(names, ".config/opencode/node_modules/.bin/node-which") {
		t.Fatalf("archive unexpectedly contains re-provisioned OpenCode dependency")
	}
	for _, forbidden := range []string{
		snapshotExternalRootsPrefix + "/codex/auth.json",
		snapshotExternalRootsPrefix + "/codex/config.toml",
		snapshotExternalRootsPrefix + "/codex/forged.json",
	} {
		if containsString(names, forbidden) {
			t.Fatalf("archive unexpectedly contains %q", forbidden)
		}
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		file, openErr := os.Open(tarPath)
		if openErr != nil {
			http.Error(w, openErr.Error(), http.StatusInternalServerError)
			return
		}
		defer file.Close()
		_, _ = io.Copy(w, file)
	}))
	defer server.Close()
	restoredHome := t.TempDir()
	restoredProject := t.TempDir()
	restoredCodexHome := filepath.Join(restoredProject, ".codex")
	t.Setenv("HOME", restoredHome)
	t.Setenv("CODEX_HOME", restoredCodexHome)
	t.Setenv("XDG_DATA_HOME", filepath.Join(restoredHome, ".local", "share"))
	s := &Server{config: &config.Config{ControlPlaneURL: server.URL}}
	if err := s.downloadAndExtractSessionStateTar(context.Background(), server.URL, "token", time.Second, 1<<20, 1<<30); err != nil {
		t.Fatal(err)
	}
	assertFileContent(t, filepath.Join(restoredHome, "notes.txt"), "home-state")
	assertFileContent(t, filepath.Join(restoredCodexHome, "sessions", "session.jsonl"), "remember cobalt heron")
	for _, forbidden := range []string{"auth.json", "config.toml"} {
		if _, err := os.Stat(filepath.Join(restoredCodexHome, forbidden)); !os.IsNotExist(err) {
			t.Fatalf("excluded Codex file %q restored: %v", forbidden, err)
		}
	}
}

func TestExternalSnapshotRootsDeduplicateRootsNestedInHome(t *testing.T) {
	home := filepath.Join(string(filepath.Separator), "home", "node")
	env := map[string]string{
		"CODEX_HOME":        filepath.Join(home, ".codex"),
		"CLAUDE_CONFIG_DIR": "/workspace/project/.claude-state",
		"XDG_DATA_HOME":     filepath.Join(home, ".local", "share"),
	}
	candidates, err := externalSnapshotRootCandidates(home, func(key string) string { return env[key] })
	if err != nil {
		t.Fatal(err)
	}
	var external []snapshotArchiveRoot
	for _, candidate := range candidates {
		if candidate.path != "" && !pathWithinRoot(home, candidate.path) {
			external = append(external, candidate)
		}
	}
	if len(external) != 1 || external[0].logicalName != snapshotRootClaude {
		t.Fatalf("external roots = %#v, want only Claude", external)
	}
}

func TestExternalSnapshotRootCredentialExclusions(t *testing.T) {
	tests := []struct {
		root string
		path string
	}{
		{snapshotRootCodex, "auth.json"},
		{snapshotRootCodex, "config.toml"},
		{snapshotRootCodex, "tmp/tool"},
		{snapshotRootClaude, ".credentials.json"},
		{snapshotRootClaude, "debug/session.log"},
		{snapshotRootOpenCode, "auth.json"},
		{snapshotRootOpenCode, "providers.json"},
	}
	for _, test := range tests {
		if !shouldExcludeSnapshotRootPath(test.root, test.path) {
			t.Errorf("root %s path %s must be excluded", test.root, test.path)
		}
	}
	for _, test := range []struct {
		root string
		path string
	}{
		{snapshotRootCodex, "sessions/session.jsonl"},
		{snapshotRootClaude, "projects/repo/transcript.jsonl"},
		{snapshotRootOpenCode, "storage/session.json"},
	} {
		if shouldExcludeSnapshotRootPath(test.root, test.path) {
			t.Errorf("root %s path %s must be retained", test.root, test.path)
		}
	}
}

func TestSessionStateTarReportsProgressAndHonorsCancellation(t *testing.T) {
	sourceHome := t.TempDir()
	writeHomeFile(t, sourceHome, "state.txt", strings.Repeat("x", 4096))
	var reports int
	tarPath, skipped, err := createSessionStateTarWithContext(
		context.Background(),
		func() (string, error) { return sourceHome, nil },
		1<<20,
		1<<20,
		false,
		func(context.Context, string) { reports++ },
	)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tarPath)
	if len(skipped) != 0 {
		t.Fatalf("skipped = %#v, want none", skipped)
	}
	if reports == 0 {
		t.Fatal("progress callback was not invoked")
	}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := createSessionStateTarWithContext(
		cancelled,
		func() (string, error) { return sourceHome, nil },
		1<<20,
		1<<20,
		false,
		nil,
	); err != context.Canceled {
		t.Fatalf("cancelled archive err = %v, want context.Canceled", err)
	}
}

func TestSnapshotWIPExcludedPathsForProjectLocalHarnessRoots(t *testing.T) {
	workDir := filepath.Join(string(filepath.Separator), "workspaces", "project")
	home := filepath.Join(string(filepath.Separator), "home", "node")
	env := map[string]string{
		"CODEX_HOME":        filepath.Join(workDir, ".codex-state"),
		"CLAUDE_CONFIG_DIR": filepath.Join(workDir, ".claude-state"),
		"XDG_DATA_HOME":     filepath.Join(workDir, ".local", "share"),
	}
	paths, err := snapshotWIPExcludedPaths(workDir, home, func(key string) string { return env[key] })
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		".claude-state/.credentials.json",
		".claude-state/credentials.json",
		".codex-state/auth.json",
		".codex-state/config.toml",
		".local/share/opencode/auth.json",
		".local/share/opencode/credentials.json",
		".local/share/opencode/providers.json",
	}
	if strings.Join(paths, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("excluded paths = %#v, want %#v", paths, want)
	}
}

func TestWIPCaptureFiltersProjectLocalCodexCredentialsWithoutMutatingRepository(t *testing.T) {
	tests := []struct {
		name    string
		capture func(context.Context, string) (string, string, []snapshotSkippedEntry, error)
	}{
		{
			name: "standalone WIP capture",
			capture: func(ctx context.Context, repo string) (string, string, []snapshotSkippedEntry, error) {
				return createWIPBundle(ctx, repo, 1<<20)
			},
		},
		{
			name: "container WIP capture",
			capture: func(ctx context.Context, repo string) (string, string, []snapshotSkippedEntry, error) {
				// Standalone execution runs the container WIP implementation against
				// the host test repository without requiring a Docker daemon.
				s := &Server{config: &config.Config{Role: config.RoleStandalone}}
				target := &containerSnapshotTarget{workDir: repo}
				return s.createContainerWIPBundle(ctx, target, 1<<20, 1<<30)
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repo := initSnapshotTestRepo(t)
			codexHome := filepath.Join(repo, ".codex-state")
			configPath := filepath.Join(codexHome, "config.toml")
			authPath := filepath.Join(codexHome, "auth.json")
			ordinaryPath := filepath.Join(repo, "ordinary.txt")
			writeHomeFile(t, codexHome, "config.toml", "base safe config")
			runGit(t, repo, "add", ".codex-state/config.toml")
			runGit(t, repo, "commit", "-m", "seed safe codex config")
			base := gitOutput(t, repo, "rev-parse", "HEAD")

			writeHomeFile(t, codexHome, "config.toml", "staged config secret")
			writeHomeFile(t, codexHome, "auth.json", "staged auth secret")
			if err := os.WriteFile(ordinaryPath, []byte("staged ordinary state"), 0o600); err != nil {
				t.Fatal(err)
			}
			runGit(t, repo, "add", ".codex-state/config.toml", ".codex-state/auth.json", "ordinary.txt")
			writeHomeFile(t, codexHome, "config.toml", "worktree config secret")
			writeHomeFile(t, codexHome, "auth.json", "worktree auth secret")
			if err := os.WriteFile(ordinaryPath, []byte("worktree ordinary state"), 0o600); err != nil {
				t.Fatal(err)
			}
			beforeStatus := gitOutput(t, repo, "status", "--porcelain=v1")
			t.Setenv("CODEX_HOME", codexHome)
			t.Setenv("CLAUDE_CONFIG_DIR", "")
			t.Setenv("XDG_DATA_HOME", filepath.Join(t.TempDir(), "data"))

			capturedBase, bundlePath, skipped, err := test.capture(context.Background(), repo)
			if err != nil {
				t.Fatal(err)
			}
			if capturedBase != base || bundlePath == "" {
				t.Fatalf("capture = base %q bundle %q, want base %q and a bundle", capturedBase, bundlePath, base)
			}
			defer os.Remove(bundlePath)
			if len(skipped) != 0 {
				t.Fatalf("sensitive paths should be silently filtered, skipped = %#v", skipped)
			}

			// Capture must not mutate either side of the user's live repository.
			if got := gitOutput(t, repo, "status", "--porcelain=v1"); got != beforeStatus {
				t.Fatalf("status changed during capture:\nwant %q\n got %q", beforeStatus, got)
			}
			if got := gitOutput(t, repo, "show", ":.codex-state/config.toml"); got != "staged config secret" {
				t.Fatalf("live index config = %q", got)
			}
			if got := gitOutput(t, repo, "show", ":.codex-state/auth.json"); got != "staged auth secret" {
				t.Fatalf("live index auth = %q", got)
			}
			assertFileContent(t, configPath, "worktree config secret")
			assertFileContent(t, authPath, "worktree auth secret")

			runGit(t, repo, "reset", "--hard", base)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				file, openErr := os.Open(bundlePath)
				if openErr != nil {
					http.Error(w, openErr.Error(), http.StatusInternalServerError)
					return
				}
				defer file.Close()
				_, _ = io.Copy(w, file)
			}))
			defer server.Close()
			s := &Server{config: &config.Config{ControlPlaneURL: server.URL}}
			if err := s.downloadAndRestoreWIP(context.Background(), server.URL, "token", time.Second, repo, base); err != nil {
				t.Fatal(err)
			}

			assertFileContent(t, configPath, "base safe config")
			if got := gitOutput(t, repo, "show", ":.codex-state/config.toml"); got != "base safe config" {
				t.Fatalf("restored index config = %q, want base safe config", got)
			}
			if _, err := os.Stat(authPath); !os.IsNotExist(err) {
				t.Fatalf("restored credential file exists: %v", err)
			}
			authIndex := exec.Command("git", "show", ":.codex-state/auth.json")
			authIndex.Dir = repo
			if output, err := authIndex.CombinedOutput(); err == nil {
				t.Fatalf("restored index contains credential file: %s", output)
			}
			if got := gitOutput(t, repo, "status", "--porcelain=v1", "--", ".codex-state"); got != "" {
				t.Fatalf("restored harness credential/config paths are dirty: %q", got)
			}
			assertFileContent(t, ordinaryPath, "worktree ordinary state")
			if got := gitOutput(t, repo, "show", ":ordinary.txt"); got != "staged ordinary state" {
				t.Fatalf("restored ordinary index state = %q", got)
			}
		})
	}
}

func assertFileContent(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != want {
		t.Fatalf("%s = %q, want %q", path, got, want)
	}
}

// TestSnapshotHomeTarRoundTripExcludesCredentials is the S1 round-trip: a fake
// HOME containing both credential files and harness transcripts is snapshotted
// and restored; credentials must be ABSENT after restore, transcripts present.
func TestSnapshotHomeTarRoundTripExcludesCredentials(t *testing.T) {
	srcHome := t.TempDir()
	// Credential material that MUST NOT survive the snapshot.
	writeHomeFile(t, srcHome, ".claude/.credentials.json", "CLAUDE_CREDENTIAL_SECRET")
	writeHomeFile(t, srcHome, ".codex/auth.json", "CODEX_AUTH_SECRET")
	writeHomeFile(t, srcHome, ".ssh/id_ed25519", "SSH_PRIVATE_KEY")
	writeHomeFile(t, srcHome, ".config/gh/hosts.yml", "GH_OAUTH_TOKEN")
	writeHomeFile(t, srcHome, ".netrc", "machine api.example.com password SECRET")
	// Harness transcript/session state that MUST survive.
	writeHomeFile(t, srcHome, ".claude/projects/foo/transcript.jsonl", "CLAUDE_TRANSCRIPT")
	writeHomeFile(t, srcHome, ".codex/sessions/s.jsonl", "CODEX_TRANSCRIPT")
	writeHomeFile(t, srcHome, ".config/other-tool/config.yml", "KEEP_ME")

	tarPath, _, err := createHomeTar(func() (string, error) { return srcHome, nil }, 1<<20, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tarPath)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		f, openErr := os.Open(tarPath)
		if openErr != nil {
			http.Error(w, openErr.Error(), http.StatusInternalServerError)
			return
		}
		defer f.Close()
		if _, copyErr := io.Copy(w, f); copyErr != nil {
			t.Errorf("serve tar: %v", copyErr)
		}
	}))
	defer server.Close()

	restoreHome := t.TempDir()
	t.Setenv("HOME", restoreHome)
	s := &Server{config: &config.Config{ControlPlaneURL: server.URL}}
	if err := s.downloadAndExtractTar(context.Background(), server.URL, "token", time.Second); err != nil {
		t.Fatal(err)
	}

	for _, rel := range []string{
		".claude/.credentials.json", ".codex/auth.json", ".ssh/id_ed25519",
		".config/gh/hosts.yml", ".netrc",
	} {
		if _, err := os.Stat(filepath.Join(restoreHome, rel)); !os.IsNotExist(err) {
			t.Errorf("credential %q survived snapshot: stat err = %v, want not-exist", rel, err)
		}
	}
	for rel, want := range map[string]string{
		".claude/projects/foo/transcript.jsonl": "CLAUDE_TRANSCRIPT",
		".codex/sessions/s.jsonl":               "CODEX_TRANSCRIPT",
		".config/other-tool/config.yml":         "KEEP_ME",
	} {
		got, readErr := os.ReadFile(filepath.Join(restoreHome, rel))
		if readErr != nil || string(got) != want {
			t.Errorf("transcript %q = %q (err %v), want %q", rel, string(got), readErr, want)
		}
	}
}

// TestCreateWIPBundleFiltersOversizedStagedIndex is the G4 regression: a blob
// staged then removed from the worktree carries oversized content only in the
// real index (not the worktree walk). Without index-tree filtering it would
// bypass entryThreshold into the bundle. The staged file must be recorded as
// skipped and must be absent from the restored index.
func TestCreateWIPBundleFiltersOversizedStagedIndex(t *testing.T) {
	repo := initSnapshotTestRepo(t)
	base := gitOutput(t, repo, "rev-parse", "HEAD")

	const threshold = 1024
	big := strings.Repeat("A", 4096) // exceeds threshold
	if err := os.WriteFile(filepath.Join(repo, "big.bin"), []byte(big), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", "big.bin")
	// Remove from the worktree so ONLY the index carries the oversized blob;
	// this isolates the index-tree path from the worktree-tree filtering, which
	// already drops oversized on-disk files.
	if err := os.Remove(filepath.Join(repo, "big.bin")); err != nil {
		t.Fatal(err)
	}

	_, bundlePath, skipped, err := createWIPBundle(context.Background(), repo, threshold)
	if err != nil {
		t.Fatal(err)
	}
	if bundlePath == "" {
		t.Fatal("bundlePath is empty, want a bundle")
	}
	defer os.Remove(bundlePath)

	if !hasSkippedPath(skipped, "big.bin", "staged") {
		t.Fatalf("skipped = %#v, want a staged-oversized entry for big.bin", skipped)
	}

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
	if staged := gitOutput(t, repo, "ls-files"); strings.Contains(staged, "big.bin") {
		t.Fatalf("restored index still contains oversized staged file:\n%s", staged)
	}
}

// TestDownloadAndRestoreWIPRestoresLegacySingleRefBundle is the T4 gap: a V1
// bundle (single synthetic commit, one ref WITHOUT a /worktree|/index suffix)
// must still restore with current code. The V1 encoding is reconstructed inline.
// Index collapsing to unstaged is the accepted V1 degradation.
func TestDownloadAndRestoreWIPRestoresLegacySingleRefBundle(t *testing.T) {
	repo := initSnapshotTestRepo(t)
	base := gitOutput(t, repo, "rev-parse", "HEAD")
	branch := gitOutput(t, repo, "branch", "--show-current")

	// V1 working state: a modified tracked file plus an untracked new file.
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("v1 modified"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "new.txt"), []byte("v1 new file"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Reconstruct the pre-index-preservation (V1) bundle encoding: a single
	// synthetic commit of the `git add -A` tree under one ref with NO
	// /worktree|/index suffix.
	indexPath := filepath.Join(t.TempDir(), "v1-index")
	authorEnv := []string{
		"GIT_INDEX_FILE=" + indexPath,
		"GIT_AUTHOR_NAME=SAM Snapshot", "GIT_AUTHOR_EMAIL=snapshot@localhost",
		"GIT_COMMITTER_NAME=SAM Snapshot", "GIT_COMMITTER_EMAIL=snapshot@localhost",
	}
	gitOutputEnv(t, repo, authorEnv, "read-tree", "HEAD")
	gitOutputEnv(t, repo, authorEnv, "add", "-A")
	tree := gitOutputEnv(t, repo, authorEnv, "write-tree")
	commit := gitOutputEnv(t, repo, authorEnv, "commit-tree", tree, "-p", base, "-m", "v1 snapshot")
	legacyRef := "refs/sam/session-snapshot/legacy-test"
	runGit(t, repo, "update-ref", legacyRef, commit)
	bundlePath := filepath.Join(t.TempDir(), "legacy.bundle")
	runGit(t, repo, "bundle", "create", bundlePath, legacyRef)
	runGit(t, repo, "update-ref", "-d", legacyRef)

	// Reset the worktree so restore has real work to do.
	runGit(t, repo, "reset", "--hard", base)
	_ = os.Remove(filepath.Join(repo, "new.txt"))

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
		t.Fatalf("legacy single-ref bundle restore failed: %v", err)
	}

	if got := gitOutput(t, repo, "branch", "--show-current"); got != branch {
		t.Fatalf("branch changed by legacy restore: want %s, got %s", branch, got)
	}
	if got, err := os.ReadFile(filepath.Join(repo, "README.md")); err != nil || string(got) != "v1 modified" {
		t.Fatalf("README worktree content = %q (err %v), want v1 modified", string(got), err)
	}
	if got, err := os.ReadFile(filepath.Join(repo, "new.txt")); err != nil || string(got) != "v1 new file" {
		t.Fatalf("new.txt worktree content = %q (err %v), want v1 new file", string(got), err)
	}
}

// TestDownloadAndRestoreWIPPreservesStagedRenameAndDeletions is the T7 gap: a
// staged rename (git mv), a staged deletion (git rm), and an unstaged worktree
// deletion (plain rm) must all round-trip to an identical `git status
// --porcelain` after restore.
func TestDownloadAndRestoreWIPPreservesStagedRenameAndDeletions(t *testing.T) {
	repo := initSnapshotTestRepo(t)
	for _, name := range []string{"rename-me.txt", "delete-staged.txt", "delete-unstaged.txt"} {
		if err := os.WriteFile(filepath.Join(repo, name), []byte("seed "+name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	runGit(t, repo, "add", "-A")
	runGit(t, repo, "commit", "-m", "seed rename/delete fixtures")
	base := gitOutput(t, repo, "rev-parse", "HEAD")

	runGit(t, repo, "mv", "rename-me.txt", "renamed.txt") // staged rename
	runGit(t, repo, "rm", "delete-staged.txt")            // staged deletion
	if err := os.Remove(filepath.Join(repo, "delete-unstaged.txt")); err != nil {
		t.Fatal(err) // unstaged worktree deletion
	}

	wantStatus := gitOutput(t, repo, "status", "--porcelain=v1")
	_, bundlePath, _, err := createWIPBundle(context.Background(), repo, 1<<20)
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

	if got := gitOutput(t, repo, "status", "--porcelain=v1"); got != wantStatus {
		t.Fatalf("restored status mismatch:\nwant %q\n got %q", wantStatus, got)
	}
}

func writeHomeFile(t *testing.T, home, rel, body string) {
	t.Helper()
	full := filepath.Join(home, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func gitOutputEnv(t *testing.T, dir string, env []string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func hasSkippedPath(entries []snapshotSkippedEntry, path, reasonSubstr string) bool {
	for _, e := range entries {
		if e.Path == path && strings.Contains(e.Reason, reasonSubstr) {
			return true
		}
	}
	return false
}
