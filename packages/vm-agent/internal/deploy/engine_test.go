package deploy

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/cache"
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

func TestEngine_ApplyLoadsArtifactsAndSkipsComposePull(t *testing.T) {
	dir := t.TempDir()
	disk, err := NewDiskState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}

	archives := map[string][]byte{
		"/web.tar":    []byte("web docker archive bytes"),
		"/worker.tar": []byte("worker docker archive bytes"),
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		archive, ok := archives[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(archive)
	}))
	defer server.Close()

	cmdLog := filepath.Join(dir, "cmd.log")
	cmdScript := filepath.Join(dir, "docker.sh")
	if err := os.WriteFile(cmdScript, []byte(`#!/bin/sh
echo "$@" >> "`+cmdLog+`"
case "$*" in
  *" ps --format json"*) echo '{"Name":"web","Service":"web","State":"running","Health":"healthy"}' ;;
esac
exit 0
`), 0755); err != nil {
		t.Fatalf("write command script: %v", err)
	}

	reloadScript := filepath.Join(dir, "reload.sh")
	if err := os.WriteFile(reloadScript, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
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
		ComposeCmd:         cmdScript,
		CaddyfilePath:      filepath.Join(dir, "active", "Caddyfile"),
		CaddyReloadCmd:     reloadScript + " {config}",
		HealthTimeout:      1 * time.Second,
		HealthPollInterval: 10 * time.Millisecond,
	})

	payload := &ApplyPayload{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		Seq:           1,
		ExpiresAt:     time.Now().Add(1 * time.Hour).Unix(),
		ComposeYAML:   "services:\n  web:\n    image: sam-env-1-web:release\n    pull_policy: never\n  worker:\n    image: sam-env-1-worker:release\n    pull_policy: never\n",
		Routes: []RouteTarget{{
			Hostname:      "r1-web-env.apps.example.com",
			Service:       "web",
			ContainerPort: 3000,
			HostPort:      35000,
		}},
		Artifacts: []ImageArtifact{{
			ServiceName:       "web",
			SourceRef:         "workspace-web",
			LocalImageRef:     "sam-env-1-web:release",
			R2Key:             "compose-image-artifacts/proj/env/ws/upload/web.tar",
			SizeBytes:         int64(len(archives["/web.tar"])),
			ArchiveSHA256:     shaForBytes(archives["/web.tar"]),
			ArchiveType:       "docker-save",
			MediaType:         "application/vnd.docker.image.rootfs.diff.tar",
			DownloadURL:       server.URL + "/web.tar",
			DownloadExpiresIn: 900,
		}, {
			ServiceName:       "worker",
			SourceRef:         "workspace-worker",
			LocalImageRef:     "sam-env-1-worker:release",
			R2Key:             "compose-image-artifacts/proj/env/ws/upload/worker.tar",
			SizeBytes:         int64(len(archives["/worker.tar"])),
			ArchiveSHA256:     shaForBytes(archives["/worker.tar"]),
			ArchiveType:       "docker-save",
			MediaType:         "application/vnd.docker.image.rootfs.diff.tar",
			DownloadURL:       server.URL + "/worker.tar",
			DownloadExpiresIn: 900,
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

	logBytes, err := os.ReadFile(cmdLog)
	if err != nil {
		t.Fatalf("read command log: %v", err)
	}
	log := string(logBytes)
	for _, expected := range []string{"load -i", "tag workspace-web sam-env-1-web:release", "tag workspace-worker sam-env-1-worker:release", "config -q", "up -d --remove-orphans"} {
		if !strings.Contains(log, expected) {
			t.Fatalf("command log missing %q: %s", expected, log)
		}
	}
	if got := strings.Count(log, "load -i"); got != 2 {
		t.Fatalf("expected two artifact loads, got %d: %s", got, log)
	}
	if strings.Contains(log, " pull") {
		t.Fatalf("compose pull should be skipped for artifact-backed payload: %s", log)
	}
}

func TestEngine_DownloadArtifactAllowsSlowProgressingBody(t *testing.T) {
	dir := t.TempDir()
	disk, _ := NewDiskState(filepath.Join(dir, "state"))
	chunks := [][]byte{
		[]byte(strings.Repeat("a", 1024)),
		[]byte(strings.Repeat("b", 1024)),
		[]byte(strings.Repeat("c", 1024)),
		[]byte(strings.Repeat("d", 1024)),
	}
	var archive []byte
	for _, chunk := range chunks {
		archive = append(archive, chunk...)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		flusher, _ := w.(http.Flusher)
		for _, chunk := range chunks {
			_, _ = w.Write(chunk)
			if flusher != nil {
				flusher.Flush()
			}
			time.Sleep(20 * time.Millisecond)
		}
	}))
	defer server.Close()

	engine := NewEngine(disk, nil, EngineConfig{
		EnvironmentID:       "env-1",
		NodeID:              "node-1",
		HTTPClient:          NewArtifactHTTPClient(ArtifactHTTPClientConfig{}),
		ArtifactIdleTimeout: 200 * time.Millisecond,
	})
	path := filepath.Join(dir, "archive.tar")
	err := engine.downloadArtifact(context.Background(), ImageArtifact{
		ServiceName:   "web",
		SourceRef:     "workspace-web",
		LocalImageRef: "sam-env-1-web:release",
		R2Key:         "compose-image-artifacts/proj/env/ws/upload/web.tar",
		SizeBytes:     int64(len(archive)),
		ArchiveSHA256: shaForBytes(archive),
		ArchiveType:   "docker-save",
		DownloadURL:   server.URL,
	}, path)
	if err != nil {
		t.Fatalf("downloadArtifact should allow slow progress: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read downloaded artifact: %v", err)
	}
	if string(got) != string(archive) {
		t.Fatalf("downloaded archive mismatch")
	}
}

