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

func newTestRouteDiskState(t *testing.T, dir string) *DiskState {
	t.Helper()
	disk, err := NewDiskState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}
	return disk
}

func testAppliedRouteState(seq, routingRevision int64) *ReleaseState {
	return &ReleaseState{
		Seq:             seq,
		EnvironmentID:   "env-1",
		NodeID:          "node-1",
		Status:          StatusApplied,
		RoutingRevision: routingRevision,
		RoutingStatus:   "active",
	}
}

func newTestRouteEngine(disk *DiskState, verifier *Verifier, caddyfilePath, reloadCmd, composeCmd string) *Engine {
	return NewEngine(disk, verifier, EngineConfig{
		EnvironmentID:  "env-1",
		NodeID:         "node-1",
		ComposeCmd:     composeCmd,
		CaddyfilePath:  caddyfilePath,
		CaddyReloadCmd: reloadCmd,
	})
}

func newTestRouteVerifier(t *testing.T) (*Verifier, ed25519.PrivateKey) {
	t.Helper()
	pub, priv := generateTestKeys(t)
	verifier, err := NewVerifier(base64.StdEncoding.EncodeToString(pub))
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	return verifier, priv
}

func writeTestRelease(t *testing.T, disk *DiskState, state *ReleaseState, composeYAML, caddyfile string) {
	t.Helper()
	if err := disk.WriteRelease(state, composeYAML, caddyfile); err != nil {
		t.Fatalf("write release: %v", err)
	}
	if err := disk.SetCurrent(state.Seq); err != nil {
		t.Fatalf("set current: %v", err)
	}
}

func writeTestScript(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0755); err != nil {
		t.Fatalf("write script %s: %v", path, err)
	}
}

func signTestRouteConfig(t *testing.T, payload *RouteConfigPayload, priv ed25519.PrivateKey) {
	t.Helper()
	sig, err := SignRouteConfigPayload(payload, priv)
	if err != nil {
		t.Fatalf("SignRouteConfigPayload: %v", err)
	}
	payload.Signature = sig
}

