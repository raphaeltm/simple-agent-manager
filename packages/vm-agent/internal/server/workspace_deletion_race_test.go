package server

import (
	"database/sql"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func waitDeletionBarrier(t *testing.T, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ready() {
		if time.Now().After(deadline) {
			t.Fatal("deletion barrier was not reached")
		}
		runtime.Gosched()
	}
}
func readDeletionIntent(t *testing.T, f deletionFixture) workspaceDeletionIntent {
	t.Helper()
	payload, err := f.server.store.GetWorkspaceDeletion("workspace-1")
	if err != nil {
		t.Fatal(err)
	}
	var d workspaceDeletionIntent
	if err := json.Unmarshal([]byte(payload), &d); err != nil {
		t.Fatal(err)
	}
	return d
}
func TestWorkspaceDeletionReconcilerReloadsAfterInlineCompletion(t *testing.T) {
	f := newDeletionFixture(t)
	if rec := f.request(t.Context(), f.identity); rec.Code != 503 {
		t.Fatalf("prepare: %d %s", rec.Code, rec.Body.String())
	}
	if err := os.Remove(filepath.Join(f.state, "fail-volume")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(f.state, "commands")); err != nil {
		t.Fatal(err)
	}
	gate := filepath.Join(f.state, "release-inline")
	t.Setenv("SAM_DELETE_TEST_PS_GATE", gate)
	inlineDone := make(chan *httptest.ResponseRecorder, 1)
	go func() { inlineDone <- f.request(t.Context(), f.identity) }()
	t.Cleanup(func() { _ = os.WriteFile(gate, nil, 0600) })
	// Observe the HTTP writer holding the lifecycle lock at its Docker boundary.
	waitDeletionBarrier(t, func() bool {
		b, _ := os.ReadFile(filepath.Join(f.state, "commands"))
		return strings.Contains(string(b), "ps -aq")
	})
	reconcileDone := make(chan struct{})
	go func() { defer close(reconcileDone); f.server.reconcileWorkspaceDeletions(t.Context()) }()
	waitDeletionBarrier(t, func() bool {
		f.server.workspaceLifecycleMu.Lock()
		defer f.server.workspaceLifecycleMu.Unlock()
		entry := f.server.workspaceLifecycleLocks["workspace-1"]
		return entry != nil && entry.users == 2
	})
	// Reconciler read the pending intent and is waiting behind the inline writer.
	if err := os.WriteFile(gate, nil, 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case rec := <-inlineDone:
		if rec.Code != 200 {
			t.Fatalf("inline: %d %s", rec.Code, rec.Body.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("inline stalled")
	}
	select {
	case <-reconcileDone:
	case <-time.After(5 * time.Second):
		t.Fatal("reconciler stalled")
	}
	d := readDeletionIntent(t, f)
	if !d.Completed || !d.Finalized {
		t.Errorf("reconciler regressed completed deletion: %+v", d)
	}
	// Extra queries expose stale work even if recovery hides the regression.
	commands, err := os.ReadFile(filepath.Join(f.state, "commands"))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(commands), "ps -aq"); got != 3 {
		t.Errorf("Docker queries=%d, want 3 from inline writer only; commands=%s", got, commands)
	}
}
func TestWorkspaceDeletionPoisonedIntentRecovery(t *testing.T) {
	for _, entrypoint := range []string{"http", "reconciler"} {
		for _, remaining := range []string{"none", "root", "container", "volume", "node", "owner", "incarnation", "runtime", "expiry", "container probe", "volume probe"} {
			t.Run(entrypoint+"/"+remaining, func(t *testing.T) {
				f := newDeletionFixture(t)
				if rec := f.request(t.Context(), f.identity); rec.Code != 503 {
					t.Fatalf("prepare: %d %s", rec.Code, rec.Body.String())
				}
				// Durable state left by stale error-path write after successful deletion.
				if err := f.server.store.DeleteWorkspaceMetadata("workspace-1"); err != nil {
					t.Fatal(err)
				}
				for _, path := range []string{f.root, filepath.Join(f.state, "container"), filepath.Join(f.state, "volume")} {
					if err := os.RemoveAll(path); err != nil {
						t.Fatal(err)
					}
				}
				var kept string
				var request any = f.identity
				switch remaining {
				case "root":
					kept = f.root
					if err := os.Mkdir(kept, 0700); err != nil {
						t.Fatal(err)
					}
				case "container", "volume":
					kept = filepath.Join(f.state, remaining)
					if err := os.WriteFile(kept, nil, 0600); err != nil {
						t.Fatal(err)
					}
				case "runtime":
					f.server.workspaceMu.Lock()
					f.server.workspaces["workspace-1"] = &WorkspaceRuntime{ID: "workspace-1", EvictionGeneration: "successor-generation"}
					f.server.workspaceMu.Unlock()
				case "expiry":
					d := readDeletionIntent(t, f)
					d.DeletionMode = "automatic"
					d.PreservationExpiresAt = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
					if err := f.server.saveWorkspaceDeletion(&d); err != nil {
						t.Fatal(err)
					}
					request = workspaceDeletionRequest{workspaceDeletionIdentity: f.identity, DeletionMode: d.DeletionMode, PreservationExpiresAt: d.PreservationExpiresAt}
				case "container probe", "volume probe":
					bin := t.TempDir()
					script := "#!/bin/sh\nexit 1\n"
					if remaining == "volume probe" {
						script = "#!/bin/sh\nif [ \"$1\" = ps ]; then exit 0; fi\nexit 1\n"
					}
					if err := os.WriteFile(filepath.Join(bin, "docker"), []byte(script), 0700); err != nil {
						t.Fatal(err)
					}
					t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
				case "node":
					f.server.config.NodeID = "successor-node"
				case "owner":
					f.server.config.NodeUserID = "successor-owner"
				case "incarnation":
					f.server.config.NodeRuntimeIncarnationID = "successor-incarnation"
				}
				if entrypoint == "http" {
					rec := f.request(t.Context(), request)
					if remaining == "none" && rec.Code != 200 {
						t.Errorf("recovery: %d %s", rec.Code, rec.Body.String())
					}
					if remaining != "none" && rec.Code == 200 {
						t.Errorf("unsafe success: %s", rec.Body.String())
					}
				} else {
					f.server.reconcileWorkspaceDeletions(t.Context())
				}
				d := readDeletionIntent(t, f)
				if remaining == "none" {
					if !d.Completed || !d.Finalized {
						t.Errorf("cleanup failed to converge: %+v", d)
					}
				} else {
					if d.Completed || d.Finalized {
						t.Errorf("unproven cleanup finalized: %+v", d)
					}
					if kept != "" {
						if _, err := os.Lstat(kept); err != nil {
							t.Errorf("unproven artifact removed: %v", err)
						}
					}
				}
			})
		}
	}
}

func TestWorkspaceDeletionReconcilerDoesNotRewriteFailedAttempt(t *testing.T) {
	f := newDeletionFixture(t)
	if rec := f.request(t.Context(), f.identity); rec.Code != 503 {
		t.Fatalf("prepare: %d %s", rec.Code, rec.Body.String())
	}
	d := readDeletionIntent(t, f)
	// Valid JSON formatting makes an otherwise redundant stale write observable
	// without relying on second-resolution database timestamps or sleeps.
	payload, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := f.server.store.PutWorkspaceDeletion(d.WorkspaceID, string(payload)); err != nil {
		t.Fatal(err)
	}
	f.server.reconcileWorkspaceDeletions(t.Context())
	after, err := f.server.store.GetWorkspaceDeletion(d.WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	if after != string(payload) {
		t.Fatal("failed cleanup rewrote durable authority instead of leaving persistence to successful checkpoints")
	}
	if _, err := os.Stat(f.root); err != nil {
		t.Fatalf("failed cleanup lost root: %v", err)
	}
}

func TestWorkspaceDeletionReconcilerRechecksAuthorityUnderLock(t *testing.T) {
	for _, kind := range []string{"absent", "malformed", "mismatched key"} {
		t.Run(kind, func(t *testing.T) {
			f := newDeletionFixture(t)
			if rec := f.request(t.Context(), f.identity); rec.Code != 503 {
				t.Fatalf("prepare: %d %s", rec.Code, rec.Body.String())
			}
			if err := os.Remove(filepath.Join(f.state, "fail-volume")); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(filepath.Join(f.state, "commands"))
			if err != nil {
				t.Fatal(err)
			}
			lock := f.server.workspaceLifecycleLock("workspace-1")
			if err := lock.Lock(t.Context()); err != nil {
				t.Fatal(err)
			}
			locked := true
			defer func() {
				if locked {
					lock.Unlock()
				}
			}()
			done := make(chan struct{})
			go func() { defer close(done); f.server.reconcileWorkspaceDeletions(t.Context()) }()
			waitDeletionBarrier(t, func() bool {
				f.server.workspaceLifecycleMu.Lock()
				defer f.server.workspaceLifecycleMu.Unlock()
				entry := f.server.workspaceLifecycleLocks["workspace-1"]
				return entry != nil && entry.users == 2
			})
			var payload string
			switch kind {
			case "absent":
				db, err := sql.Open("sqlite", f.db)
				if err != nil {
					t.Fatal(err)
				}
				defer db.Close()
				if _, err := db.Exec("DELETE FROM workspace_deletions WHERE workspace_id=?", "workspace-1"); err != nil {
					t.Fatal(err)
				}
			case "malformed":
				payload = "{"
			case "mismatched key":
				d := readDeletionIntent(t, f)
				d.WorkspaceID = "different-workspace"
				b, err := json.Marshal(d)
				if err != nil {
					t.Fatal(err)
				}
				payload = string(b)
			}
			if kind != "absent" {
				if err := f.server.store.PutWorkspaceDeletion("workspace-1", payload); err != nil {
					t.Fatal(err)
				}
			}
			lock.Unlock()
			locked = false
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("reconciler stalled")
			}
			after, err := os.ReadFile(filepath.Join(f.state, "commands"))
			if err != nil {
				t.Fatal(err)
			}
			if string(after) != string(before) {
				t.Fatal("reconciler performed Docker work after authority changed")
			}
			stored, err := f.server.store.GetWorkspaceDeletion("workspace-1")
			if err != nil {
				t.Fatal(err)
			}
			if stored != payload {
				t.Fatalf("changed authority rewritten: %q", stored)
			}
			for _, path := range []string{f.root, filepath.Join(f.state, "volume")} {
				if _, err := os.Lstat(path); err != nil {
					t.Errorf("artifact deleted without authority: %v", err)
				}
			}
		})
	}
}