func TestEngine_DownloadArtifactCancelsStalledBody(t *testing.T) {
	dir := t.TempDir()
	disk, _ := NewDiskState(filepath.Join(dir, "state"))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		flusher, _ := w.(http.Flusher)
		_, _ = w.Write([]byte("partial"))
		if flusher != nil {
			flusher.Flush()
		}
		time.Sleep(200 * time.Millisecond)
		_, _ = w.Write([]byte(" after stall"))
	}))
	defer server.Close()

	engine := NewEngine(disk, nil, EngineConfig{
		EnvironmentID:       "env-1",
		NodeID:              "node-1",
		HTTPClient:          NewArtifactHTTPClient(ArtifactHTTPClientConfig{}),
		ArtifactIdleTimeout: 50 * time.Millisecond,
	})
	err := engine.downloadArtifact(context.Background(), ImageArtifact{
		ServiceName:   "web",
		SourceRef:     "workspace-web",
		LocalImageRef: "sam-env-1-web:release",
		R2Key:         "compose-image-artifacts/proj/env/ws/upload/web.tar",
		SizeBytes:     int64(len("partial after stall")),
		ArchiveSHA256: shaForBytes([]byte("partial after stall")),
		ArchiveType:   "docker-save",
		DownloadURL:   server.URL,
	}, filepath.Join(dir, "archive.tar"))
	if err == nil || !strings.Contains(err.Error(), "download stalled") {
		t.Fatalf("expected stalled download error, got: %v", err)
	}
}

func TestEngine_ApplyRejectsArtifactHashMismatch(t *testing.T) {
	dir := t.TempDir()
	disk, _ := NewDiskState(filepath.Join(dir, "state"))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("actual archive"))
	}))
	defer server.Close()
	cmdScript := filepath.Join(dir, "docker.sh")
	if err := os.WriteFile(cmdScript, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
		t.Fatalf("write command script: %v", err)
	}
	pub, priv := generateTestKeys(t)
	verifier, _ := NewVerifier(base64.StdEncoding.EncodeToString(pub))
	engine := NewEngine(disk, verifier, EngineConfig{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		ComposeCmd:    cmdScript,
	})
	payload := &ApplyPayload{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		Seq:           1,
		ExpiresAt:     time.Now().Add(1 * time.Hour).Unix(),
		ComposeYAML:   "services:\n  web:\n    image: sam-env-1-web:release\n",
		Artifacts: []ImageArtifact{{
			ServiceName:       "web",
			SourceRef:         "workspace-web",
			LocalImageRef:     "sam-env-1-web:release",
			R2Key:             "compose-image-artifacts/proj/env/ws/upload/web.tar",
			SizeBytes:         int64(len("actual archive")),
			ArchiveSHA256:     shaForBytes([]byte("different archive")),
			ArchiveType:       "docker-save",
			MediaType:         "application/vnd.docker.image.rootfs.diff.tar",
			DownloadURL:       server.URL,
			DownloadExpiresIn: 900,
		}},
	}
	payload.Signature, _ = SignPayload(payload, priv)
	err := engine.Apply(context.Background(), payload)
	if err == nil || !strings.Contains(err.Error(), "sha256 mismatch") {
		t.Fatalf("expected hash mismatch failure, got: %v", err)
	}
}

func TestEngine_DownloadArtifactRejectsSizeMismatch(t *testing.T) {
	dir := t.TempDir()
	disk, _ := NewDiskState(filepath.Join(dir, "state"))
	archive := []byte("archive bytes plus extra")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(archive)
	}))
	defer server.Close()

	engine := NewEngine(disk, nil, EngineConfig{
		EnvironmentID:       "env-1",
		NodeID:              "node-1",
		ArtifactIdleTimeout: time.Second,
	})
	err := engine.downloadArtifact(context.Background(), ImageArtifact{
		ServiceName:   "web",
		SourceRef:     "workspace-web",
		LocalImageRef: "sam-env-1-web:release",
		R2Key:         "compose-image-artifacts/proj/env/ws/upload/web.tar",
		SizeBytes:     int64(len(archive) - 1),
		ArchiveSHA256: shaForBytes(archive),
		ArchiveType:   "docker-save",
		DownloadURL:   server.URL,
	}, filepath.Join(dir, "archive.tar"))
	if err == nil || !strings.Contains(err.Error(), "size mismatch") {
		t.Fatalf("expected size mismatch, got: %v", err)
	}
}

