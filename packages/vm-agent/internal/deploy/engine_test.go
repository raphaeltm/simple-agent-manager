package deploy

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
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
	disk.WriteRelease(state, "version: '3'\n", "caddyfile")
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

	pub, priv := generateTestKeys(t)
	pubB64 := base64.StdEncoding.EncodeToString(pub)
	verifier, _ := NewVerifier(pubB64)

	engine := NewEngine(disk, verifier, EngineConfig{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		ComposeCmd:    "sleep",
		HealthTimeout: 1 * time.Second,
	})

	// Hold the mutex to simulate an in-progress apply
	engine.applyMu.Lock()

	payload := makeTestPayload("env-1", "node-1", 1, "compose yaml", priv)

	ctx := context.Background()
	err := engine.Apply(ctx, payload)
	if err == nil || err.Error() != "apply in progress" {
		t.Errorf("expected 'apply in progress' error, got: %v", err)
	}

	// Release the mutex
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

func TestEngine_SetVerifierKeyInitializesMissingVerifier(t *testing.T) {
	dir := t.TempDir()
	disk, _ := NewDiskState(dir)
	pub, priv := generateTestKeys(t)
	pubB64 := base64.StdEncoding.EncodeToString(pub)

	engine := NewEngine(disk, nil, EngineConfig{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		ComposeCmd:    "false",
		HealthTimeout: 1 * time.Second,
	})
	payload := makeTestPayload("env-1", "node-1", 1, "compose yaml", priv)

	err := engine.Apply(context.Background(), payload)
	if err == nil || !strings.Contains(err.Error(), "no signature verifier configured") {
		t.Fatalf("expected missing verifier rejection, got: %v", err)
	}

	if err := engine.SetVerifierKey(pubB64); err != nil {
		t.Fatalf("SetVerifierKey: %v", err)
	}

	err = engine.Apply(context.Background(), payload)
	if err == nil || !strings.Contains(err.Error(), "compose pull") {
		t.Fatalf("expected signed payload to proceed to compose pull, got: %v", err)
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
	disk.WriteRelease(state, "old compose", "old caddyfile")
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

func TestEngine_ApplyUpdatesCaddyfileAndReloadsAfterComposeConverges(t *testing.T) {
	dir := t.TempDir()
	disk, err := NewDiskState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}

	composeLog := filepath.Join(dir, "compose.log")
	composeScript := filepath.Join(dir, "compose.sh")
	if err := os.WriteFile(composeScript, []byte(`#!/bin/sh
echo "$@" >> "`+composeLog+`"
case "$*" in
  *" ps --format json"*) echo '{"Name":"web","State":"running","Health":"healthy"}' ;;
esac
exit 0
`), 0755); err != nil {
		t.Fatalf("write compose script: %v", err)
	}

	reloadLog := filepath.Join(dir, "reload.log")
	reloadScript := filepath.Join(dir, "reload.sh")
	if err := os.WriteFile(reloadScript, []byte(`#!/bin/sh
echo "$@" >> "`+reloadLog+`"
exit 0
`), 0755); err != nil {
		t.Fatalf("write reload script: %v", err)
	}

	pub, priv := generateTestKeys(t)
	verifier, err := NewVerifier(base64.StdEncoding.EncodeToString(pub))
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	activeCaddyfile := filepath.Join(dir, "active", "Caddyfile")
	engine := NewEngine(disk, verifier, EngineConfig{
		EnvironmentID:      "env-1",
		NodeID:             "node-1",
		ComposeCmd:         composeScript,
		CaddyfilePath:      activeCaddyfile,
		CaddyReloadCmd:     reloadScript + " {config}",
		HealthTimeout:      1 * time.Second,
		HealthPollInterval: 10 * time.Millisecond,
	})

	payload := &ApplyPayload{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		Seq:           1,
		ExpiresAt:     time.Now().Add(1 * time.Hour).Unix(),
		ComposeYAML:   "services:\n  web:\n    image: nginx\n    ports:\n      - 127.0.0.1:35000:3000\n",
		Routes: []RouteTarget{{
			Hostname:      "r1-web-env.apps.example.com",
			Service:       "web",
			ContainerPort: 3000,
			HostPort:      35000,
		}},
	}
	sig, err := SignPayload(payload, priv)
	if err != nil {
		t.Fatalf("SignPayload: %v", err)
	}
	payload.Signature = sig

	if err := engine.Apply(context.Background(), payload); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	seq, err := disk.CurrentSeq()
	if err != nil {
		t.Fatalf("CurrentSeq: %v", err)
	}
	if seq != 1 {
		t.Fatalf("expected current seq 1, got %d", seq)
	}

	activeBytes, err := os.ReadFile(activeCaddyfile)
	if err != nil {
		t.Fatalf("read active Caddyfile: %v", err)
	}
	active := string(activeBytes)
	if !strings.Contains(active, "r1-web-env.apps.example.com") {
		t.Fatalf("active Caddyfile missing hostname:\n%s", active)
	}
	if !strings.Contains(active, "reverse_proxy 127.0.0.1:35000") {
		t.Fatalf("active Caddyfile missing upstream:\n%s", active)
	}

	reloadBytes, err := os.ReadFile(reloadLog)
	if err != nil {
		t.Fatalf("reload command was not invoked: %v", err)
	}
	if !strings.Contains(string(reloadBytes), activeCaddyfile) {
		t.Fatalf("reload command did not receive active Caddyfile path: %q", string(reloadBytes))
	}

	composeBytes, err := os.ReadFile(composeLog)
	if err != nil {
		t.Fatalf("compose command was not invoked: %v", err)
	}
	composeOutput := string(composeBytes)
	for _, expected := range []string{"pull", "up -d --remove-orphans", "ps --format json"} {
		if !strings.Contains(composeOutput, expected) {
			t.Fatalf("compose log missing %q: %q", expected, composeOutput)
		}
	}
	if strings.Contains(composeOutput, "caddy") {
		t.Fatalf("compose commands must not restart Caddy: %q", composeOutput)
	}
}

func TestEngine_ApplyFailsBeforeMarkingAppliedWhenCaddyReloadFails(t *testing.T) {
	dir := t.TempDir()
	disk, err := NewDiskState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}

	composeScript := filepath.Join(dir, "compose.sh")
	if err := os.WriteFile(composeScript, []byte(`#!/bin/sh
case "$*" in
  *" ps --format json"*) echo '{"Name":"web","State":"running","Health":"healthy"}' ;;
esac
exit 0
`), 0755); err != nil {
		t.Fatalf("write compose script: %v", err)
	}

	reloadScript := filepath.Join(dir, "reload.sh")
	if err := os.WriteFile(reloadScript, []byte("#!/bin/sh\necho reload failed >&2\nexit 42\n"), 0755); err != nil {
		t.Fatalf("write reload script: %v", err)
	}

	pub, priv := generateTestKeys(t)
	verifier, err := NewVerifier(base64.StdEncoding.EncodeToString(pub))
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	engine := NewEngine(disk, verifier, EngineConfig{
		EnvironmentID:      "env-1",
		NodeID:             "node-1",
		ComposeCmd:         composeScript,
		CaddyfilePath:      filepath.Join(dir, "active", "Caddyfile"),
		CaddyReloadCmd:     reloadScript,
		HealthTimeout:      1 * time.Second,
		HealthPollInterval: 10 * time.Millisecond,
	})

	payload := &ApplyPayload{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		Seq:           1,
		ExpiresAt:     time.Now().Add(1 * time.Hour).Unix(),
		ComposeYAML:   "services:\n  web:\n    image: nginx\n",
		Routes: []RouteTarget{{
			Hostname:      "r1-web-env.apps.example.com",
			Service:       "web",
			ContainerPort: 3000,
			HostPort:      35000,
		}},
	}
	sig, err := SignPayload(payload, priv)
	if err != nil {
		t.Fatalf("SignPayload: %v", err)
	}
	payload.Signature = sig

	err = engine.Apply(context.Background(), payload)
	if err == nil {
		t.Fatal("expected apply to fail when caddy reload fails")
	}
	if !strings.Contains(err.Error(), "caddy reload") {
		t.Fatalf("expected caddy reload failure, got %v", err)
	}

	currentSeq, err := disk.CurrentSeq()
	if err != nil {
		t.Fatalf("CurrentSeq: %v", err)
	}
	if currentSeq != 0 {
		t.Fatalf("failed initial release must not become current, got seq %d", currentSeq)
	}

	state, err := disk.ReadState(1)
	if err != nil {
		t.Fatalf("ReadState: %v", err)
	}
	if state.Status != StatusFailedInitial {
		t.Fatalf("expected failed-initial state, got %s", state.Status)
	}

	observed := engine.GetObserved()
	if observed.Status != StatusFailedInitial {
		t.Fatalf("expected observed failed-initial status, got %s", observed.Status)
	}
	if observed.AppliedSeq != 0 {
		t.Fatalf("failed initial release must remain retryable in heartbeat, observed applied seq %d", observed.AppliedSeq)
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
