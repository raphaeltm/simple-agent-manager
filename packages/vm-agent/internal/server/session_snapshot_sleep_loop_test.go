package server

// Regression tests for idle VM sessions that could never sleep (2026-10-03).
// The WIP bundle packed the whole branch history, starving HOME of the snapshot
// budget. The resulting skipped-file list pushed the completion request past the
// control plane's JSON limit, and a one-exec-per-file size check made each
// capture take about ten minutes. No capture ever completed, so sleep (which
// requires a complete snapshot) never ran.

import (
	"archive/tar"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

// initSnapshotRemoteRepoWithHistory returns a repository whose default-branch
// history holds a large, incompressible blob that is no longer in HEAD.
// refs/remotes/origin/HEAD points at origin/main, as it does in a real clone.
func initSnapshotRemoteRepoWithHistory(t *testing.T, historyBytes int) (repo, remote, defaultTip string) {
	t.Helper()
	repo, remote = initSnapshotRemoteRepo(t)
	blob := make([]byte, historyBytes)
	if _, err := rand.Read(blob); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "history.bin"), blob, 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", "history.bin")
	runGit(t, repo, "commit", "-m", "large history")
	runGit(t, repo, "rm", "-q", "history.bin")
	runGit(t, repo, "commit", "-m", "drop large history from HEAD")
	runGit(t, repo, "push", "origin", "main")
	runGit(t, repo, "remote", "set-head", "origin", "main")
	return repo, remote, gitOutput(t, repo, "rev-parse", "origin/main")
}

// writeLocalTaskWork leaves an unpushed commit, an unstaged edit and an
// untracked file on a new branch, and returns the local commit.
func writeLocalTaskWork(t *testing.T, repo, branch string) string {
	t.Helper()
	runGit(t, repo, "checkout", "-b", branch)
	mustWriteSnapshotFile(t, repo, "local-commit.txt", "committed locally, never pushed")
	runGit(t, repo, "add", "local-commit.txt")
	runGit(t, repo, "commit", "-m", "local only")
	mustWriteSnapshotFile(t, repo, "README.md", "uncommitted edit")
	mustWriteSnapshotFile(t, repo, "untracked.txt", "untracked work")
	return gitOutput(t, repo, "rev-parse", "HEAD")
}

func assertRestoredLocalTaskWork(t *testing.T, restored, wantHead, branch string) {
	t.Helper()
	if got := gitOutput(t, restored, "rev-parse", "HEAD"); got != wantHead {
		t.Fatalf("restored HEAD = %q, want local commit %q", got, wantHead)
	}
	if got := gitOutput(t, restored, "branch", "--show-current"); got != branch {
		t.Fatalf("restored branch = %q, want %q", got, branch)
	}
	for name, want := range map[string]string{
		"local-commit.txt": "committed locally, never pushed",
		"README.md":        "uncommitted edit",
		"untracked.txt":    "untracked work",
	} {
		got, err := os.ReadFile(filepath.Join(restored, name))
		if err != nil || string(got) != want {
			t.Fatalf("restored %s = %q (err %v), want %q", name, got, err, want)
		}
	}
}

func cloneSnapshotRemote(t *testing.T, remote string) string {
	t.Helper()
	restored := filepath.Join(t.TempDir(), "restored")
	runGit(t, filepath.Dir(restored), "clone", "--branch", "main", remote, restored)
	return restored
}

func restoreStandaloneSnapshotBundle(t *testing.T, restored, bundlePath string, state snapshotGitState) {
	t.Helper()
	server := serveSnapshotBundle(t, bundlePath)
	t.Cleanup(server.Close)
	s := &Server{config: &config.Config{ControlPlaneURL: server.URL}}
	if err := s.downloadAndRestoreWIPWithGitState(context.Background(), server.URL, "token", time.Second, restored, state); err != nil {
		t.Fatal(err)
	}
}

func bundleSize(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Size()
}