func TestEngine_ApplyRejectsTamperedArtifactSignature(t *testing.T) {
	dir := t.TempDir()
	disk, _ := NewDiskState(filepath.Join(dir, "state"))
	pub, priv := generateTestKeys(t)
	verifier, _ := NewVerifier(base64.StdEncoding.EncodeToString(pub))
	engine := NewEngine(disk, verifier, EngineConfig{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		ComposeCmd:    "true",
	})
	payload := &ApplyPayload{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		Seq:           1,
		ExpiresAt:     time.Now().Add(1 * time.Hour).Unix(),
		ComposeYAML:   "services:\n  web:\n    image: sam-env-1-web:release\n",
		Artifacts: []ImageArtifact{{
			ServiceName:   "web",
			SourceRef:     "workspace-web",
			LocalImageRef: "sam-env-1-web:release",
			R2Key:         "compose-image-artifacts/proj/env/ws/upload/web.tar",
			SizeBytes:     12,
			ArchiveSHA256: shaForBytes([]byte("signed bytes")),
			ArchiveType:   "docker-save",
			DownloadURL:   "https://example.invalid/signed",
		}},
	}
	payload.Signature, _ = SignPayload(payload, priv)
	payload.Artifacts[0].ArchiveSHA256 = shaForBytes([]byte("tampered bytes"))
	err := engine.Apply(context.Background(), payload)
	if err == nil || !strings.Contains(err.Error(), "signature verification failed") {
		t.Fatalf("expected signature failure for tampered artifact metadata, got: %v", err)
	}
}

func shaForBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return "sha256:" + hex.EncodeToString(sum[:])
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
	if err == nil || !strings.Contains(err.Error(), "compose config") {
		t.Fatalf("expected signed payload to proceed to compose config preflight, got: %v", err)
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
	if !strings.Contains(active, "import sites/*") {
		t.Fatalf("active Caddyfile missing sites import:\n%s", active)
	}
	snippetBytes, err := os.ReadFile(filepath.Join(filepath.Dir(activeCaddyfile), "sites", "env-1.caddy"))
	if err != nil {
		t.Fatalf("read active Caddy snippet: %v", err)
	}
	snippet := string(snippetBytes)
	if !strings.Contains(snippet, "r1-web-env.apps.example.com") {
		t.Fatalf("active Caddy snippet missing hostname:\n%s", snippet)
	}
	if !strings.Contains(snippet, "reverse_proxy 127.0.0.1:35000") {
		t.Fatalf("active Caddy snippet missing upstream:\n%s", snippet)
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

func TestEngine_ApplyWaitsForRoutedServicesOnly(t *testing.T) {
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
  *" ps --format json"*)
    echo '{"Name":"sam-env-env-1-web-1","Service":"web","State":"running","Health":"healthy"}'
    echo '{"Name":"sam-env-env-1-worker-1","Service":"worker","State":"exited","Health":""}'
    ;;
esac
exit 0
`), 0755); err != nil {
		t.Fatalf("write compose script: %v", err)
	}

	reloadScript := filepath.Join(dir, "reload.sh")
	if err := os.WriteFile(reloadScript, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
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

	payload := makeTestPayload("env-1", "node-1", 1, "services:\n  web:\n    image: nginx\n  worker:\n    image: busybox\n    command: echo done\n", priv)
	payload.Routes = []RouteTarget{{
		Hostname:      "app.example.com",
		Service:       "web",
		ContainerPort: 3000,
		HostPort:      35000,
	}}
	sig, err := SignPayload(payload, priv)
	if err != nil {
		t.Fatalf("SignPayload: %v", err)
	}
	payload.Signature = sig

	if err := engine.Apply(context.Background(), payload); err != nil {
		t.Fatalf("Apply should ignore exited non-routed worker, got: %v", err)
	}

	observed := engine.GetObserved()
	if observed.Status != StatusApplied {
		t.Fatalf("expected observed status=applied, got %s", observed.Status)
	}
	if observed.AppliedSeq != 1 {
		t.Fatalf("expected applied seq 1, got %d", observed.AppliedSeq)
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
	snippetPath := filepath.Join(dir, "active", "sites", "env-1.caddy")
	if _, err := os.Stat(snippetPath); !os.IsNotExist(err) {
		t.Fatalf("failed initial release must remove active Caddy snippet, stat err=%v", err)
	}
}

// TestEngine_RedeployPortRebind verifies that Apply() tears down the previous
// release's containers before starting the new release, preventing host-port
// collisions when consecutive compose projects bind the same port.
func TestEngine_RedeployPortRebind(t *testing.T) {
	type testCase struct {
		name           string
		currentSeq     int64 // 0 = first release
		newSeq         int64
		failComposeUp  bool // make composeUp of newSeq fail
		wantDownBefore bool // expect composeDown(currentSeq) before pull/up(newSeq)
		wantRevertUp   bool // expect composeUp(currentSeq) on rollback
	}

	tests := []testCase{
		{
			name:           "first release skips composeDown",
			currentSeq:     0,
			newSeq:         1,
			failComposeUp:  false,
			wantDownBefore: false,
			wantRevertUp:   false,
		},
		{
			name:           "happy redeploy tears down old before upping new",
			currentSeq:     1,
			newSeq:         2,
			failComposeUp:  false,
			wantDownBefore: true,
			wantRevertUp:   false,
		},
		{
			name:           "no overlap window: down-old strictly precedes up-new",
			currentSeq:     3,
			newSeq:         4,
			failComposeUp:  false,
			wantDownBefore: true,
			wantRevertUp:   false,
		},
		{
			name:           "rollback re-ups previous after failed composeUp",
			currentSeq:     1,
			newSeq:         2,
			failComposeUp:  true,
			wantDownBefore: true,
			wantRevertUp:   true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			disk, err := NewDiskState(filepath.Join(dir, "state"))
			if err != nil {
				t.Fatalf("NewDiskState: %v", err)
			}

			// Set up previous release on disk if currentSeq > 0
			if tc.currentSeq > 0 {
				prevState := &ReleaseState{
					Seq:           tc.currentSeq,
					EnvironmentID: "env-1",
					NodeID:        "node-1",
					Status:        StatusApplied,
				}
				if err := disk.WriteRelease(prevState, "services:\n  web:\n    image: nginx\n", "prev caddyfile"); err != nil {
					t.Fatalf("write previous release: %v", err)
				}
				if err := disk.SetCurrent(tc.currentSeq); err != nil {
					t.Fatalf("set current: %v", err)
				}
			}

			// Build a compose script that logs each invocation and optionally fails compose up for newSeq
			composeLog := filepath.Join(dir, "compose.log")
			newComposeFile := disk.ComposeFilePath(tc.newSeq)
			prevComposeFile := ""
			if tc.currentSeq > 0 {
				prevComposeFile = disk.ComposeFilePath(tc.currentSeq)
			}

			// The script logs "CMD <file> <args>" per invocation.
			// It fails `up` for the new release's compose file if failComposeUp is set.
			failClause := ""
			if tc.failComposeUp {
				failClause = fmt.Sprintf(`
# Fail compose up for the new release file
case "$*" in
  *"-f %s"*" up "*)
    echo "CMD $*" >> "%s"
    echo "port already in use" >&2
    exit 1
    ;;
esac
`, newComposeFile, composeLog)
			}

			composeScript := filepath.Join(dir, "compose.sh")
			scriptContent := fmt.Sprintf(`#!/bin/sh
%s
echo "CMD $*" >> "%s"
case "$*" in
  *" ps --format json"*) echo '{"Name":"web","State":"running","Health":"healthy"}' ;;
