package deploy

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func makeTestRouteConfigPayload(envID, nodeID string, currentSeq, revision int64, privKey ed25519.PrivateKey) *RouteConfigPayload {
	payload := &RouteConfigPayload{
		EnvironmentID:   envID,
		NodeID:          nodeID,
		CurrentSeq:      currentSeq,
		RoutingRevision: revision,
		ExpiresAt:       time.Now().Add(1 * time.Hour).Unix(),
		Routes: []RouteTarget{{
			Hostname:      "custom.example.com",
			Service:       "web",
			ContainerPort: 3000,
			HostPort:      35000,
		}},
	}
	sig, _ := SignRouteConfigPayload(payload, privKey)
	payload.Signature = sig
	return payload
}

func TestVerifier_ValidRouteConfigSignature(t *testing.T) {
	pub, priv := generateTestKeys(t)
	verifier, err := NewVerifier(base64.StdEncoding.EncodeToString(pub))
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	payload := makeTestRouteConfigPayload("env-1", "node-1", 7, 2, priv)
	if err := verifier.VerifyRouteConfig(payload, "env-1", "node-1", 7, 1); err != nil {
		t.Fatalf("expected valid route config, got: %v", err)
	}
}

func TestVerifier_RejectsRouteConfigReplaySeqMismatchAndMutation(t *testing.T) {
	pub, priv := generateTestKeys(t)
	verifier, err := NewVerifier(base64.StdEncoding.EncodeToString(pub))
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	replay := makeTestRouteConfigPayload("env-1", "node-1", 7, 2, priv)
	if err := verifier.VerifyRouteConfig(replay, "env-1", "node-1", 7, 2); err == nil || !strings.Contains(err.Error(), "routing revision replay") {
		t.Fatalf("expected routing revision replay rejection, got: %v", err)
	}

	seqMismatch := makeTestRouteConfigPayload("env-1", "node-1", 7, 3, priv)
	if err := verifier.VerifyRouteConfig(seqMismatch, "env-1", "node-1", 8, 2); err == nil || !strings.Contains(err.Error(), "current sequence mismatch") {
		t.Fatalf("expected current sequence mismatch rejection, got: %v", err)
	}

	mutated := makeTestRouteConfigPayload("env-1", "node-1", 7, 4, priv)
	mutated.Routes[0].HostPort = 35001
	if err := verifier.VerifyRouteConfig(mutated, "env-1", "node-1", 7, 3); err == nil || !strings.Contains(err.Error(), "signature verification failed") {
		t.Fatalf("expected mutation signature failure, got: %v", err)
	}
}

