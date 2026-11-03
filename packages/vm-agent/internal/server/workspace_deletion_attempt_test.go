package server

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// oldEntryBudget is the per-attempt entry cap removed after production stops took
// ~31 minutes: a ~10k-entry clone needed ~20 one-minute attempts.
const oldEntryBudget = 512

// writeDeletionTree creates dirs*files files plus dirs directories (more than the
// old per-attempt entry cap when dirs*files exceeds it).
func writeDeletionTree(t *testing.T, root string, dirs, files int) {
	t.Helper()
	for d := 0; d < dirs; d++ {
		dir := filepath.Join(root, fmt.Sprintf("pkg-%02d", d), "src")
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
		for f := 0; f < files; f++ {
			if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("file-%03d.ts", f)), []byte("x"), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestWorkspaceDeletionRemovesTreeLargerThanOldEntryBudgetInOneAttempt(t *testing.T) {
	root := filepath.Join(t.TempDir(), "owned")
	if err := os.Mkdir(root, 0755); err != nil {
		t.Fatal(err)
	}
	writeDeletionTree(t, root, 40, 30)
	dev, ino, err := deletionRootIdentity(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := removeDeletionRoot(t.Context(), root, dev, ino); err != nil {
		t.Fatalf("single attempt over %d entries failed: %v", oldEntryBudget, err)
	}
	if _, err := os.Lstat(root); !os.IsNotExist(err) {
		t.Fatal("root survived a single attempt", err)
	}
}

func waitForDeletionCommand(t *testing.T, f deletionFixture, command string, count int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		commands, _ := os.ReadFile(filepath.Join(f.state, "commands"))
		if strings.Count(string(commands), command) >= count {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	commands, _ := os.ReadFile(filepath.Join(f.state, "commands"))
	t.Fatalf("timed out waiting for %d x %q; commands:\n%s", count, command, commands)
}

// The control plane stops waiting after a few seconds (its background request
// timeout). Once the handler holds the lifecycle lock, that disconnect must not
// cancel the Docker and filesystem work it already started.
func TestWorkspaceDeletionInlineAttemptSurvivesCallerCancellation(t *testing.T) {
	f := newDeletionFixture(t)
	writeDeletionTree(t, f.root, 40, 30)
	if err := os.Remove(filepath.Join(f.state, "fail-volume")); err != nil {
		t.Fatal(err)
	}
	gate := filepath.Join(t.TempDir(), "release-docker-ps")
	t.Setenv("SAM_DELETE_TEST_PS_GATE", gate)

	ctx, cancelCaller := context.WithCancel(t.Context())
	defer cancelCaller()
	result := make(chan int, 1)
	go func() { result <- f.request(ctx, f.identity).Code }()

	// The first Docker call happens after the lock is held: the attempt has started.
	waitForDeletionCommand(t, f, "ps -aq", 1)
	cancelCaller()
	if err := os.WriteFile(gate, nil, 0600); err != nil {
		t.Fatal(err)
	}

	select {
	case code := <-result:
		if code != 200 {
			t.Fatalf("caller cancellation aborted the inline attempt: status %d", code)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("handler did not finish")
	}
	if _, err := os.Lstat(f.root); !os.IsNotExist(err) {
		t.Fatal("root survived the detached attempt", err)
	}
	if meta, err := f.server.store.GetWorkspaceMetadata("workspace-1"); err != nil || meta != nil {
		t.Fatalf("deletion not finalized: %#v %v", meta, err)
	}
}

// A pending inline attempt must hand off to the reconciler immediately instead of
// leaving the durable intent until the next tick.
func TestWorkspaceDeletionPendingInlineAttemptWakesReconciler(t *testing.T) {
	f := newDeletionFixture(t)
	f.server.config.WorkspaceDeletionRetryInterval = time.Hour

	// Persist a pending intent before the reconciler runs (volume busy).
	if code := f.request(t.Context(), f.identity).Code; code != 503 {
		t.Fatalf("first attempt = %d, want 503", code)
	}
	f.server.startWorkspaceDeletionReconciler()
	t.Cleanup(f.server.stopWorkspaceDeletionReconciler)
	// The reconciler's startup pass also fails; afterwards it is parked on an
	// hour-long ticker, so only a wake can run another pass.
	waitForDeletionCommand(t, f, "volume rm", 2)

	// The next inline attempt fails once more, then the volume becomes removable.
	if err := os.WriteFile(filepath.Join(f.state, "fail-volume-once"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if code := f.request(t.Context(), f.identity).Code; code != 503 {
		t.Fatalf("second attempt = %d, want 503", code)
	}

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Lstat(f.root); os.IsNotExist(err) {
			if meta, err := f.server.store.GetWorkspaceMetadata("workspace-1"); err == nil && meta == nil {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	commands, _ := os.ReadFile(filepath.Join(f.state, "commands"))
	t.Fatalf("reconciler was not woken; commands:\n%s", commands)
}

// A directory larger than one read batch is drained across reopened batches in the
// same attempt.
func TestWorkspaceDeletionDrainsDirectoryLargerThanOneReadBatch(t *testing.T) {
	root := filepath.Join(t.TempDir(), "owned")
	flat := filepath.Join(root, "cache")
	if err := os.MkdirAll(flat, 0755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < deletionDirReadBatch+5; i++ {
		if err := os.WriteFile(filepath.Join(flat, fmt.Sprintf("entry-%05d", i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	dev, ino, err := deletionRootIdentity(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := removeDeletionRoot(t.Context(), root, dev, ino); err != nil {
		t.Fatalf("multi-batch directory failed: %v", err)
	}
	if _, err := os.Lstat(root); !os.IsNotExist(err) {
		t.Fatal("root survived a multi-batch attempt", err)
	}
}