esac
exit 0
`, failClause, composeLog)

			if err := os.WriteFile(composeScript, []byte(scriptContent), 0755); err != nil {
				t.Fatalf("write compose script: %v", err)
			}

			reloadScript := filepath.Join(dir, "reload.sh")
			if err := os.WriteFile(reloadScript, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
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

			payload := makeTestPayload("env-1", "node-1", tc.newSeq, "services:\n  web:\n    image: nginx:latest\n", priv)
			payload.Routes = []RouteTarget{{
				Hostname:      "app.example.com",
				Service:       "web",
				ContainerPort: 3000,
				HostPort:      35000,
			}}
			// Re-sign with routes
			sig, err := SignPayload(payload, priv)
			if err != nil {
				t.Fatalf("SignPayload: %v", err)
			}
			payload.Signature = sig

			applyErr := engine.Apply(context.Background(), payload)

			// Read the compose command log
			logBytes, err := os.ReadFile(composeLog)
			if err != nil {
				t.Fatalf("read compose log: %v", err)
			}
			logLines := strings.Split(strings.TrimSpace(string(logBytes)), "\n")

			if tc.failComposeUp {
				if applyErr == nil {
					t.Fatal("expected apply to fail when composeUp fails")
				}
			} else {
				if applyErr != nil {
					t.Fatalf("expected apply to succeed, got: %v", applyErr)
				}
			}

			// Parse command log into ordered operations
			type op struct {
				action string // "down", "pull", "up", "ps"
				file   string // compose file path
			}
			var ops []op
			for _, line := range logLines {
				if !strings.HasPrefix(line, "CMD ") {
					continue
				}
				args := line[4:]
				var action string
				switch {
				case strings.Contains(args, " down"):
					action = "down"
				case strings.Contains(args, " pull"):
					action = "pull"
				case strings.Contains(args, " up "):
					action = "up"
				case strings.Contains(args, " ps "):
					action = "ps"
				default:
					continue
				}

				// Extract compose file from -f <path>
				var file string
				parts := strings.Fields(args)
				for i, p := range parts {
					if p == "-f" && i+1 < len(parts) {
						file = parts[i+1]
						break
					}
				}
				ops = append(ops, op{action: action, file: file})
			}

			// Verify: composeDown of previous release occurs (or not) and ordering
			if tc.wantDownBefore {
				// Find the "down" for the previous compose file
				downIdx := -1
				for i, o := range ops {
					if o.action == "down" && o.file == prevComposeFile {
						downIdx = i
						break
					}
				}
				if downIdx == -1 {
					t.Fatalf("expected composeDown for previous release (file=%s) but not found in log:\n%s",
						prevComposeFile, string(logBytes))
				}

				// Find the first "pull" or "up" for the new compose file
				pullUpIdx := -1
				for i, o := range ops {
					if (o.action == "pull" || o.action == "up") && o.file == newComposeFile {
						pullUpIdx = i
						break
					}
				}
				if pullUpIdx == -1 {
					t.Fatalf("expected composePull/Up for new release but not found in log:\n%s", string(logBytes))
				}

				if downIdx >= pullUpIdx {
					t.Fatalf("composeDown(prev) at index %d must precede composePull/Up(new) at index %d:\n%s",
						downIdx, pullUpIdx, string(logBytes))
				}
			} else {
				// First release: no composeDown should be called before pull/up
				for _, o := range ops {
					if o.action == "down" && (prevComposeFile == "" || o.file == prevComposeFile) {
						// For first release (currentSeq=0), there should be no down for a previous file.
						// A down for the NEW file is OK (handleApplyFailure cleanup).
						if o.file != newComposeFile {
							t.Fatalf("unexpected composeDown for non-new file %s in first release:\n%s",
								o.file, string(logBytes))
						}
					}
				}
			}

			// Verify rollback re-ups the previous release
			if tc.wantRevertUp {
				revertFound := false
				for _, o := range ops {
					if o.action == "up" && o.file == prevComposeFile {
						revertFound = true
						break
					}
				}
				if !revertFound {
					t.Fatalf("expected rollback composeUp for previous release (file=%s) but not found:\n%s",
						prevComposeFile, string(logBytes))
				}

				// Verify the reverted state
				currentSeq, err := disk.CurrentSeq()
				if err != nil {
					t.Fatalf("CurrentSeq: %v", err)
				}
				if currentSeq != tc.currentSeq {
					t.Fatalf("expected current seq to revert to %d, got %d", tc.currentSeq, currentSeq)
				}

				observed := engine.GetObserved()
				if observed.Status != StatusReverted {
					t.Fatalf("expected observed status=reverted, got %s", observed.Status)
				}
				if !strings.Contains(observed.ErrorMessage, "compose up") {
					t.Fatalf("expected observed revert error to include apply failure, got %q", observed.ErrorMessage)
				}
			}
		})
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

// TestEngine_RegistryLogin_CalledBeforePull verifies that when RegistryCredentials
// are present, docker login is invoked BEFORE composePull, and that the password
// is never passed as an argv argument (it uses --password-stdin).
func TestEngine_RegistryLogin_CalledBeforePull(t *testing.T) {
	dir := t.TempDir()
	disk, err := NewDiskState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}

	composeLog := filepath.Join(dir, "compose.log")
	composeScript := filepath.Join(dir, "compose.sh")
	if err := os.WriteFile(composeScript, []byte(`#!/bin/sh