func TestWIPBundleExcludesDefaultBranchHistory(t *testing.T) {
	const historyBytes = 512 * 1024
	repo, remote, defaultTip := initSnapshotRemoteRepoWithHistory(t, historyBytes)
	wantHead := writeLocalTaskWork(t, repo, "sam/basis-task")
	state, err := captureStandaloneSnapshotGitState(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}

	_, bundlePath, _, err := createWIPBundle(context.Background(), repo, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(bundlePath)

	prerequisites, err := snapshotBundlePrerequisites(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(prerequisites, []string{defaultTip}) {
		t.Fatalf("bundle prerequisites = %v, want only the default-branch tip %s", prerequisites, defaultTip)
	}
	if size := bundleSize(t, bundlePath); size >= historyBytes/4 {
		t.Fatalf("WIP bundle is %d bytes: it still carries the %d-byte default-branch history", size, historyBytes)
	}

	restored := cloneSnapshotRemote(t, remote)
	restoreStandaloneSnapshotBundle(t, restored, bundlePath, state)
	assertRestoredLocalTaskWork(t, restored, wantHead, "sam/basis-task")
}

func TestWIPBundleWithoutDefaultBranchRefStaysSelfContained(t *testing.T) {
	repo, _ := initSnapshotRemoteRepo(t)
	if out, err := runStandaloneGitCommand(context.Background(), repo, nil, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD"); err == nil {
		t.Fatalf("precondition: repository unexpectedly has origin/HEAD (%s)", out)
	}
	writeLocalTaskWork(t, repo, "sam/no-default-ref")

	_, bundlePath, _, err := createWIPBundle(context.Background(), repo, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(bundlePath)

	prerequisites, err := snapshotBundlePrerequisites(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	if len(prerequisites) != 0 {
		t.Fatalf("bundle without a default-branch ref has prerequisites %v, want a self-contained bundle", prerequisites)
	}
}

// A branch that was pushed and then deleted remotely leaves a stale
// remote-tracking ref. Its commit must travel inside the bundle: excluding all
// remote-tracking refs would make it an unfetchable prerequisite and lose it.
func TestWIPBundleKeepsCommitReachableOnlyFromStaleRemoteRef(t *testing.T) {
	repo, remote, defaultTip := initSnapshotRemoteRepoWithHistory(t, 4096)
	runGit(t, repo, "checkout", "-b", "sam/stale-task")
	mustWriteSnapshotFile(t, repo, "stale.txt", "must survive")
	runGit(t, repo, "add", "stale.txt")
	runGit(t, repo, "commit", "-m", "stale remote task")
	runGit(t, repo, "push", "-u", "origin", "sam/stale-task")
	runGit(t, remote, "update-ref", "-d", "refs/heads/sam/stale-task")
	// Isolate the bundle property from upstream restoration, which cannot
	// re-track a branch that no longer exists remotely.
	runGit(t, repo, "branch", "--unset-upstream")
	staleHead := gitOutput(t, repo, "rev-parse", "HEAD")
	if got := gitOutput(t, repo, "rev-parse", "refs/remotes/origin/sam/stale-task"); got != staleHead {
		t.Fatalf("precondition: stale remote-tracking ref = %q, want %q", got, staleHead)
	}
	state, err := captureStandaloneSnapshotGitState(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}

	_, bundlePath, _, err := createWIPBundle(context.Background(), repo, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(bundlePath)
	prerequisites, err := snapshotBundlePrerequisites(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(prerequisites, []string{defaultTip}) {
		t.Fatalf("bundle prerequisites = %v, want only the default-branch tip %s", prerequisites, defaultTip)
	}

	restored := cloneSnapshotRemote(t, remote)
	restoreStandaloneSnapshotBundle(t, restored, bundlePath, state)
	if got := gitOutput(t, restored, "rev-parse", "HEAD"); got != staleHead {
		t.Fatalf("restored HEAD = %q, want commit from the deleted branch %q", got, staleHead)
	}
	if got, err := os.ReadFile(filepath.Join(restored, "stale.txt")); err != nil || string(got) != "must survive" {
		t.Fatalf("restored stale.txt = %q (err %v)", got, err)
	}
}

// A wake clone made before the default branch advanced lacks the bundle's
// prerequisite. Restore must fetch it from origin instead of failing with
// "Repository lacks these prerequisite commits".
func TestRestoreFetchesMissingBundlePrerequisite(t *testing.T) {
	repo, remote, _ := initSnapshotRemoteRepoWithHistory(t, 4096)
	staleClone := cloneSnapshotRemote(t, remote)
	mustWriteSnapshotFile(t, repo, "advance.txt", "default branch moved on")
	runGit(t, repo, "add", "advance.txt")
	runGit(t, repo, "commit", "-m", "advance default branch")
	runGit(t, repo, "push", "origin", "main")
	newTip := gitOutput(t, repo, "rev-parse", "origin/HEAD")
	wantHead := writeLocalTaskWork(t, repo, "sam/after-advance")
	state, err := captureStandaloneSnapshotGitState(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	_, bundlePath, _, err := createWIPBundle(context.Background(), repo, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(bundlePath)
	if prerequisites, _ := snapshotBundlePrerequisites(bundlePath); !reflect.DeepEqual(prerequisites, []string{newTip}) {
		t.Fatalf("bundle prerequisites = %v, want advanced default-branch tip %s", prerequisites, newTip)
	}
	if _, err := runStandaloneGitCommand(context.Background(), staleClone, nil, "cat-file", "-e", newTip+"^{commit}"); err == nil {
		t.Fatal("precondition: stale clone already has the prerequisite commit")
	}

	restoreStandaloneSnapshotBundle(t, staleClone, bundlePath, state)
	assertRestoredLocalTaskWork(t, staleClone, wantHead, "sam/after-advance")
}

func TestContainerWIPBundleExcludesDefaultBranchHistoryAndRestores(t *testing.T) {
	const historyBytes = 512 * 1024
	repo, remote, defaultTip := initSnapshotRemoteRepoWithHistory(t, historyBytes)
	wantHead := writeLocalTaskWork(t, repo, "sam/container-basis-task")
	s := &Server{config: &config.Config{Role: config.RoleStandalone}}
	state, bundlePath := captureContainerSnapshotBundle(t, s, &containerSnapshotTarget{workDir: repo})
	defer os.Remove(bundlePath)

	prerequisites, err := snapshotBundlePrerequisites(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(prerequisites, []string{defaultTip}) {
		t.Fatalf("container bundle prerequisites = %v, want only the default-branch tip %s", prerequisites, defaultTip)
	}
	if size := bundleSize(t, bundlePath); size >= historyBytes/4 {
		t.Fatalf("container WIP bundle is %d bytes: it still carries the default-branch history", size)
	}

	restored := cloneSnapshotRemote(t, remote)
	restoreContainerSnapshotBundle(t, s, restored, bundlePath, state)
	assertRestoredLocalTaskWork(t, restored, wantHead, "sam/container-basis-task")
}

func TestContainerRestoreFetchesMissingBundlePrerequisite(t *testing.T) {
	repo, remote, _ := initSnapshotRemoteRepoWithHistory(t, 4096)
	staleClone := cloneSnapshotRemote(t, remote)
	mustWriteSnapshotFile(t, repo, "advance.txt", "default branch moved on")
	runGit(t, repo, "add", "advance.txt")
	runGit(t, repo, "commit", "-m", "advance default branch")
	runGit(t, repo, "push", "origin", "main")
	wantHead := writeLocalTaskWork(t, repo, "sam/container-after-advance")
	s := &Server{config: &config.Config{Role: config.RoleStandalone}}
	state, bundlePath := captureContainerSnapshotBundle(t, s, &containerSnapshotTarget{workDir: repo})
	defer os.Remove(bundlePath)

	restoreContainerSnapshotBundle(t, s, staleClone, bundlePath, state)
	assertRestoredLocalTaskWork(t, staleClone, wantHead, "sam/container-after-advance")
}

func TestContainerWIPCaptureSkipsOversizedEntriesUsingBatchedSizes(t *testing.T) {
	repo, _, _ := initSnapshotRemoteRepoWithHistory(t, 4096)
	runGit(t, repo, "checkout", "-b", "sam/oversized")
	big := strings.Repeat("b", 2048)
	mustWriteSnapshotFile(t, repo, "big-staged.bin", big)
	mustWriteSnapshotFile(t, repo, "small-staged.txt", "small")
	runGit(t, repo, "add", "big-staged.bin", "small-staged.txt")
	mustWriteSnapshotFile(t, repo, "big-untracked.bin", big)
	mustWriteSnapshotFile(t, repo, "small-untracked.txt", "small")
	s := &Server{config: &config.Config{Role: config.RoleStandalone}}

	_, bundlePath, skipped, err := s.createContainerWIPBundle(context.Background(), &containerSnapshotTarget{workDir: repo}, 1024, 1<<30, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(bundlePath)

	want := []snapshotSkippedEntry{
		{Path: "big-untracked.bin", Reason: "entry exceeds size threshold", SizeBytes: 2048},
		{Path: "big-staged.bin", Reason: "staged entry exceeds size threshold", SizeBytes: 2048},
	}
	if !reflect.DeepEqual(skipped, want) {
		t.Fatalf("skipped = %#v, want %#v", skipped, want)
	}
	refs, err := parseSnapshotBundleRefs(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	_, worktreeCommit := snapshotBundleRef(refs, "/worktree")
	files := gitOutput(t, repo, "ls-tree", "-r", "--name-only", worktreeCommit)
	if strings.Contains(files, "big-untracked.bin") || !strings.Contains(files, "small-untracked.txt") {
		t.Fatalf("worktree snapshot files = %q, want small-untracked.txt without big-untracked.bin", files)
	}
}

func TestOversizedSnapshotIndexEntriesUsesOneBatchedLookup(t *testing.T) {
	var entries []snapshotIndexEntry
	for i := 0; i < 500; i++ {
		entries = append(entries, snapshotIndexEntry{object: fmt.Sprintf("obj-%d", i%250), path: fmt.Sprintf("file-%d", i)})
	}
	entries = append(entries, snapshotIndexEntry{object: "gitlink", path: "vendor/submodule"})
	calls := 0
	fakeGit := func(_ context.Context, _ []string, input []byte, args ...string) (string, error) {
		calls++
		if want := []string{"cat-file", "--batch-check=%(objectname) %(objectsize)"}; !reflect.DeepEqual(args, want) {
			t.Fatalf("git args = %v, want %v", args, want)
		}
		requested := strings.Fields(string(input))
		if len(requested) != 251 {
			t.Fatalf("batched lookup requested %d objects, want each of the 251 distinct objects once", len(requested))
		}
		var out strings.Builder
		for _, object := range requested {
			switch object {
			case "gitlink":
				fmt.Fprintf(&out, "%s missing\n", object)
			case "obj-7":
				fmt.Fprintf(&out, "%s 4096\n", object)
			default:
				fmt.Fprintf(&out, "%s 10\n", object)
			}
		}
		return out.String(), nil
	}

	skipped, err := oversizedSnapshotIndexEntries(context.Background(), fakeGit, entries, 1024, "too big")
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("size lookup ran %d git commands for %d entries, want 1", calls, len(entries))
	}
	want := []snapshotSkippedEntry{
		{Path: "file-7", Reason: "too big", SizeBytes: 4096},
		{Path: "file-257", Reason: "too big", SizeBytes: 4096},
	}
	if !reflect.DeepEqual(skipped, want) {
		t.Fatalf("skipped = %#v, want %#v", skipped, want)
	}
}

func TestSnapshotCaptureSkipsRegenerableHomeCaches(t *testing.T) {
	home := t.TempDir()
	for name, body := range map[string]string{
		".npm-global/lib/node_modules/@openai/codex/bin/codex": "agent cli",
		".codex/cache/remote_plugin_catalog.json":              "catalog",
		".local/share/uv/tools/ruff/bin/ruff":                  "tool",
		".codex/sessions/2026/10/03/rollout.jsonl":             "conversation",
		".codex/plugins/cache/curated/skill/SKILL.md":          "plugin",
	} {
		path := filepath.Join(home, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("/usr/bin/python3", filepath.Join(home, ".local/share/uv/tools/ruff/bin/python")); err != nil {
		t.Fatal(err)
	}

	tarPath, skipped, err := createSessionStateTar(func() (string, error) { return home, nil }, 1<<20, 1<<30, false)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tarPath)
	if len(skipped) != 0 {
		t.Fatalf("skipped = %#v: excluded caches must not be recorded as lost state (their symlinks used to mark snapshots degraded)", skipped)
	}
	names := snapshotTarNames(t, tarPath)
	for _, excluded := range []string{".npm-global/", ".codex/cache/", ".local/share/uv/"} {
		for _, name := range names {
			if strings.HasPrefix(name, excluded) {
				t.Fatalf("snapshot captured regenerable %s", name)
			}
		}
	}
	for _, kept := range []string{".codex/sessions/2026/10/03/rollout.jsonl", ".codex/plugins/cache/curated/skill/SKILL.md"} {
		if !containsString(names, kept) {
			t.Fatalf("snapshot names %v are missing harness state %s", names, kept)
		}
	}

	inventory := []byte("f\x0010\x00644\x00sessions/s.jsonl\x00f\x0010\x00644\x00cache/catalog.json\x00")
	selected, rootSkipped, _, err := buildContainerSnapshotArchiveList(inventory, snapshotRootCodex, 1<<20, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Split(strings.TrimSuffix(string(selected), "\x00"), "\x00"); !reflect.DeepEqual(got, []string{"sessions/s.jsonl"}) || len(rootSkipped) != 0 {
		t.Fatalf("external Codex root selection = %q (skipped %#v), want sessions without cache", got, rootSkipped)
	}
	homeInventory := []byte("f\x0010\x00644\x00.codex/sessions/s.jsonl\x00f\x0010\x00644\x00.npm-global/lib/cli.js\x00f\x0010\x00644\x00.codex/cache/catalog.json\x00")
	homeSelected, homeSkipped, _, err := buildContainerSnapshotArchiveList(homeInventory, "", 1<<20, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Split(strings.TrimSuffix(string(homeSelected), "\x00"), "\x00"); !reflect.DeepEqual(got, []string{".codex/sessions/s.jsonl"}) || len(homeSkipped) != 0 {
		t.Fatalf("container HOME selection = %q (skipped %#v), want sessions without regenerable caches", got, homeSkipped)
	}
	if args := strings.Join(containerSnapshotInventoryArgs("/home/node", ""), " "); !strings.Contains(args, "-path /home/node/.npm-global") {
		t.Fatalf("container HOME inventory does not prune .npm-global: %s", args)
	}
}

// Snapshots captured before these caches were excluded legitimately contain
// them, and they must still wake. Credential paths stay rejected.
func TestSnapshotHomeArchiveValidationStillAcceptsRegenerableCaches(t *testing.T) {
	accepted := writeSnapshotTestTar(t, ".npm-global/lib/node_modules/x/index.js", ".codex/cache/remote_plugin_catalog.json", ".local/share/uv/tools/x/bin/x")
	if _, err := validateSnapshotHomeTar(accepted, 1<<20, 1<<30); err != nil {
		t.Fatalf("archive from an older agent with regenerable caches was rejected: %v", err)
	}
	rejected := writeSnapshotTestTar(t, ".ssh/id_ed25519")
	if _, err := validateSnapshotHomeTar(rejected, 1<<20, 1<<30); err == nil || !strings.Contains(err.Error(), "excluded path") {
		t.Fatalf("credential path validation error = %v, want excluded-path rejection", err)
	}
}

func TestBoundSnapshotSkippedEntriesLeavesSmallListsUnchanged(t *testing.T) {
	entries := []snapshotSkippedEntry{{Path: "~/big.bin", Reason: "entry exceeds size threshold", SizeBytes: 300 << 20}}
	if got := boundSnapshotSkippedEntries(entries, 128*1024); !reflect.DeepEqual(got, entries) {
		t.Fatalf("bounded = %#v, want unchanged %#v", got, entries)
	}
}

func TestBoundSnapshotSkippedEntriesKeepsCompletionRequestUnderJSONLimit(t *testing.T) {
	const jsonBodyMaxBytes = 256 * 1024
	entries := []snapshotSkippedEntry{{Path: "$HOME", Reason: "archive container snapshot root: " + strings.Repeat("x", 100_000)}}
	var total int64
	for i := 0; i < 5000; i++ {
		size := int64(i + 1)
		total += size
		entries = append(entries, snapshotSkippedEntry{
			Path:      fmt.Sprintf("~/.codex/plugins/cache/openai-curated/plugin-%04d/assets/template-%04d.pptx", i, i),
			Reason:    "snapshot budget exhausted",
			SizeBytes: size,
		})
	}
	entries = append(entries, snapshotSkippedEntry{Path: "agent-context", Reason: "resumable agent session identity unavailable"})
	manifest := snapshotManifest{
		Version: 1, ChatSessionID: "chat-1", WorkspaceID: "workspace-1", AgentSessionID: "agent-1",
		Status: "degraded", Degradation: "home-skipped", Skipped: entries,
		Artifacts: map[string]snapshotArtifact{"wip": {SizeBytes: 4096, SHA256: strings.Repeat("a", 64)}},
		CreatedAt: "2026-10-03T00:00:00Z",
	}
	if size := completionRequestSize(t, manifest); size <= jsonBodyMaxBytes {
		t.Fatalf("precondition: unbounded completion request is %d bytes, want it to exceed %d", size, jsonBodyMaxBytes)
	}

	prepare := &snapshotPrepareResponse{}
	prepare.Config.JSONBodyMaxBytes = jsonBodyMaxBytes
	manifest.Skipped = boundSnapshotSkippedEntries(manifest.Skipped, snapshotSkippedEntriesBudget(prepare))

	if size := completionRequestSize(t, manifest); size > jsonBodyMaxBytes {
		t.Fatalf("bounded completion request is %d bytes, over the %d-byte control-plane limit", size, jsonBodyMaxBytes)
	}
	bounded := manifest.Skipped
	if bounded[0].Path != "$HOME" || !strings.HasSuffix(bounded[0].Reason, "...") || bounded[1].Path != "agent-context" {
		t.Fatalf("diagnostics were not kept first (and truncated): %#v %#v", bounded[0], bounded[1])
	}
	summary := bounded[len(bounded)-1]
	kept := bounded[2 : len(bounded)-1]
	if len(kept) == 0 || kept[0].SizeBytes != 5000 {
		t.Fatalf("largest skipped file was not kept first: %#v", kept[:min(len(kept), 1)])
	}
	var keptBytes int64
	for i, entry := range kept {
		if i > 0 && entry.SizeBytes > kept[i-1].SizeBytes {
			t.Fatalf("kept entries are not ordered largest first at %d", i)
		}
		keptBytes += entry.SizeBytes
	}
	omitted := 5000 - len(kept)
	if summary.Path != snapshotSkippedSummaryPath || summary.SizeBytes != total-keptBytes ||
		!strings.HasPrefix(summary.Reason, fmt.Sprintf("%d more skipped entries", omitted)) {
		t.Fatalf("summary = %#v, want %d omitted entries totalling %d bytes", summary, omitted, total-keptBytes)
	}
}

func TestSnapshotSkippedEntriesBudgetFallsBackToDefaultLimit(t *testing.T) {
	if got := snapshotSkippedEntriesBudget(&snapshotPrepareResponse{}); got != defaultSnapshotJSONBodyMaxBytes/2 {
		t.Fatalf("budget without a reported limit = %d, want %d", got, defaultSnapshotJSONBodyMaxBytes/2)
	}
}

func completionRequestSize(t *testing.T, manifest snapshotManifest) int {
	t.Helper()
	encoded, err := json.Marshal(snapshotCompletionPayload("agent-1", "chat-1", "vm", "01GENERATION", manifest))
	if err != nil {
		t.Fatal(err)
	}
	return len(encoded)
}

func writeSnapshotTestTar(t *testing.T, names ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "home.tar")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(file)
	for _, name := range names {
		writeTarFile(t, tw, name, "content")
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func snapshotTarNames(t *testing.T, path string) []string {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var names []string
	reader := tar.NewReader(file)
	for {
		header, err := reader.Next()
		if err != nil {
			return names
		}
		names = append(names, filepath.ToSlash(filepath.Clean(header.Name)))
	}
}

// Drives the real capture against a control plane that enforces the
// SESSION_SNAPSHOT_JSON_BODY_MAX_BYTES limit, as production did when it
// rejected every completion with 400 "Snapshot request body is too large".
func TestHibernateSessionSnapshotCompletesWhenHomeOverflowsBudget(t *testing.T) {
	const jsonBodyMaxBytes = 256 * 1024
	repo, _, _ := initSnapshotRemoteRepoWithHistory(t, 4096)
	writeLocalTaskWork(t, repo, "sam/overflowing-home")
	home := t.TempDir()
	for i := 0; i < 3000; i++ {
		name := filepath.Join(home, ".codex", "sessions", fmt.Sprintf("2026/10/03/rollout-with-a-long-name-%05d.jsonl", i))
		if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(name, []byte(strings.Repeat("r", 600)), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", home)

	var completionBodies [][]byte
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		switch {
		case strings.HasSuffix(r.URL.Path, "/session-snapshot/prepare"):
			_, _ = w.Write([]byte(`{"generation":"01GENERATION","config":{"totalBudgetBytes":262144,"entryThresholdBytes":1048576,"transferIdleTimeoutMs":30000,"jsonBodyMaxBytes":262144},"upload":{"home":"/upload/home","wip":"/upload/wip"}}`))
		case strings.HasPrefix(r.URL.Path, "/upload/"):
			w.WriteHeader(http.StatusNoContent)
		case strings.HasSuffix(r.URL.Path, "/session-snapshot/complete"):
			completionBodies = append(completionBodies, body)
			if len(body) > jsonBodyMaxBytes {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":"BAD_REQUEST","message":"Snapshot request body is too large"}`))
				return
			}
			_, _ = w.Write([]byte(`{"status":"degraded","degradation":"entries-skipped"}`))
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer controlPlane.Close()

	s := &Server{config: &config.Config{Role: config.RoleStandalone, ControlPlaneURL: controlPlane.URL}}
	_, err := s.hibernateSessionSnapshot(context.Background(), &sessionSnapshotHandlerInput{
		workspaceID:   "ws-1",
		sessionID:     "agent-1",
		chatSessionID: "chat-1",
		runtimeName:   "vm",
		runtime:       &WorkspaceRuntime{ID: "ws-1", WorkspaceDir: repo},
		callbackToken: "token",
		agentType:     "openai-codex",
		acpSessionID:  "acp-1",
	})
	if err != nil {
		t.Fatalf("snapshot capture failed: %v", err)
	}
	if len(completionBodies) != 1 || len(completionBodies[0]) > jsonBodyMaxBytes {
		t.Fatalf("completion requests = %d (first %d bytes), want one request within %d bytes", len(completionBodies), len(completionBodies[0]), jsonBodyMaxBytes)
	}
	var completion struct {
		Manifest snapshotManifest `json:"manifest"`
	}
	if err := json.Unmarshal(completionBodies[0], &completion); err != nil {
		t.Fatal(err)
	}
	skipped := completion.Manifest.Skipped
	if len(skipped) == 0 || skipped[len(skipped)-1].Path != snapshotSkippedSummaryPath {
		t.Fatalf("overflowing HOME did not produce a summarised skipped list: %d entries", len(skipped))
	}
	if completion.Manifest.Artifacts["wip"].SizeBytes == 0 {
		t.Fatalf("completion manifest lost the WIP artifact: %#v", completion.Manifest.Artifacts)
	}
}

// The incident ran on the VM devcontainer runtime, so the overflow scenario must
// also pass through the container capture branch of hibernateSessionSnapshot.
// The caller-frozen container target (the same seam eviction uses) selects that
// branch; the runtime's WorkspaceDir deliberately points away from the
// repository, so a WIP artifact can only come from the container path.
func TestHibernateSessionSnapshotContainerRuntimeCompletesWhenHomeOverflowsBudget(t *testing.T) {
	const jsonBodyMaxBytes = 256 * 1024
	repo, _, _ := initSnapshotRemoteRepoWithHistory(t, 4096)
	writeLocalTaskWork(t, repo, "sam/container-overflowing-home")
	home := t.TempDir()
	for i := 0; i < 3000; i++ {
		name := filepath.Join(home, ".codex", "sessions", fmt.Sprintf("2026/10/03/rollout-with-a-long-name-%05d.jsonl", i))
		if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(name, []byte(strings.Repeat("r", 600)), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", home)
	completions := serveEnforcingSnapshotControlPlane(t, jsonBodyMaxBytes)

	s := &Server{config: &config.Config{Role: config.RoleStandalone, ControlPlaneURL: completions.url}}
	_, err := s.hibernateSessionSnapshot(context.Background(), &sessionSnapshotHandlerInput{
		workspaceID:     "ws-1",
		sessionID:       "agent-1",
		chatSessionID:   "chat-1",
		runtimeName:     "vm",
		runtime:         &WorkspaceRuntime{ID: "ws-1", WorkspaceDir: t.TempDir()},
		callbackToken:   "token",
		agentType:       "openai-codex",
		acpSessionID:    "acp-1",
		containerTarget: &containerSnapshotTarget{workDir: repo},
	})
	if err != nil {
		t.Fatalf("container-runtime snapshot capture failed: %v", err)
	}
	manifest := completions.onlyManifest(t, jsonBodyMaxBytes)
	if manifest.Artifacts["wip"].SizeBytes == 0 {
		t.Fatalf("container capture produced no WIP artifact, so the container branch did not run: %#v", manifest.Artifacts)
	}
	skipped := manifest.Skipped
	if len(skipped) == 0 || skipped[len(skipped)-1].Path != snapshotSkippedSummaryPath {
		t.Fatalf("overflowing container HOME did not produce a summarised skipped list: %d entries", len(skipped))
	}
}

type enforcingControlPlane struct {
	url    string
	bodies *[][]byte
}

// serveEnforcingSnapshotControlPlane answers the snapshot callbacks and rejects
// a completion over jsonBodyMaxBytes exactly as the Worker's readJsonBody does.
func serveEnforcingSnapshotControlPlane(t *testing.T, jsonBodyMaxBytes int) enforcingControlPlane {
	t.Helper()
	var bodies [][]byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		switch {
		case strings.HasSuffix(r.URL.Path, "/session-snapshot/prepare"):
			_, _ = fmt.Fprintf(w, `{"generation":"01GENERATION","config":{"totalBudgetBytes":262144,"entryThresholdBytes":1048576,"transferIdleTimeoutMs":30000,"jsonBodyMaxBytes":%d},"upload":{"home":"/upload/home","wip":"/upload/wip"}}`, jsonBodyMaxBytes)
		case strings.HasPrefix(r.URL.Path, "/upload/"):
			w.WriteHeader(http.StatusNoContent)
		case strings.HasSuffix(r.URL.Path, "/session-snapshot/complete"):
			bodies = append(bodies, body)
			if len(body) > jsonBodyMaxBytes {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":"BAD_REQUEST","message":"Snapshot request body is too large"}`))
				return
			}
			_, _ = w.Write([]byte(`{"status":"degraded","degradation":"entries-skipped"}`))
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(server.Close)
	return enforcingControlPlane{url: server.URL, bodies: &bodies}
}

func (c enforcingControlPlane) onlyManifest(t *testing.T, jsonBodyMaxBytes int) snapshotManifest {
	t.Helper()
	bodies := *c.bodies
	if len(bodies) != 1 || len(bodies[0]) > jsonBodyMaxBytes {
		sizes := make([]int, 0, len(bodies))
		for _, body := range bodies {
			sizes = append(sizes, len(body))
		}
		t.Fatalf("completion request sizes = %v, want exactly one within %d bytes", sizes, jsonBodyMaxBytes)
	}
	var completion struct {
		Manifest snapshotManifest `json:"manifest"`
	}
	if err := json.Unmarshal(bodies[0], &completion); err != nil {
		t.Fatal(err)
	}
	return completion.Manifest
}

func TestCreateWIPBundleSkipsOversizedEntriesInStandaloneRuntime(t *testing.T) {
	repo, _, _ := initSnapshotRemoteRepoWithHistory(t, 4096)
	runGit(t, repo, "checkout", "-b", "sam/standalone-oversized")
	big := strings.Repeat("b", 2048)
	mustWriteSnapshotFile(t, repo, "big-staged.bin", big)
	mustWriteSnapshotFile(t, repo, "small-staged.txt", "small")
	runGit(t, repo, "add", "big-staged.bin", "small-staged.txt")
	mustWriteSnapshotFile(t, repo, "big-untracked.bin", big)
	mustWriteSnapshotFile(t, repo, "small-untracked.txt", "small")

	_, bundlePath, skipped, err := createWIPBundle(context.Background(), repo, 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(bundlePath)

	for _, want := range []snapshotSkippedEntry{
		{Path: "big-untracked.bin", Reason: "entry exceeds size threshold", SizeBytes: 2048},
		{Path: "big-staged.bin", Reason: "staged entry exceeds size threshold", SizeBytes: 2048},
	} {
		found := false
		for _, entry := range skipped {
			found = found || entry == want
		}
		if !found {
			t.Fatalf("skipped = %#v, missing %#v", skipped, want)
		}
	}
	refs, err := parseSnapshotBundleRefs(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	_, worktreeCommit := snapshotBundleRef(refs, "/worktree")
	_, indexCommit := snapshotBundleRef(refs, "/index")
	if files := gitOutput(t, repo, "ls-tree", "-r", "--name-only", worktreeCommit); strings.Contains(files, "big-untracked.bin") || !strings.Contains(files, "small-untracked.txt") {
		t.Fatalf("worktree snapshot files = %q, want small-untracked.txt without big-untracked.bin", files)
	}
	if files := gitOutput(t, repo, "ls-tree", "-r", "--name-only", indexCommit); strings.Contains(files, "big-staged.bin") || !strings.Contains(files, "small-staged.txt") {
		t.Fatalf("index snapshot files = %q, want small-staged.txt without big-staged.bin", files)
	}
}

// Instant workspaces clone with --filter=blob:none (cloneStandaloneRepository).
// A basis bundle is a thin pack, so restoring it into a partial clone depends on
// git fetching missing delta bases and blobs from the promisor remote.
func TestBasisBundleRestoresIntoPartialClone(t *testing.T) {
	for _, checkout := range []bool{true, false} {
		t.Run(fmt.Sprintf("checkout=%t", checkout), func(t *testing.T) {
			repo, remote, _ := initSnapshotRemoteRepoWithHistory(t, 4096)
			runGit(t, remote, "config", "uploadpack.allowFilter", "true")
			runGit(t, remote, "config", "uploadpack.allowAnySHA1InWant", "true")
			large := strings.Repeat("shared line for delta compression\n", 4000)
			mustWriteSnapshotFile(t, repo, "large.txt", large)
			mustWriteSnapshotFile(t, repo, "unchanged.txt", "unchanged since the default branch")
			runGit(t, repo, "add", "large.txt", "unchanged.txt")
			runGit(t, repo, "commit", "-m", "add large file")
			runGit(t, repo, "push", "origin", "main")
			wantHead := writeLocalTaskWork(t, repo, "sam/partial-clone-task")
			mustWriteSnapshotFile(t, repo, "large.txt", large+"one more local line\n")
			state, err := captureStandaloneSnapshotGitState(context.Background(), repo)
			if err != nil {
				t.Fatal(err)
			}
			_, bundlePath, _, err := createWIPBundle(context.Background(), repo, 1<<20)
			if err != nil {
				t.Fatal(err)
			}
			defer os.Remove(bundlePath)

			restored := filepath.Join(t.TempDir(), "restored")
			args := []string{"clone", "--filter=blob:none", "--branch", "main"}
			if !checkout {
				args = append(args, "--no-checkout")
			}
			runGit(t, filepath.Dir(restored), append(args, "file://"+remote, restored)...)
			if got := gitOutput(t, restored, "config", "remote.origin.promisor"); got != "true" {
				t.Fatalf("precondition: restore target is not a partial clone (promisor=%q)", got)
			}
			restoreStandaloneSnapshotBundle(t, restored, bundlePath, state)

			assertRestoredLocalTaskWork(t, restored, wantHead, "sam/partial-clone-task")
			for name, want := range map[string]string{
				"large.txt":     large + "one more local line\n",
				"unchanged.txt": "unchanged since the default branch",
			} {
				if got, err := os.ReadFile(filepath.Join(restored, name)); err != nil || string(got) != want {
					t.Fatalf("restored %s has %d bytes (err %v), want %d", name, len(got), err, len(want))
				}
			}
		})
	}
}

// A prerequisite that origin cannot serve must fail the restore loudly, before
// anything in the wake clone is touched.
func TestRestoreFailsVisiblyWhenBundlePrerequisiteIsUnavailable(t *testing.T) {
	repo, remote, _ := initSnapshotRemoteRepoWithHistory(t, 4096)
	mustWriteSnapshotFile(t, repo, "never-pushed.txt", "only in this clone")
	runGit(t, repo, "add", "never-pushed.txt")
	runGit(t, repo, "commit", "-m", "never pushed")
	ghost := gitOutput(t, repo, "rev-parse", "HEAD")
	// Point the default-branch ref at a commit origin has never seen.
	runGit(t, repo, "update-ref", "refs/remotes/origin/ghost", ghost)
	runGit(t, repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/ghost")
	writeLocalTaskWork(t, repo, "sam/unfetchable-prerequisite")
	state, err := captureStandaloneSnapshotGitState(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	_, bundlePath, _, err := createWIPBundle(context.Background(), repo, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(bundlePath)
	if prerequisites, _ := snapshotBundlePrerequisites(bundlePath); !reflect.DeepEqual(prerequisites, []string{ghost}) {
		t.Fatalf("precondition: prerequisites = %v, want the unpushed commit %s", prerequisites, ghost)
	}

	restored := cloneSnapshotRemote(t, remote)
	beforeHead := gitOutput(t, restored, "rev-parse", "HEAD")
	server := serveSnapshotBundle(t, bundlePath)
	defer server.Close()
	s := &Server{config: &config.Config{ControlPlaneURL: server.URL}}
	err = s.downloadAndRestoreWIPWithGitState(context.Background(), server.URL, "token", time.Second, restored, state)
	if err == nil || !strings.Contains(err.Error(), "restore snapshot bundle prerequisite "+ghost) {
		t.Fatalf("restore error = %v, want it to name the unavailable prerequisite %s", err, ghost)
	}
	if got := gitOutput(t, restored, "rev-parse", "HEAD"); got != beforeHead {
		t.Fatalf("failed restore moved HEAD from %s to %s", beforeHead, got)
	}
	if got := gitOutput(t, restored, "status", "--porcelain=v1"); got != "" {
		t.Fatalf("failed restore left the wake clone dirty: %q", got)
	}
}

func TestSnapshotBundlePrerequisitesParsesHeaders(t *testing.T) {
	p1, p2 := strings.Repeat("a", 40), strings.Repeat("b", 40)
	ref := strings.Repeat("c", 40) + " refs/sam/session-snapshot/x/worktree\n"
	for _, tc := range []struct {
		name    string
		header  string
		want    []string
		wantErr string
	}{
		{name: "v2 prerequisites", header: "# v2 git bundle\n-" + p1 + " base\n-" + p2 + "\n" + ref + "\nPACK", want: []string{p1, p2}},
		{name: "v3 with capabilities and CRLF", header: "# v3 git bundle\r\n@object-format=sha1\r\n@filter=blob:none\r\n-" + p1 + " base\r\n" + ref + "\r\nPACK", want: []string{p1}},
		{name: "self-contained legacy bundle", header: "# v2 git bundle\n" + ref + "\nPACK", want: nil},
		{name: "unsupported version", header: "# v4 git bundle\n" + ref + "\n", wantErr: "unsupported header"},
		{name: "truncated header", header: "# v2 git bundle\n-" + p1 + "\n" + ref, wantErr: "truncated"},
		{name: "malformed prerequisite", header: "# v2 git bundle\n--upload-pack=evil base\n" + ref + "\n", wantErr: "not a full Git object ID"},
		{name: "empty file", header: "", wantErr: "read snapshot bundle header"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "header.bundle")
			if err := os.WriteFile(path, []byte(tc.header), 0o600); err != nil {
				t.Fatal(err)
			}
			got, err := snapshotBundlePrerequisites(path)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("error = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil || !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("prerequisites = %v (err %v), want %v", got, err, tc.want)
			}
		})
	}
}

// Rollout compatibility (rule 54): snapshots captured by agents that predate
// the bundle basis carry self-contained full-history bundles, and they must
// keep waking in both runtimes after this agent ships.
func TestSelfContainedLegacyBundleRestoresWithCurrentAgent(t *testing.T) {
	repo, remote := initSnapshotRemoteRepo(t) // no origin/HEAD: the pre-basis bundle shape
	wantHead := writeLocalTaskWork(t, repo, "sam/legacy-bundle")
	state, err := captureStandaloneSnapshotGitState(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	_, bundlePath, _, err := createWIPBundle(context.Background(), repo, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(bundlePath)
	if prerequisites, _ := snapshotBundlePrerequisites(bundlePath); len(prerequisites) != 0 {
		t.Fatalf("precondition: legacy-shaped bundle has prerequisites %v", prerequisites)
	}

	standalone := cloneSnapshotRemote(t, remote)
	restoreStandaloneSnapshotBundle(t, standalone, bundlePath, state)
	assertRestoredLocalTaskWork(t, standalone, wantHead, "sam/legacy-bundle")

	container := cloneSnapshotRemote(t, remote)
	s := &Server{config: &config.Config{Role: config.RoleStandalone}}
	restoreContainerSnapshotBundle(t, s, container, bundlePath, state)
	assertRestoredLocalTaskWork(t, container, wantHead, "sam/legacy-bundle")
}