func testRouteTargets() []RouteTarget {
	return []RouteTarget{{
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
}

func assertRouteOnlyReleaseState(t *testing.T, disk *DiskState) {
	t.Helper()
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
	if updated.RoutingRevision != 2 {
		t.Fatalf("unexpected routing revision: %d", updated.RoutingRevision)
	}
	if updated.RoutingStatus != "active" {
		t.Fatalf("unexpected routing status: %q", updated.RoutingStatus)
	}
	if updated.RoutingError != "" {
		t.Fatalf("unexpected routing error: %q", updated.RoutingError)
	}
	if updated.Status != StatusApplied {
		t.Fatalf("route-only apply must not change release status, got %s", updated.Status)
	}
}

func assertActiveRoutesSnippet(t *testing.T, activeCaddyfile string) {
	t.Helper()
	snippetBytes, err := os.ReadFile(filepath.Join(filepath.Dir(activeCaddyfile), "sites", "env-1.caddy"))
	if err != nil {
		t.Fatalf("read active Caddy snippet: %v", err)
	}
	snippet := string(snippetBytes)
	if !strings.Contains(snippet, "custom.example.com") {
		t.Fatalf("active Caddy snippet missing custom domain:\n%s", snippet)
	}
	if !strings.Contains(snippet, "route.apps.example.com") {
		t.Fatalf("active Caddy snippet missing app route:\n%s", snippet)
	}
	if strings.Contains(snippet, "old.example.com") {
		t.Fatalf("active Caddy snippet kept stale hostname:\n%s", snippet)
	}
}

func assertReloadWithoutCompose(t *testing.T, reloadLog, activeCaddyfile, composeLog string) {
	t.Helper()
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
}

func assertObservedRoutingActive(t *testing.T, engine *Engine) {
	t.Helper()
	observed := engine.GetObserved()
	if observed.AppliedSeq != 7 {
		t.Fatalf("unexpected observed seq: %+v", observed)
	}
	if observed.RoutingRevision != 2 {
		t.Fatalf("unexpected observed routing revision: %+v", observed)
	}
	if observed.RoutingStatus != "active" {
		t.Fatalf("unexpected observed routing status: %+v", observed)
	}
}

func TestVerifier_ValidRouteConfigSignature(t *testing.T) {
	verifier, priv := newTestRouteVerifier(t)

	payload := makeTestRouteConfigPayload("env-1", "node-1", 7, 2, priv)
	if err := verifier.VerifyRouteConfig(payload, "env-1", "node-1", 7, 1); err != nil {
		t.Fatalf("expected valid route config, got: %v", err)
	}
}

func TestVerifier_RejectsRouteConfigReplaySeqMismatchAndMutation(t *testing.T) {
	verifier, priv := newTestRouteVerifier(t)

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
	disk := newTestRouteDiskState(t, dir)
	writeTestRelease(t, disk, testAppliedRouteState(7, 1), "services:\n  web:\n    image: nginx\n", "old.example.com {\n\treverse_proxy 127.0.0.1:35000\n}\n")

	composeLog := filepath.Join(dir, "compose.log")
	composeScript := filepath.Join(dir, "compose.sh")
	writeTestScript(t, composeScript, "#!/bin/sh\necho \"$@\" >> \""+composeLog+"\"\nexit 99\n")
	reloadLog := filepath.Join(dir, "reload.log")
	reloadScript := filepath.Join(dir, "reload.sh")
	writeTestScript(t, reloadScript, "#!/bin/sh\necho \"$@\" >> \""+reloadLog+"\"\nexit 0\n")

	verifier, priv := newTestRouteVerifier(t)
	activeCaddyfile := filepath.Join(dir, "active", "Caddyfile")
	engine := newTestRouteEngine(disk, verifier, activeCaddyfile, reloadScript+" {config}", composeScript)

	payload := makeTestRouteConfigPayload("env-1", "node-1", 7, 2, priv)
	payload.Routes = testRouteTargets()
	signTestRouteConfig(t, payload, priv)

	if err := engine.ApplyRoutes(context.Background(), payload); err != nil {
		t.Fatalf("ApplyRoutes: %v", err)
	}

	assertRouteOnlyReleaseState(t, disk)
	assertActiveRoutesSnippet(t, activeCaddyfile)
	assertReloadWithoutCompose(t, reloadLog, activeCaddyfile, composeLog)
	assertObservedRoutingActive(t, engine)
}

func TestEngine_ApplyRoutesRejectsNoCurrentRelease(t *testing.T) {
	dir := t.TempDir()
	disk := newTestRouteDiskState(t, dir)
	verifier, priv := newTestRouteVerifier(t)
	engine := NewEngine(disk, verifier, EngineConfig{EnvironmentID: "env-1", NodeID: "node-1"})
	payload := makeTestRouteConfigPayload("env-1", "node-1", 7, 2, priv)

	err := engine.ApplyRoutes(context.Background(), payload)
	if err == nil || !strings.Contains(err.Error(), "no current release for route config") {
		t.Fatalf("expected no-current-release rejection, got: %v", err)
	}
}

func TestEngine_ApplyRoutesPersistsRoutingFailureWhenReloadFails(t *testing.T) {
	dir := t.TempDir()
	disk := newTestRouteDiskState(t, dir)
	writeTestRelease(t, disk, testAppliedRouteState(4, 1), "services:\n  web:\n    image: nginx\n", "old caddy")

	reloadScript := filepath.Join(dir, "reload.sh")
	writeTestScript(t, reloadScript, "#!/bin/sh\necho reload failed >&2\nexit 42\n")
	verifier, priv := newTestRouteVerifier(t)
	engine := newTestRouteEngine(disk, verifier, filepath.Join(dir, "active", "Caddyfile"), reloadScript, "")
	payload := makeTestRouteConfigPayload("env-1", "node-1", 4, 2, priv)

	err := engine.ApplyRoutes(context.Background(), payload)
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
	disk := newTestRouteDiskState(t, dir)
	writeTestRelease(t, disk, testAppliedRouteState(5, 2), "services:\n  web:\n    image: nginx\n", "old caddy")
	reloadLog := filepath.Join(dir, "reload.log")
	reloadScript := filepath.Join(dir, "reload.sh")
	writeTestScript(t, reloadScript, "#!/bin/sh\necho reload >> \""+reloadLog+"\"\nexit 0\n")
	verifier, priv := newTestRouteVerifier(t)
	engine := newTestRouteEngine(disk, verifier, filepath.Join(dir, "active", "Caddyfile"), reloadScript, "")
	payload := makeTestRouteConfigPayload("env-1", "node-1", 5, 2, priv)

	err := engine.ApplyRoutes(context.Background(), payload)
	if err == nil || !strings.Contains(err.Error(), "routing revision replay") {
		t.Fatalf("expected replay rejection, got: %v", err)
	}
	if _, err := os.Stat(reloadLog); !os.IsNotExist(err) {
		t.Fatalf("replayed route config must not invoke reload, stat err=%v", err)
	}
}