echo "CMD $*" >> "`+composeLog+`"
case "$*" in
  *" ps --format json"*) echo '{"Name":"web","State":"running","Health":"healthy"}' ;;
esac
exit 0
`), 0755); err != nil {
		t.Fatalf("write compose script: %v", err)
	}

	reloadScript := filepath.Join(dir, "reload.sh")
	if err := os.WriteFile(reloadScript, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
		t.Fatalf("write reload script: %v", err)
	}

	// Track docker login calls
	type loginCall struct {
		registry string
		username string
		password string
	}
	var loginCalls []loginCall

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
		DockerLogin: func(_ context.Context, registry, username, password string) error {
			loginCalls = append(loginCalls, loginCall{registry, username, password})
			// Write a marker so we can verify ordering vs compose commands
			f, _ := os.OpenFile(composeLog, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0644)
			defer f.Close()
			fmt.Fprintf(f, "CMD docker-login %s %s\n", registry, username)
			return nil
		},
	})

	payload := makeTestPayload("env-1", "node-1", 1, "services:\n  web:\n    image: registry.cloudflare.com/acct/sam-proj:v1\n", priv)
	payload.RegistryCredentials = &RegistryCredentials{
		Server:   "registry.cloudflare.com",
		Username: "cf-user",
		Password: "super-secret-password",
	}
	// Re-sign (makeTestPayload already signed but without RegistryCredentials in struct — that's fine since creds aren't in the signature)

	if err := engine.Apply(context.Background(), payload); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	// Verify docker login was called exactly once with correct args
	if len(loginCalls) != 1 {
		t.Fatalf("expected exactly 1 docker login call, got %d", len(loginCalls))
	}
	if loginCalls[0].registry != "registry.cloudflare.com" {
		t.Errorf("expected registry=registry.cloudflare.com, got %s", loginCalls[0].registry)
	}
	if loginCalls[0].username != "cf-user" {
		t.Errorf("expected username=cf-user, got %s", loginCalls[0].username)
	}
	if loginCalls[0].password != "super-secret-password" {
		t.Errorf("expected password=super-secret-password, got %s", loginCalls[0].password)
	}

	// Verify ordering: docker-login must appear before pull in the log
	logBytes, err := os.ReadFile(composeLog)
	if err != nil {
		t.Fatalf("read compose log: %v", err)
	}
	logContent := string(logBytes)
	loginIdx := strings.Index(logContent, "docker-login")
	pullIdx := strings.Index(logContent, "pull")
	if loginIdx == -1 {
		t.Fatal("docker-login not found in compose log")
	}
	if pullIdx == -1 {
		t.Fatal("pull not found in compose log")
	}
	if loginIdx >= pullIdx {
		t.Fatalf("docker login (at %d) must precede compose pull (at %d) in log:\n%s",
			loginIdx, pullIdx, logContent)
	}
}

func TestMatchedServiceUsesExplicitServiceOrExactNameOnly(t *testing.T) {
	required := map[string]bool{"api": true}

	if got, ok := matchedService(ServiceState{Name: "sam-env-worker-api-1", Service: "worker"}, required); ok {
		t.Fatalf("matchedService fuzzy-matched container name substring as %q", got)
	}

	if got, ok := matchedService(ServiceState{Name: "sam-env-api-1", Service: "api"}, required); !ok || got != "api" {
		t.Fatalf("matchedService explicit Service match = %q/%v, want api/true", got, ok)
	}

	if got, ok := matchedService(ServiceState{Name: "api", Service: ""}, required); !ok || got != "api" {
		t.Fatalf("matchedService exact Name match = %q/%v, want api/true", got, ok)
	}
}

func TestWaitForHealthSkipsContainerPollingWhenNoRoutes(t *testing.T) {
	dir := t.TempDir()
	disk, _ := NewDiskState(dir)
	engine := NewEngine(disk, nil, EngineConfig{
		EnvironmentID:      "env-1",
		NodeID:             "node-1",
		ComposeCmd:         filepath.Join(dir, "missing-compose"),
		HealthTimeout:      time.Second,
		HealthPollInterval: time.Millisecond,
	})

	if err := engine.waitForHealth(context.Background(), 1, nil, nil); err != nil {
		t.Fatalf("waitForHealth with no routes = %v, want nil", err)
	}
}

// TestEngine_RegistryLogin_SkippedWhenNil verifies that when RegistryCredentials
// are nil, docker login is NOT called (public images work without login).
func TestEngine_RegistryLogin_SkippedWhenNil(t *testing.T) {
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
	if err := os.WriteFile(reloadScript, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
		t.Fatalf("write reload script: %v", err)
	}

	loginCalled := false

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
		DockerLogin: func(_ context.Context, _, _, _ string) error {
			loginCalled = true
			return nil
		},
	})

	// No RegistryCredentials (nil by default from makeTestPayload)
	payload := makeTestPayload("env-1", "node-1", 1, "services:\n  web:\n    image: nginx:latest\n", priv)
	payload.Routes = []RouteTarget{{
		Hostname: "app.example.com", Service: "web", ContainerPort: 3000, HostPort: 35000,
	}}
	sig, _ := SignPayload(payload, priv)
	payload.Signature = sig

	if err := engine.Apply(context.Background(), payload); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	if loginCalled {
		t.Fatal("docker login should NOT be called when RegistryCredentials is nil")
	}
}

// TestEngine_RegistryLogin_FailureTriggersRevert verifies that a failed docker
// login triggers the apply failure handler (revert or failed-initial).
func TestEngine_RegistryLogin_FailureTriggersRevert(t *testing.T) {
	dir := t.TempDir()
	disk, err := NewDiskState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}

	composeScript := filepath.Join(dir, "compose.sh")
	if err := os.WriteFile(composeScript, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
		t.Fatalf("write compose script: %v", err)
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
		CaddyReloadCmd:     "true",
		HealthTimeout:      1 * time.Second,
		HealthPollInterval: 10 * time.Millisecond,
		DockerLogin: func(_ context.Context, _, _, _ string) error {
			return fmt.Errorf("401 unauthorized: bad credentials")
		},
	})

	payload := makeTestPayload("env-1", "node-1", 1, "services:\n  web:\n    image: private:v1\n", priv)
	payload.RegistryCredentials = &RegistryCredentials{
		Server:   "registry.example.com",
		Username: "user",
		Password: "bad-pass",
	}

	err = engine.Apply(context.Background(), payload)
	if err == nil {
		t.Fatal("expected apply to fail when docker login fails")
	}
	if !strings.Contains(err.Error(), "docker login") {
		t.Fatalf("expected 'docker login' in error, got: %v", err)
	}

	observed := engine.GetObserved()
	if observed.Status != StatusFailedInitial {
		t.Fatalf("expected observed status=failed-initial, got %s", observed.Status)
	}
}

// TestDockerLogin_PasswordNotInArgv verifies that the production
// cache.DockerLogin uses --password-stdin and never passes the password as a
// command-line argument. It exercises the real function (not a facsimile) by
// overriding PATH so the registry login resolves to a fake docker binary that
// records its argv.
func TestDockerLogin_PasswordNotInArgv(t *testing.T) {
	dir := t.TempDir()
	dockerScript := filepath.Join(dir, "docker")
	argvLog := filepath.Join(dir, "argv.log")
	// The fake docker reads stdin (so --password-stdin doesn't hang) and logs
	// only its argv, never the piped password.
	if err := os.WriteFile(dockerScript, []byte(`#!/bin/sh
