package deploy

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"sync"
	"testing"
	"time"
)

func TestEngine_ReconcileOnStart_NoState(t *testing.T) {
	dir := t.TempDir()
	disk, _ := NewDiskState(dir)
	engine := NewEngine(disk, nil, EngineConfig{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
	})

	ctx := context.Background()
	if err := engine.ReconcileOnStart(ctx); err != nil {
		t.Fatalf("ReconcileOnStart: %v", err)
	}

	observed := engine.GetObserved()
	if observed.AppliedSeq != 0 {
		t.Errorf("expected appliedSeq=0, got %d", observed.AppliedSeq)
	}
}

func TestEngine_ReconcileOnStart_WithState(t *testing.T) {
	dir := t.TempDir()
	disk, _ := NewDiskState(dir)

	// Write a release and set as current
	state := &ReleaseState{
		Seq:           5,
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		Status:        StatusApplied,
		AppliedAt:     time.Now().UTC(),
	}
	disk.WriteRelease(state, "version: '3'\n")
	disk.SetCurrent(5)

	engine := NewEngine(disk, nil, EngineConfig{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		ComposeCmd:    "echo", // Won't actually run docker compose
	})

	ctx := context.Background()
	// ReconcileOnStart will try to inspect services, which will fail with a fake compose cmd.
	// That's OK — it should still set the observed state from disk.
	engine.ReconcileOnStart(ctx)

	observed := engine.GetObserved()
	if observed.AppliedSeq != 5 {
		t.Errorf("expected appliedSeq=5, got %d", observed.AppliedSeq)
	}
	if observed.Status != StatusApplied {
		t.Errorf("expected status=applied, got %s", observed.Status)
	}
}

func TestEngine_ApplyMutex(t *testing.T) {
	dir := t.TempDir()
	disk, _ := NewDiskState(dir)

	engine := NewEngine(disk, nil, EngineConfig{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		ComposeCmd:    "sleep", // Will be "sleep -f pull" which fails, but that's fine
		HealthTimeout: 1 * time.Second,
	})

	// Manually set the applying flag to simulate an in-progress apply
	engine.applyMu.Lock()
	engine.applying = true
	engine.applyMu.Unlock()

	payload := &ApplyPayload{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		Seq:           1,
		ExpiresAt:     time.Now().Add(1 * time.Hour).Unix(),
		ComposeYAML:   "compose yaml",
	}

	ctx := context.Background()
	err := engine.Apply(ctx, payload)
	if err == nil || err.Error() != "apply in progress" {
		t.Errorf("expected 'apply in progress' error, got: %v", err)
	}

	// Reset
	engine.applyMu.Lock()
	engine.applying = false
	engine.applyMu.Unlock()
}

func TestEngine_ApplyRejectsInvalidPayload(t *testing.T) {
	dir := t.TempDir()
	disk, _ := NewDiskState(dir)
	pub, _ := generateTestKeys(t)
	_, wrongPriv := generateTestKeys(t)
	pubB64 := base64.StdEncoding.EncodeToString(pub)
	verifier, _ := NewVerifier(pubB64)

	engine := NewEngine(disk, verifier, EngineConfig{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
	})

	// Sign with wrong key
	payload := makeTestPayload("env-1", "node-1", 1, "compose yaml", wrongPriv)

	ctx := context.Background()
	err := engine.Apply(ctx, payload)
	if err == nil {
		t.Error("expected apply to reject payload with wrong signature")
	}
}

func TestEngine_ApplyRejectsWrongEnv(t *testing.T) {
	dir := t.TempDir()
	disk, _ := NewDiskState(dir)
	pub, priv := generateTestKeys(t)
	pubB64 := base64.StdEncoding.EncodeToString(pub)
	verifier, _ := NewVerifier(pubB64)

	engine := NewEngine(disk, verifier, EngineConfig{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
	})

	// Payload for different environment
	payload := makeTestPayload("env-WRONG", "node-1", 1, "compose yaml", priv)

	ctx := context.Background()
	err := engine.Apply(ctx, payload)
	if err == nil {
		t.Error("expected apply to reject payload for wrong environment")
	}
}

func TestEngine_ApplyRejectsSequenceReplay(t *testing.T) {
	dir := t.TempDir()
	disk, _ := NewDiskState(dir)

	// Simulate already having applied seq 5
	state := &ReleaseState{Seq: 5, Status: StatusApplied}
	disk.WriteRelease(state, "old compose")
	disk.SetCurrent(5)

	pub, priv := generateTestKeys(t)
	pubB64 := base64.StdEncoding.EncodeToString(pub)
	verifier, _ := NewVerifier(pubB64)

	engine := NewEngine(disk, verifier, EngineConfig{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
	})

	// Try to apply seq 3 (less than current 5)
	payload := makeTestPayload("env-1", "node-1", 3, "compose yaml", priv)

	ctx := context.Background()
	err := engine.Apply(ctx, payload)
	if err == nil {
		t.Error("expected apply to reject sequence replay")
	}
}

func TestEngine_GetObserved_ThreadSafe(t *testing.T) {
	dir := t.TempDir()
	disk, _ := NewDiskState(dir)
	engine := NewEngine(disk, nil, EngineConfig{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
	})

	// Concurrent reads and writes should not race
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			engine.GetObserved()
		}()
		go func(seq int) {
			defer wg.Done()
			engine.setObserved(ObservedState{
				AppliedSeq: int64(seq),
				Status:     StatusApplied,
			})
		}(i)
	}
	wg.Wait()
}

func TestSignPayload_Roundtrip(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	pubB64 := base64.StdEncoding.EncodeToString(pub)

	payload := &ApplyPayload{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		Seq:           42,
		ExpiresAt:     time.Now().Add(1 * time.Hour).Unix(),
		ComposeYAML:   "version: '3'\nservices:\n  app:\n    image: myapp:v1\n",
	}

	sig, err := SignPayload(payload, priv)
	if err != nil {
		t.Fatalf("SignPayload: %v", err)
	}
	payload.Signature = sig

	v, err := NewVerifier(pubB64)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	if err := v.Verify(payload, "env-1", "node-1", 41); err != nil {
		t.Errorf("verification failed: %v", err)
	}
}
