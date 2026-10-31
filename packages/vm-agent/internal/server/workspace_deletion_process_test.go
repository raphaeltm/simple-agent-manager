package server

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/persistence"
)

const workspaceDeletionCrashExit = 73

type deletionProcessManifest struct {
	Database string                    `json:"database"`
	Root     string                    `json:"root"`
	State    string                    `json:"state"`
	Path     string                    `json:"path"`
	Identity workspaceDeletionIdentity `json:"identity"`
	Intent   workspaceDeletionIntent   `json:"intent"`
}

// The first process exits without running SQLite Close or any test cleanup.
// A separate process must recover solely from the committed intent and exact
// external artifact state, through the production reconciliation operation.
func TestWorkspaceDeletionSurvivesRealProcessExit(t *testing.T) {
	sandbox := t.TempDir()
	manifestPath := filepath.Join(sandbox, "handoff.json")
	run := func(stage string) ([]byte, error) {
		ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestWorkspaceDeletionProcessHelper$", "-test.count=1")
		command.Env = append(os.Environ(), "TMPDIR="+sandbox, "SAM_WORKSPACE_DELETION_PROCESS_STAGE="+stage, "SAM_WORKSPACE_DELETION_PROCESS_MANIFEST="+manifestPath)
		return command.CombinedOutput()
	}
	output, err := run("prepare")
	var exited *exec.ExitError
	if !errors.As(err, &exited) || exited.ExitCode() != workspaceDeletionCrashExit {
		t.Fatalf("first process did not exit at durable partial cleanup: %v\n%s", err, output)
	}
	manifest := readDeletionProcessManifest(t, manifestPath)
	// Confirm the first process really removed the container but retained the
	// failed volume and host bytes before letting the new process retry.
	if _, err := os.Stat(filepath.Join(manifest.State, "container")); !os.IsNotExist(err) {
		t.Fatal("first process did not remove the container", err)
	}
	for _, path := range []string{manifest.Root, filepath.Join(manifest.State, "volume")} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("partial cleanup lost %s: %v", path, err)
		}
	}
	if err := os.Remove(filepath.Join(manifest.State, "fail-volume")); err != nil {
		t.Fatal(err)
	}
	output, err = run("resume")
	if err != nil {
		t.Fatalf("new process failed to reconcile durable deletion: %v\n%s", err, output)
	}
	assertDeletionProcessCompleted(t, manifest)
	commands, err := os.ReadFile(filepath.Join(manifest.State, "commands"))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(commands), "rm -f "+manifest.Intent.Containers[0]+"\n"); got != 1 {
		t.Fatalf("container identity was rediscovered/deleted again across restart: count=%d commands=%s", got, commands)
	}
	if strings.Contains(string(commands), "prune") || strings.Contains(string(commands), "volume rm -f") {
		t.Fatalf("restart broadened cleanup authority: %s", commands)
	}
}

func TestWorkspaceDeletionProcessHelper(t *testing.T) {
	stage := os.Getenv("SAM_WORKSPACE_DELETION_PROCESS_STAGE")
	if stage == "" {
		t.Skip("subprocess helper")
	}
	manifestPath := os.Getenv("SAM_WORKSPACE_DELETION_PROCESS_MANIFEST")
	switch stage {
	case "prepare":
		fixture := newDeletionFixture(t)
		response := fixture.request(t.Context(), fixture.identity)
		if response.Code != 503 {
			t.Fatalf("expected failed volume cleanup: %d %s", response.Code, response.Body.String())
		}
		payload, err := fixture.server.store.GetWorkspaceDeletion(fixture.identity.WorkspaceID)
		if err != nil {
			t.Fatal(err)
		}
		var intent workspaceDeletionIntent
		if err := json.Unmarshal([]byte(payload), &intent); err != nil {
			t.Fatal(err)
		}
		if intent.Completed || intent.Finalized || len(intent.Containers) != 1 {
			t.Fatalf("unexpected partial intent: %+v", intent)
		}
		if meta, err := fixture.server.store.GetWorkspaceMetadata(fixture.identity.WorkspaceID); err != nil || meta == nil {
			t.Fatalf("metadata lost before process exit: %+v %v", meta, err)
		}
		manifest := deletionProcessManifest{Database: fixture.db, Root: fixture.root, State: fixture.state, Path: os.Getenv("PATH"), Identity: fixture.identity, Intent: intent}
		bytes, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(manifestPath, bytes, 0600); err != nil {
			t.Fatal(err)
		}
		os.Exit(workspaceDeletionCrashExit)
	case "resume":
		manifest := readDeletionProcessManifest(t, manifestPath)
		t.Setenv("PATH", manifest.Path)
		t.Setenv("SAM_DELETE_TEST_STATE", manifest.State)
		server := newWorkspaceCreateServer(t, "http://127.0.0.1:1", nil)
		server.config.WorkspaceDir = filepath.Dir(manifest.Root)
		server.config.NodeID = manifest.Identity.NodeID
		server.config.NodeUserID = manifest.Identity.UserID
		server.config.NodeRuntimeIncarnationID = manifest.Identity.NodeRuntimeIncarnationID
		store, err := persistence.Open(manifest.Database)
		if err != nil {
			t.Fatal(err)
		}
		defer store.Close()
		server.store = store
		server.reconcileWorkspaceDeletions(t.Context())
		if _, ok := server.getWorkspaceRuntime(manifest.Identity.WorkspaceID); ok {
			t.Fatal("reconciliation recreated a runtime")
		}
		assertDeletionProcessCompleted(t, manifest)
	default:
		t.Fatalf("unknown subprocess stage %q", stage)
	}
}

func readDeletionProcessManifest(t *testing.T, path string) deletionProcessManifest {
	t.Helper()
	bytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var manifest deletionProcessManifest
	if err := json.Unmarshal(bytes, &manifest); err != nil {
		t.Fatal(err)
	}
	return manifest
}
func assertDeletionProcessCompleted(t *testing.T, manifest deletionProcessManifest) {
	t.Helper()
	for _, path := range []string{manifest.Root, filepath.Join(manifest.State, "container"), filepath.Join(manifest.State, "volume")} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("physical artifact survived process restart: %s %v", path, err)
		}
	}
	store, err := persistence.Open(manifest.Database)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if meta, err := store.GetWorkspaceMetadata(manifest.Identity.WorkspaceID); err != nil || meta != nil {
		t.Fatalf("local metadata survived completed deletion: %+v %v", meta, err)
	}
	payload, err := store.GetWorkspaceDeletion(manifest.Identity.WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	var current workspaceDeletionIntent
	if err := json.Unmarshal([]byte(payload), &current); err != nil {
		t.Fatal(err)
	}
	expected := manifest.Intent
	expected.Completed = true
	expected.Finalized = true
	gotJSON, _ := json.Marshal(current)
	wantJSON, _ := json.Marshal(expected)
	if string(gotJSON) != string(wantJSON) {
		t.Fatalf("restart changed deletion identity/artifacts instead of completing exact intent:\ngot %s\nwant %s", gotJSON, wantJSON)
	}
	if proof, err := store.GetOwnedWorkspaceRoot(manifest.Identity.WorkspaceID); err != nil || proof != "" {
		t.Fatalf("completed ownership record survived: %q %v", proof, err)
	}
}