cat > /dev/null
echo "$@" >> "`+argvLog+`"
exit 0
`), 0755); err != nil {
		t.Fatalf("write docker script: %v", err)
	}

	// Prepend our fake docker to PATH so cache.DockerLogin resolves to it.
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))

	const secret = "super-secret-value-12345"
	if err := cache.DockerLogin(context.Background(), "registry.example.com", "test-user", secret); err != nil {
		t.Fatalf("cache.DockerLogin: %v", err)
	}

	argv, err := os.ReadFile(argvLog)
	if err != nil {
		t.Fatalf("read argv log: %v", err)
	}
	argvStr := string(argv)

	// Password must NOT appear in argv.
	if strings.Contains(argvStr, secret) {
		t.Fatalf("password leaked to argv: %s", argvStr)
	}
	// --password-stdin must appear.
	if !strings.Contains(argvStr, "--password-stdin") {
		t.Fatalf("--password-stdin not found in argv: %s", argvStr)
	}
}

// TestEngine_CallbackTokenRotation_ThreadSafe is a regression test for the data
// race where the heartbeat goroutine rotates the callback token via
// SetCallbackToken while the apply goroutine reads it inside fetchRelease.
// Run with -race; it must not report a race and the request must carry whatever
// token was current at read time.
func TestEngine_CallbackTokenRotation_ThreadSafe(t *testing.T) {
	var gotAuth atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth.Store(r.Header.Get("Authorization"))
		// Minimal payload shape so fetchRelease decodes without error.
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"environmentId":"env-1","nodeId":"node-1","seq":1,"expiresAt":4102444800,"composeYaml":"","routes":[],"signature":""}`)
	}))
	defer srv.Close()

	dir := t.TempDir()
	disk, _ := NewDiskState(dir)
	engine := NewEngine(disk, nil, EngineConfig{
		EnvironmentID:   "env-1",
		NodeID:          "node-1",
		ControlPlaneURL: srv.URL,
		CallbackToken:   "initial-token",
		HTTPClient:      srv.Client(),
	})

	var wg sync.WaitGroup
	// Writer: rotate the token repeatedly (heartbeat goroutine).
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 50; i++ {
			engine.SetCallbackToken(fmt.Sprintf("token-%d", i))
		}
	}()
	// Readers: fetch releases concurrently (apply goroutine).
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = engine.fetchRelease(context.Background(), 1)
		}()
	}
	wg.Wait()

	if auth, _ := gotAuth.Load().(string); !strings.HasPrefix(auth, "Bearer ") {
		t.Errorf("expected a Bearer token to be sent, got %q", auth)
	}
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