func TestEngine_ApplyRoutesUpdatesCaddyWithoutCompose(t *testing.T) {
	dir := t.TempDir()
	disk, err := NewDiskState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}
	state := &ReleaseState{
		Seq:             7,
		EnvironmentID:   "env-1",
		NodeID:          "node-1",
		Status:          StatusApplied,
		RoutingRevision: 1,
		RoutingStatus:   "active",
	}
	if err := disk.WriteRelease(state, "services:\n  web:\n    image: nginx\n", "old.example.com {\n\treverse_proxy 127.0.0.1:35000\n}\n"); err != nil {
		t.Fatalf("write release: %v", err)
	}
	if err := disk.SetCurrent(7); err != nil {
		t.Fatalf("set current: %v", err)
	}

	composeLog := filepath.Join(dir, "compose.log")
	composeScript := filepath.Join(dir, "compose.sh")
	if err := os.WriteFile(composeScript, []byte("#!/bin/sh\necho \"$@\" >> \""+composeLog+"\"\nexit 99\n"), 0755); err != nil {
		t.Fatalf("write compose script: %v", err)
	}
	reloadLog := filepath.Join(dir, "reload.log")
	reloadScript := filepath.Join(dir, "reload.sh")
	if err := os.WriteFile(reloadScript, []byte("#!/bin/sh\necho \"$@\" >> \""+reloadLog+"\"\nexit 0\n"), 0755); err != nil {
		t.Fatalf("write reload script: %v", err)
	}

	pub, priv := generateTestKeys(t)
	verifier, err := NewVerifier(base64.StdEncoding.EncodeToString(pub))
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	activeCaddyfile := filepath.Join(dir, "active", "Caddyfile")
	engine := NewEngine(disk, verifier, EngineConfig{
		EnvironmentID:  "env-1",
		NodeID:         "node-1",
		ComposeCmd:     composeScript,
		CaddyfilePath:  activeCaddyfile,
		CaddyReloadCmd: reloadScript + " {config}",
	})

	payload := makeTestRouteConfigPayload("env-1", "node-1", 7, 2, priv)
	payload.Routes = []RouteTarget{{
		Hostname:      "custom.example.com",
		Service:       "web",
		ContainerPort: 3000,
		HostPort:      35000,
	}, {
		Hostname:      "route.apps.example.com",
		Service:       "web",
		ContainerPort: 3000,
		HostPort:      35000,
	}}
	sig, err := SignRouteConfigPayload(payload, priv)
	if err != nil {
		t.Fatalf("SignRouteConfigPayload: %v", err)
	}
	payload.Signature = sig

	if err := engine.ApplyRoutes(context.Background(), payload); err != nil {
		t.Fatalf("ApplyRoutes: %v", err)
	}

	currentSeq, err := disk.CurrentSeq()
	if err != nil {
		t.Fatalf("CurrentSeq: %v", err)
	}
	if currentSeq != 7 {
		t.Fatalf("route-only apply must not change current seq, got %d", currentSeq)
	}
	updated, err := disk.CurrentState()
	if err != nil {
		t.Fatalf("CurrentState: %v", err)
	}
	if updated.RoutingRevision != 2 || updated.RoutingStatus != "active" || updated.RoutingError != "" {
		t.Fatalf("unexpected routing metadata: revision=%d status=%q error=%q", updated.RoutingRevision, updated.RoutingStatus, updated.RoutingError)
	}
	if updated.Status != StatusApplied {
		t.Fatalf("route-only apply must not change release status, got %s", updated.Status)
	}

	snippetBytes, err := os.ReadFile(filepath.Join(filepath.Dir(activeCaddyfile), "sites", "env-1.caddy"))
	if err != nil {
		t.Fatalf("read active Caddy snippet: %v", err)
	}
	snippet := string(snippetBytes)
	if !strings.Contains(snippet, "custom.example.com") || !strings.Contains(snippet, "route.apps.example.com") {
		t.Fatalf("active Caddy snippet missing route-only hostnames:\n%s", snippet)
	}
	if strings.Contains(snippet, "old.example.com") {
		t.Fatalf("active Caddy snippet kept stale hostname:\n%s", snippet)
	}
	reloadBytes, err := os.ReadFile(reloadLog)
	if err != nil {
		t.Fatalf("reload command was not invoked: %v", err)
	}
	if !strings.Contains(string(reloadBytes), activeCaddyfile) {
		t.Fatalf("reload command did not receive active Caddyfile path: %q", string(reloadBytes))
	}
	if _, err := os.Stat(composeLog); !os.IsNotExist(err) {
		t.Fatalf("route-only apply must not invoke compose, stat err=%v", err)
	}

	observed := engine.GetObserved()
	if observed.AppliedSeq != 7 || observed.RoutingRevision != 2 || observed.RoutingStatus != "active" {
		t.Fatalf("unexpected observed routing state: %+v", observed)
	}
}

func TestEngine_ApplyRoutesRejectsNoCurrentRelease(t *testing.T) {
	dir := t.TempDir()
	disk, err := NewDiskState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}
	pub, priv := generateTestKeys(t)
	verifier, err := NewVerifier(base64.StdEncoding.EncodeToString(pub))
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	engine := NewEngine(disk, verifier, EngineConfig{EnvironmentID: "env-1", NodeID: "node-1"})
	payload := makeTestRouteConfigPayload("env-1", "node-1", 7, 2, priv)

	err = engine.ApplyRoutes(context.Background(), payload)
	if err == nil || !strings.Contains(err.Error(), "no current release for route config") {
		t.Fatalf("expected no-current-release rejection, got: %v", err)
	}
}

