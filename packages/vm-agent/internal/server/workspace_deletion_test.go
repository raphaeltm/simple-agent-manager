package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/persistence"
)

type deletionFixture struct {
	server                 *Server
	token, root, state, db string
	identity               workspaceDeletionIdentity
}

func newDeletionFixture(t *testing.T) deletionFixture {
	t.Helper()
	validator, key := newWorkspaceCreateJWTValidator(t, "node-1")
	s := newWorkspaceCreateServer(t, "http://127.0.0.1:1", validator)
	s.config.NodeUserID = "user-1"
	s.config.NodeRuntimeIncarnationID = "incarnation-1"
	db := filepath.Join(t.TempDir(), "deletion.db")
	store, err := persistence.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	s.store = store
	t.Cleanup(func() { _ = s.store.Close() })
	root := filepath.Join(s.config.WorkspaceDir, "workspace-1")
	if err := s.createOwnedWorkspaceRoot(&WorkspaceRuntime{ID: "workspace-1"}, root); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "untracked.txt"), []byte("preserved until authorized deletion"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertWorkspaceMetadata(persistence.WorkspaceMetadata{WorkspaceID: "workspace-1", WorkspaceDir: root, ContainerLabelVal: root, EvictionGeneration: "generation-1"}); err != nil {
		t.Fatal(err)
	}
	state := t.TempDir()
	for _, f := range []string{"container", "volume", "fail-volume"} {
		if err := os.WriteFile(filepath.Join(state, f), []byte(""), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(state, "volume-data"), 0755); err != nil {
		t.Fatal(err)
	}
	fake := `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$SAM_DELETE_TEST_STATE/commands"
case "$1 $2" in
 'ps -aq') if test -f "$SAM_DELETE_TEST_STATE/container"; then printf '%s\n' "${SAM_DELETE_TEST_CONTAINER:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"; fi ;;
 'rm -f') rm -f "$SAM_DELETE_TEST_STATE/container" ;;
 'volume ls') printf '%s\n' user-nested-volume; if test -f "$SAM_DELETE_TEST_STATE/volume"; then printf '%s\n' sam-ws-workspace-1; fi ;;
 'volume inspect') printf '%s\n' "sam-ws-workspace-1|created-1|$SAM_DELETE_TEST_STATE/volume-data|workspace-1|node-1|incarnation-1|${SAM_DELETE_TEST_OWNER:-user-1}" ;;
 'volume rm') if test -f "$SAM_DELETE_TEST_STATE/fail-volume"; then echo busy >&2; exit 1; fi; rm -f "$SAM_DELETE_TEST_STATE/volume" ;;
 *) echo unexpected >&2; exit 1 ;;
esac
`
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte(fake), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	t.Setenv("SAM_DELETE_TEST_STATE", state)
	return deletionFixture{s, signWorkspaceCreateNodeToken(t, key, "node-1", "workspace-1"), root, state, db, workspaceDeletionIdentity{"workspace-1", "node-1", "incarnation-1", "user-1", "generation-1"}}
}
func (f deletionFixture) request(ctx context.Context, body any) *httptest.ResponseRecorder {
	if id, ok := body.(workspaceDeletionIdentity); ok {
		body = workspaceDeletionRequest{workspaceDeletionIdentity: id, DeletionMode: "explicit"}
	}
	data, _ := json.Marshal(body)
	req := httptest.NewRequestWithContext(ctx, http.MethodDelete, "/workspaces/workspace-1", strings.NewReader(string(data)))
	req.SetPathValue("workspaceId", "workspace-1")
	req.Header.Set("Authorization", "Bearer "+f.token)
	req.Header.Set("X-SAM-Workspace-Id", "workspace-1")
	rec := httptest.NewRecorder()
	f.server.handleDeleteWorkspace(rec, req)
	return rec
}
func TestWorkspacePhysicalDeletionRetriesAfterPartialFailureAndRestart(t *testing.T) {
	f := newDeletionFixture(t)
	first := f.request(t.Context(), f.identity)
	if first.Code != 503 {
		t.Fatalf("first=%d %s", first.Code, first.Body.String())
	}
	if _, err := os.Stat(f.root); err != nil {
		t.Fatal("root lost before volume removal", err)
	}
	if meta, err := f.server.store.GetWorkspaceMetadata("workspace-1"); err != nil || meta == nil {
		t.Fatal("metadata lost before physical cleanup", err)
	}
	if _, err := os.Stat(filepath.Join(f.state, "container")); !os.IsNotExist(err) {
		t.Fatal("container was not removed")
	}
	if err := f.server.store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := persistence.Open(f.db)
	if err != nil {
		t.Fatal(err)
	}
	f.server.store = store
	if err := os.Remove(filepath.Join(f.state, "fail-volume")); err != nil {
		t.Fatal(err)
	}
	f.server.reconcileWorkspaceDeletions(t.Context())
	if _, err := os.Stat(f.root); !os.IsNotExist(err) {
		t.Fatalf("root survived retry: %v", err)
	}
	if meta, err := store.GetWorkspaceMetadata("workspace-1"); err != nil || meta != nil {
		t.Fatalf("metadata not finalized: %#v %v", meta, err)
	}
	replay := f.request(t.Context(), f.identity)
	if replay.Code != 200 {
		t.Fatalf("replay=%d %s", replay.Code, replay.Body.String())
	}
	var proof struct {
		workspaceDeletionIdentity
		PhysicalDeleted bool `json:"physicalDeleted"`
	}
	if json.Unmarshal(replay.Body.Bytes(), &proof) != nil || !proof.PhysicalDeleted || proof.workspaceDeletionIdentity != f.identity {
		t.Fatalf("wrong proof %s", replay.Body.String())
	}
	commands, _ := os.ReadFile(filepath.Join(f.state, "commands"))
	if strings.Contains(string(commands), "prune") || strings.Contains(string(commands), "volume rm -f") || strings.Contains(string(commands), "rm user-nested") {
		t.Fatalf("unsafe command: %s", commands)
	}
	if err := f.server.requireNoWorkspaceDeletion("workspace-1"); err == nil {
		t.Fatal("tombstone permitted resurrection")
	}
}
func TestWorkspacePhysicalDeletionFences(t *testing.T) {
	for _, kind := range []string{"owner", "incarnation", "generation", "root inode", "container"} {
		t.Run(kind, func(t *testing.T) {
			f := newDeletionFixture(t)
			if rec := f.request(t.Context(), f.identity); rec.Code != 503 {
				t.Fatalf("prepare=%d %s", rec.Code, rec.Body.String())
			}
			switch kind {
			case "owner":
				f.server.config.NodeUserID = "successor-owner"
			case "incarnation":
				f.server.config.NodeRuntimeIncarnationID = "successor-incarnation"
			case "generation":
				meta, _ := f.server.store.GetWorkspaceMetadata("workspace-1")
				_ = meta
				if _, err := f.server.store.CompareAndSwapWorkspaceEvictionGeneration("workspace-1", "generation-1", "successor"); err != nil {
					t.Fatal(err)
				}
			case "root inode":
				if err := os.Rename(f.root, f.root+".old"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(f.root, 0755); err != nil {
					t.Fatal(err)
				}
			case "container":
				if err := os.WriteFile(filepath.Join(f.state, "container"), nil, 0600); err != nil {
					t.Fatal(err)
				}
				t.Setenv("SAM_DELETE_TEST_CONTAINER", strings.Repeat("b", 64))
			}
			_ = os.Remove(filepath.Join(f.state, "fail-volume"))
			f.server.reconcileWorkspaceDeletions(t.Context())
			if _, err := os.Stat(f.root); err != nil {
				t.Fatal("successor root was deleted", err)
			}
			if _, err := os.Stat(filepath.Join(f.state, "volume")); err != nil {
				t.Fatal("successor fence did not protect volume", err)
			}
		})
	}
}
func TestWorkspaceDeletionRejectsMissingIdentityAndWaitsLifecycle(t *testing.T) {
	f := newDeletionFixture(t)
	if rec := f.request(t.Context(), map[string]string{}); rec.Code != 400 {
		t.Fatalf("legacy request accepted: %d", rec.Code)
	}
	lock := f.server.workspaceLifecycleLock("workspace-1")
	if err := lock.Lock(t.Context()); err != nil {
		t.Fatal(err)
	}
	defer lock.Unlock()
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	if rec := f.request(ctx, f.identity); rec.Code != 408 {
		t.Fatalf("delete bypassed lifecycle lock: %d %s", rec.Code, rec.Body.String())
	}
	if p, _ := f.server.store.GetWorkspaceDeletion("workspace-1"); p != "" {
		t.Fatal("canceled waiter persisted authority")
	}
}
func TestWorkspaceDeletionPreservesUnknownStandaloneRoot(t *testing.T) {
	f := newDeletionFixture(t)
	f.server.config.Role = config.RoleStandalone
	if err := os.Rename(f.root, f.root+".old"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(f.root, 0755); err != nil {
		t.Fatal(err)
	}
	if rec := f.request(t.Context(), f.identity); rec.Code != 409 {
		t.Fatalf("unknown root accepted: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(f.root); err != nil {
		t.Fatal(err)
	}
}
func TestWorkspaceDeletionPaths(t *testing.T) {
	base := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(base, "link")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/", filepath.Join(base, "link"), filepath.Join(base, "link", "child"), "relative", "/proc"} {
		if err := validateDeletionRoot(path); err == nil {
			t.Errorf("unsafe path accepted: %s", path)
		}
	}
	if err := validateDeletionRoot(filepath.Join(base, "new")); err != nil {
		t.Fatal(err)
	}
}
func TestOwnedStandaloneRootRecordedOnlyBeforeFirstUse(t *testing.T) {
	f := newDeletionFixture(t)
	runtime := &WorkspaceRuntime{ID: "owned"}
	root := filepath.Join(f.server.config.WorkspaceDir, "owned")
	if err := f.server.createOwnedWorkspaceRoot(runtime, root); err != nil {
		t.Fatal(err)
	}
	if payload, err := f.server.store.GetOwnedWorkspaceRoot("owned"); err != nil || payload == "" {
		t.Fatal("new subroot has no durable owner", err)
	}
	existing := filepath.Join(f.server.config.WorkspaceDir, "preexisting")
	if err := os.Mkdir(existing, 0755); err != nil {
		t.Fatal(err)
	}
	if err := f.server.createOwnedWorkspaceRoot(&WorkspaceRuntime{ID: "preexisting"}, existing); err != nil {
		t.Fatal(err)
	}
	if payload, _ := f.server.store.GetOwnedWorkspaceRoot("preexisting"); payload != "" {
		t.Fatal("pre-existing root adopted")
	}
	if err := f.server.createOwnedWorkspaceRoot(&WorkspaceRuntime{ID: "user-root"}, f.server.config.WorkspaceDir); err != nil {
		t.Fatal(err)
	}
	if payload, _ := f.server.store.GetOwnedWorkspaceRoot("user-root"); payload != "" {
		t.Fatal("configured root adopted")
	}
}

func TestWorkspaceDeletionFilesystemBudgetAndSymlinks(t *testing.T) {
	root := filepath.Join(t.TempDir(), "owned")
	if err := os.Mkdir(root, 0755); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	marker := filepath.Join(outside, "keep")
	if err := os.WriteFile(marker, []byte("user data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "outside")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a", "b", "c", "d"} {
		if err := os.WriteFile(filepath.Join(root, name), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	dev, ino, err := deletionRootIdentity(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := removeDeletionRoot(t.Context(), root, dev, ino, 2); err == nil {
		t.Fatal("budget ignored")
	}
	if entries, err := os.ReadDir(root); err != nil || len(entries) != 3 {
		t.Fatalf("expected exactly 2 removals; remaining=%d err=%v", len(entries), err)
	}
	if err := removeDeletionRoot(t.Context(), root, dev, ino, 10); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(marker); err != nil || string(got) != "user data" {
		t.Fatal("symlink target changed", err)
	}
}
func TestOwnedStandaloneSubrootPhysicalDeletion(t *testing.T) {
	f := newDeletionFixture(t)
	f.server.config.Role = config.RoleStandalone
	// Recreate only the new SAM-owned root through the ownership-recording path.
	if err := os.RemoveAll(f.root); err != nil {
		t.Fatal(err)
	}
	existing := filepath.Join(f.server.config.WorkspaceDir, "preexisting")
	if err := os.Mkdir(existing, 0755); err != nil {
		t.Fatal(err)
	}
	if err := f.server.createOwnedWorkspaceRoot(&WorkspaceRuntime{ID: "preexisting"}, existing); err != nil {
		t.Fatal(err)
	}
	if rec := f.request(t.Context(), f.identity); rec.Code != 200 {
		t.Fatalf("owned subroot deletion failed: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Lstat(f.root); !os.IsNotExist(err) {
		t.Fatal("owned root still exists", err)
	}
	if _, err := os.Lstat(filepath.Join(f.state, "volume")); err != nil {
		t.Fatal("standalone deletion touched Docker volume", err)
	}
}

func TestWorkspaceDeletionRootReplacementBeforeOpenPreservesSuccessor(t *testing.T) {
	root := filepath.Join(t.TempDir(), "workspace")
	if err := os.Mkdir(root, 0755); err != nil {
		t.Fatal(err)
	}
	dev, ino, err := deletionRootIdentity(root)
	if err != nil {
		t.Fatal(err)
	}
	err = removeDeletionRootWithOpener(t.Context(), root, dev, ino, 10, func(path string) (*os.Root, error) {
		if err := os.Rename(path, path+".old"); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(path, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "successor-data"), []byte("keep"), 0600); err != nil {
			t.Fatal(err)
		}
		return os.OpenRoot(path)
	})
	if err == nil {
		t.Fatal("opened successor accepted")
	}
	if data, err := os.ReadFile(filepath.Join(root, "successor-data")); err != nil || string(data) != "keep" {
		t.Fatal("successor was modified before identity check", err)
	}
}

func TestWorkspaceDeletionPreservesUnknownVolumeOwnership(t *testing.T) {
	f := newDeletionFixture(t)
	t.Setenv("SAM_DELETE_TEST_OWNER", "unknown")
	if rec := f.request(t.Context(), f.identity); rec.Code != 503 {
		t.Fatalf("unknown volume accepted: %d %s", rec.Code, rec.Body.String())
	}
	for _, path := range []string{f.root, filepath.Join(f.state, "volume"), filepath.Join(f.state, "container")} {
		if _, err := os.Lstat(path); err != nil {
			t.Fatalf("unknown ownership artifact removed: %s %v", path, err)
		}
	}
	if intent, _ := f.server.store.GetWorkspaceDeletion("workspace-1"); intent != "" {
		t.Fatal("unknown volume gained durable deletion authority")
	}
}

func TestAutomaticWorkspaceDeletionExpiryAndExplicitPromotion(t *testing.T) {
	f := newDeletionFixture(t)
	automatic := workspaceDeletionRequest{workspaceDeletionIdentity: f.identity, DeletionMode: "automatic", PreservationExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)}
	if rec := f.request(t.Context(), automatic); rec.Code != 503 {
		t.Fatalf("prepare=%d %s", rec.Code, rec.Body.String())
	}
	payload, err := f.server.store.GetWorkspaceDeletion("workspace-1")
	if err != nil {
		t.Fatal(err)
	}
	var intent workspaceDeletionIntent
	if err := json.Unmarshal([]byte(payload), &intent); err != nil {
		t.Fatal(err)
	}
	intent.PreservationExpiresAt = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	if err := f.server.saveWorkspaceDeletion(&intent); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(filepath.Join(f.state, "fail-volume"))
	f.server.reconcileWorkspaceDeletions(t.Context())
	if _, err := os.Stat(f.root); err != nil {
		t.Fatal("expired automatic intent deleted preserved root", err)
	}
	if _, err := os.Stat(filepath.Join(f.state, "volume")); err != nil {
		t.Fatal("expired automatic intent deleted volume", err)
	}
	if rec := f.request(t.Context(), f.identity); rec.Code != 200 {
		t.Fatalf("fresh explicit promotion failed=%d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(f.root); !os.IsNotExist(err) {
		t.Fatal("explicit deletion did not complete", err)
	}
}

func TestWorkspaceDeletionPreservesUnmarkedManagedRootBeforeContainerRemoval(t *testing.T) {
	f := newDeletionFixture(t)
	if err := f.server.store.DeleteOwnedWorkspaceRoot("workspace-1"); err != nil {
		t.Fatal(err)
	}
	if rec := f.request(t.Context(), f.identity); rec.Code != 409 {
		t.Fatalf("unmarked managed root accepted: %d %s", rec.Code, rec.Body.String())
	}
	for _, path := range []string{f.root, filepath.Join(f.state, "container"), filepath.Join(f.state, "volume")} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("unmarked artifact removed %s: %v", path, err)
		}
	}
	if intent, _ := f.server.store.GetWorkspaceDeletion("workspace-1"); intent != "" {
		t.Fatal("unmarked artifacts gained deletion authority")
	}
}
func TestWorkspaceDeletionRemovesOnlyItsCredentialHelper(t *testing.T) {
	f := newDeletionFixture(t)
	path := "/tmp/git-credential-sam-workspace-1"
	helper, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if os.IsExist(err) {
		t.Skip("pre-existing helper preserved by test")
	}
	if err != nil {
		t.Fatal(err)
	}
	helper.Close()
	t.Cleanup(func() { _ = os.Remove(path) })
	unrelated, err := os.CreateTemp("", "sam-cleanup-unrelated-")
	if err != nil {
		t.Fatal(err)
	}
	unrelated.Close()
	defer os.Remove(unrelated.Name())
	_ = os.Remove(filepath.Join(f.state, "fail-volume"))
	if rec := f.request(t.Context(), f.identity); rec.Code != 200 {
		t.Fatalf("delete=%d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatal("credential helper survived deletion", err)
	}
	if _, err := os.Lstat(unrelated.Name()); err != nil {
		t.Fatal("unrelated scratch changed", err)
	}
	if proof, _ := f.server.store.GetOwnedWorkspaceRoot("workspace-1"); proof != "" {
		t.Fatal("finalized deletion retained ownership marker")
	}
}