// TestEngine_ApplyFailureRedactsSecretsInReportedStatus is the security crux of
// the Compose interpolation feature: when an apply fails on a node whose compose
// command emits a secret interpolation value to stderr, that secret must NEVER
// appear in the error message persisted to disk state OR reported to the control
// plane via ObservedState.ErrorMessage. The control plane surfaces this status
// to the user, so a leak here would expose decrypted secrets in the UI.
//
// This is a vertical-slice test: it drives the real Engine.Apply through the real
// composeUp -> runCompose -> newEnvRedactor path with a compose command that
// leaks a secret, and asserts on the durable + reported failure status.
func TestEngine_ApplyFailureRedactsSecretsInReportedStatus(t *testing.T) {
	const secret = "supersecretvalue123" // len >= 6 so the redactor collects it

	dir := t.TempDir()
	disk, err := NewDiskState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}

	// config and pull succeed; `up` fails and prints the secret to stderr,
	// exactly as a real `docker compose up` would when interpolation injects a
	// secret into an image reference or build arg that then fails to pull.
	composeScript := filepath.Join(dir, "compose.sh")
	if err := os.WriteFile(composeScript, []byte(`#!/bin/sh
case "$*" in
  *"up -d"*)
    echo "compose up failed: cannot pull image registry/app with token `+secret+`" >&2
    exit 7
    ;;
esac
exit 0
`), 0755); err != nil {
		t.Fatalf("write compose script: %v", err)
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
		CaddyReloadCmd:     "/bin/true",
		HealthTimeout:      1 * time.Second,
		HealthPollInterval: 10 * time.Millisecond,
	})

	payload := &ApplyPayload{
		EnvironmentID:    "env-1",
		NodeID:           "node-1",
		Seq:              1,
		ExpiresAt:        time.Now().Add(1 * time.Hour).Unix(),
		ComposeYAML:      "services:\n  web:\n    image: nginx\n",
		InterpolationEnv: map[string]string{"SAM_SECRET_TOKEN": secret},
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
		t.Fatal("expected apply to fail when compose up fails")
	}
	// The error returned to the caller must also be scrubbed.
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("returned error leaked the secret: %v", err)
	}

	// Durable failure state must not contain the secret.
	state, err := disk.ReadState(1)
	if err != nil {
		t.Fatalf("ReadState: %v", err)
	}
	if state.Status != StatusFailedInitial {
		t.Fatalf("expected failed-initial state, got %s", state.Status)
	}
	if strings.Contains(state.ErrorMessage, secret) {
		t.Fatalf("persisted state.ErrorMessage leaked the secret: %q", state.ErrorMessage)
	}
	if !strings.Contains(state.ErrorMessage, "[REDACTED]") {
		t.Fatalf("expected [REDACTED] marker in persisted error, got %q", state.ErrorMessage)
	}

	// Status reported to the control plane via heartbeat must not contain the secret.
	observed := engine.GetObserved()
	if observed.Status != StatusFailedInitial {
		t.Fatalf("expected observed failed-initial status, got %s", observed.Status)
	}
	if strings.Contains(observed.ErrorMessage, secret) {
		t.Fatalf("reported ObservedState.ErrorMessage leaked the secret: %q", observed.ErrorMessage)
	}
	if !strings.Contains(observed.ErrorMessage, "[REDACTED]") {
		t.Fatalf("expected [REDACTED] marker in reported error, got %q", observed.ErrorMessage)
	}
}

