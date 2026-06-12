package deploy

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDiskState_NoState(t *testing.T) {
	dir := t.TempDir()
	ds, err := NewDiskState(dir)
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}

	seq, err := ds.CurrentSeq()
	if err != nil {
		t.Fatalf("CurrentSeq: %v", err)
	}
	if seq != 0 {
		t.Errorf("expected seq=0 for empty state, got %d", seq)
	}

	state, err := ds.CurrentState()
	if err != nil {
		t.Fatalf("CurrentState: %v", err)
	}
	if state != nil {
		t.Errorf("expected nil state for empty disk, got %+v", state)
	}
}

func TestDiskState_WriteAndRead(t *testing.T) {
	dir := t.TempDir()
	ds, err := NewDiskState(dir)
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}

	state := &ReleaseState{
		Seq:           42,
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		Status:        StatusApplied,
		AppliedAt:     time.Now().UTC().Truncate(time.Second),
	}
	composeYAML := "version: '3'\nservices:\n  web:\n    image: nginx\n"
	caddyfile := "example.com {\n\treverse_proxy 127.0.0.1:35000\n}\n"

	if err := ds.WriteRelease(state, composeYAML, caddyfile); err != nil {
		t.Fatalf("WriteRelease: %v", err)
	}

	// Verify compose file was written
	composePath := ds.ComposeFilePath(42)
	data, err := os.ReadFile(composePath)
	if err != nil {
		t.Fatalf("read compose file: %v", err)
	}
	if string(data) != composeYAML {
		t.Errorf("compose file mismatch: got %q", string(data))
	}

	caddyData, err := os.ReadFile(ds.CaddyfilePath(42))
	if err != nil {
		t.Fatalf("read Caddyfile: %v", err)
	}
	if string(caddyData) != caddyfile {
		t.Errorf("Caddyfile mismatch: got %q", string(caddyData))
	}

	// Verify metadata was written with computed hash
	readState, err := ds.ReadState(42)
	if err != nil {
		t.Fatalf("ReadState: %v", err)
	}
	if readState.Seq != 42 {
		t.Errorf("seq mismatch: got %d", readState.Seq)
	}
	if readState.ComposeHash == "" {
		t.Error("expected compose hash to be computed")
	}
	if readState.Status != StatusApplied {
		t.Errorf("status mismatch: got %s", readState.Status)
	}
}

func TestDiskState_SetCurrent(t *testing.T) {
	dir := t.TempDir()
	ds, err := NewDiskState(dir)
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}

	// Write a release
	state := &ReleaseState{Seq: 10, Status: StatusApplied}
	if err := ds.WriteRelease(state, "compose yaml", "caddyfile"); err != nil {
		t.Fatalf("WriteRelease: %v", err)
	}

	// Set current
	if err := ds.SetCurrent(10); err != nil {
		t.Fatalf("SetCurrent: %v", err)
	}

	// Read current
	seq, err := ds.CurrentSeq()
	if err != nil {
		t.Fatalf("CurrentSeq: %v", err)
	}
	if seq != 10 {
		t.Errorf("expected current seq=10, got %d", seq)
	}

	// Verify symlink target
	target, err := os.Readlink(filepath.Join(dir, "desired", "current"))
	if err != nil {
		t.Fatalf("readlink: %v", err)
	}
	if target != "releases/10" {
		t.Errorf("expected symlink target 'releases/10', got %q", target)
	}
}

func TestDiskState_SetCurrentAtomic(t *testing.T) {
	dir := t.TempDir()
	ds, err := NewDiskState(dir)
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}

	// Write two releases
	for _, seq := range []int64{1, 2} {
		state := &ReleaseState{Seq: seq, Status: StatusApplied}
		if err := ds.WriteRelease(state, "compose yaml", "caddyfile"); err != nil {
			t.Fatalf("WriteRelease seq=%d: %v", seq, err)
		}
	}

	// Set current to 1, then atomically to 2
	if err := ds.SetCurrent(1); err != nil {
		t.Fatalf("SetCurrent(1): %v", err)
	}
	if err := ds.SetCurrent(2); err != nil {
		t.Fatalf("SetCurrent(2): %v", err)
	}

	seq, _ := ds.CurrentSeq()
	if seq != 2 {
		t.Errorf("expected current seq=2 after atomic switch, got %d", seq)
	}
}

func TestDiskState_UpdateState(t *testing.T) {
	dir := t.TempDir()
	ds, err := NewDiskState(dir)
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}

	state := &ReleaseState{Seq: 5, Status: StatusApplying}
	if err := ds.WriteRelease(state, "compose yaml", "caddyfile"); err != nil {
		t.Fatalf("WriteRelease: %v", err)
	}

	// Update status
	state.Status = StatusFailed
	state.ErrorMessage = "health check timeout"
	if err := ds.UpdateState(state); err != nil {
		t.Fatalf("UpdateState: %v", err)
	}

	// Read back
	readState, err := ds.ReadState(5)
	if err != nil {
		t.Fatalf("ReadState: %v", err)
	}
	if readState.Status != StatusFailed {
		t.Errorf("expected status=failed, got %s", readState.Status)
	}
	if readState.ErrorMessage != "health check timeout" {
		t.Errorf("expected error message 'health check timeout', got %q", readState.ErrorMessage)
	}
}

func TestDiskState_CurrentComposeFilePath(t *testing.T) {
	dir := t.TempDir()
	ds, err := NewDiskState(dir)
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}

	// No current release
	_, err = ds.CurrentComposeFilePath()
	if err == nil {
		t.Error("expected error when no current release")
	}

	// Write and set current
	state := &ReleaseState{Seq: 7, Status: StatusApplied}
	if err := ds.WriteRelease(state, "yaml content", "caddyfile"); err != nil {
		t.Fatalf("WriteRelease: %v", err)
	}
	if err := ds.SetCurrent(7); err != nil {
		t.Fatalf("SetCurrent: %v", err)
	}

	path, err := ds.CurrentComposeFilePath()
	if err != nil {
		t.Fatalf("CurrentComposeFilePath: %v", err)
	}
	if filepath.Base(path) != "docker-compose.yml" {
		t.Errorf("expected docker-compose.yml, got %q", filepath.Base(path))
	}
}