func TestEngine_ApplyRoutesPersistsRoutingFailureWhenReloadFails(t *testing.T) {
	dir := t.TempDir()
	disk, err := NewDiskState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}
	state := &ReleaseState{
		Seq:             4,
		EnvironmentID:   "env-1",
		NodeID:          "node-1",
		Status:          StatusApplied,
		RoutingRevision: 1,
		RoutingStatus:   "active",
	}
	if err := disk.WriteRelease(state, "services:\n  web:\n    image: nginx\n", "old caddy"); err != nil {
		t.Fatalf("write release: %v", err)
	}
	if err := disk.SetCurrent(4); err != nil {
		t.Fatalf("set current: %v", err)
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
		EnvironmentID:  "env-1",
		NodeID:         "node-1",
		CaddyfilePath:  filepath.Join(dir, "active", "Caddyfile"),
		CaddyReloadCmd: reloadScript,
	})
	payload := makeTestRouteConfigPayload("env-1", "node-1", 4, 2, priv)

	err = engine.ApplyRoutes(context.Background(), payload)
	if err == nil || !strings.Contains(err.Error(), "reload Caddy route config") {
		t.Fatalf("expected reload failure, got: %v", err)
	}
	updated, err := disk.CurrentState()
	if err != nil {
		t.Fatalf("CurrentState: %v", err)
	}
	if updated.RoutingRevision != 1 || updated.RoutingStatus != "failed" || updated.RoutingError == "" {
		t.Fatalf("unexpected persisted routing failure: revision=%d status=%q error=%q", updated.RoutingRevision, updated.RoutingStatus, updated.RoutingError)
	}
	observed := engine.GetObserved()
	if observed.RoutingRevision != 1 || observed.RoutingStatus != "failed" || observed.RoutingError == "" {
		t.Fatalf("unexpected observed routing failure: %+v", observed)
	}
}

func TestEngine_ApplyRoutesRejectsReplayBeforeReload(t *testing.T) {
	dir := t.TempDir()
	disk, err := NewDiskState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}
	state := &ReleaseState{Seq: 5, EnvironmentID: "env-1", NodeID: "node-1", Status: StatusApplied, RoutingRevision: 2, RoutingStatus: "active"}
	if err := disk.WriteRelease(state, "services:\n  web:\n    image: nginx\n", "old caddy"); err != nil {
		t.Fatalf("write release: %v", err)
	}
	if err := disk.SetCurrent(5); err != nil {
		t.Fatalf("set current: %v", err)
	}
	reloadLog := filepath.Join(dir, "reload.log")
	reloadScript := filepath.Join(dir, "reload.sh")
	if err := os.WriteFile(reloadScript, []byte("#!/bin/sh\necho reload >> \""+reloadLog+"\"\nexit 0\n"), 0755); err != nil {
		t.Fatalf("write reload script: %v", err)
	}
	pub, priv := generateTestKeys(t)
	verifier, err := NewVerifier(base64.StdEncoding.EncodeToString(pub))
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	engine := NewEngine(disk, verifier, EngineConfig{
		EnvironmentID:  "env-1",
		NodeID:         "node-1",
		CaddyfilePath:  filepath.Join(dir, "active", "Caddyfile"),
		CaddyReloadCmd: reloadScript,
	})
	payload := makeTestRouteConfigPayload("env-1", "node-1", 5, 2, priv)

	err = engine.ApplyRoutes(context.Background(), payload)
	if err == nil || !strings.Contains(err.Error(), "routing revision replay") {
		t.Fatalf("expected replay rejection, got: %v", err)
	}
	if _, err := os.Stat(reloadLog); !os.IsNotExist(err) {
		t.Fatalf("replayed route config must not invoke reload, stat err=%v", err)
	}
}