func TestEngine_HealthTimeoutReportsFailedServicesInObservedState(t *testing.T) {
	const secret = "supersecretvalue123"

	dir := t.TempDir()
	disk, err := NewDiskState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}

	composeStatePath := filepath.Join(dir, "compose-state")
	composeScript := filepath.Join(dir, "compose.sh")
	if err := os.WriteFile(composeScript, []byte(`#!/bin/sh
case "$*" in
  *" down"*)
    echo cleaned > "`+composeStatePath+`"
    ;;
  *" ps --format json"*)
    if [ -f "`+composeStatePath+`" ]; then
      exit 0
    fi
    echo '{"Name":"web-1","Service":"web","State":"running","Health":"healthy"}'
    echo '{"Name":"`+secret+`-api-1","Service":"api","State":"running","Health":"starting"}'
    ;;
esac
exit 0
`), 0755); err != nil {
		t.Fatalf("write compose script: %v", err)
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
		CaddyReloadCmd:     "/bin/true",
		HealthTimeout:      30 * time.Millisecond,
		HealthPollInterval: 5 * time.Millisecond,
	})

	payload := &ApplyPayload{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		Seq:           1,
		ExpiresAt:     time.Now().Add(1 * time.Hour).Unix(),
		ComposeYAML:   "services:\n  web:\n    image: nginx\n  api:\n    image: nginx\n",
		InterpolationEnv: map[string]string{
			"SAM_SECRET_TOKEN": secret,
		},
		Routes: []RouteTarget{
			{Hostname: "web.example.com", Service: "web", ContainerPort: 3000, HostPort: 35000},
			{Hostname: "api.example.com", Service: "api", ContainerPort: 3000, HostPort: 35001},
		},
	}
	sig, err := SignPayload(payload, priv)
	if err != nil {
		t.Fatalf("SignPayload: %v", err)
	}
	payload.Signature = sig

	err = engine.Apply(context.Background(), payload)
	if err == nil {
		t.Fatal("expected apply to fail on health timeout")
	}

	observed := engine.GetObserved()
	if observed.Status != StatusFailedInitial {
		t.Fatalf("expected observed failed-initial status, got %s", observed.Status)
	}
	if !strings.Contains(observed.ErrorMessage, "unhealthy routed services: api (state=running health=starting)") {
		t.Fatalf("expected observed error to name unhealthy routed service, got %q", observed.ErrorMessage)
	}
	if len(observed.Services) != 2 {
		t.Fatalf("expected final service snapshot in observed state, got %#v", observed.Services)
	}
	if observed.Services[1].Service != "api" || observed.Services[1].Name != "[REDACTED]-api-1" || observed.Services[1].Status != "running" || observed.Services[1].Health != "starting" {
		t.Fatalf("expected api starting service snapshot, got %#v", observed.Services[1])
	}
	if strings.Contains(fmt.Sprintf("%#v", observed.Services), secret) {
		t.Fatalf("observed service snapshot leaked secret after cleanup: %#v", observed.Services)
	}
}
