package deploy

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeMountChecker allows tests to control which paths are "mountpoints".
type fakeMountChecker struct {
	mountpoints map[string]bool // path → true if mountpoint, false if exists-but-not-mounted
	missing     map[string]bool // path → true if path does not exist at all
}

func newFakeMountChecker() *fakeMountChecker {
	return &fakeMountChecker{
		mountpoints: make(map[string]bool),
		missing:     make(map[string]bool),
	}
}

func (f *fakeMountChecker) IsMountpoint(path string) (bool, error) {
	if f.missing[path] {
		return false, fmt.Errorf("stat %s: no such file or directory", path)
	}
	mounted, ok := f.mountpoints[path]
	if !ok {
		// Default: path exists but is not a mountpoint (fell-through empty dir)
		return false, nil
	}
	return mounted, nil
}

// ---------------------------------------------------------------------------
// extractSAMVolumeMountRoots tests
// ---------------------------------------------------------------------------

func TestExtractSAMVolumeMountRoots_NoVolumes(t *testing.T) {
	yaml := `services:
  web:
    image: nginx:latest
    ports:
      - "127.0.0.1:35000:3000"
`
	roots, err := extractSAMVolumeMountRoots(yaml)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(roots) != 0 {
		t.Fatalf("expected no roots, got %v", roots)
	}
}

func TestExtractSAMVolumeMountRoots_WithSAMVolumes(t *testing.T) {
	yaml := `services:
  web:
    image: myapp:v1
    volumes:
      - /mnt/sam-env-env-abc123/volumes/data:/app/data
      - /mnt/sam-env-env-abc123/volumes/uploads:/app/uploads
  db:
    image: postgres:16
    volumes:
      - /mnt/sam-env-env-abc123/volumes/pgdata:/var/lib/postgresql/data
`
	roots, err := extractSAMVolumeMountRoots(yaml)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(roots) != 1 {
		t.Fatalf("expected 1 unique root, got %d: %v", len(roots), roots)
	}
	if roots[0] != "/mnt/sam-env-env-abc123" {
		t.Fatalf("expected /mnt/sam-env-env-abc123, got %s", roots[0])
	}
}

func TestExtractSAMVolumeMountRoots_MultipleEnvironments(t *testing.T) {
	// Edge case: a compose file with volumes from two different environments
	// (unlikely in practice but the guard should handle it)
	yaml := `services:
  app:
    image: myapp:v1
    volumes:
      - /mnt/sam-env-env-aaa/volumes/data:/app/data
      - /mnt/sam-env-env-bbb/volumes/state:/app/state
`
	roots, err := extractSAMVolumeMountRoots(yaml)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(roots) != 2 {
		t.Fatalf("expected 2 roots, got %d: %v", len(roots), roots)
	}
}

func TestExtractSAMVolumeMountRoots_IgnoresNonSAMVolumes(t *testing.T) {
	yaml := `services:
  web:
    image: myapp:v1
    volumes:
      - ./config:/app/config
      - /var/log/app:/app/logs
      - /mnt/sam-env-env-abc123/volumes/data:/app/data
`
	roots, err := extractSAMVolumeMountRoots(yaml)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(roots) != 1 {
		t.Fatalf("expected 1 root (only SAM volume), got %d: %v", len(roots), roots)
	}
}

func TestExtractSAMVolumeMountRoots_InvalidYAML(t *testing.T) {
	// Invalid YAML returns empty roots (not an error) because the guard is
	// lenient — invalid compose will fail at `docker compose up` anyway.
	roots, err := extractSAMVolumeMountRoots("not: [valid: yaml: {{{")
	if err != nil {
		t.Fatalf("expected nil error for invalid YAML, got: %v", err)
	}
	if len(roots) != 0 {
		t.Fatalf("expected empty roots for invalid YAML, got: %v", roots)
	}
}

func TestExtractSAMVolumeMountRoots_PathTraversal_Rejected(t *testing.T) {
	// Defense-in-depth: a compose YAML with path-traversal components in the
	// envId position must be silently skipped to prevent os.Stat on
	// attacker-controlled paths.
	yaml := `services:
  evil:
    volumes:
      - /mnt/sam-env-../etc/shadow:/x
      - /mnt/sam-env-.:/y
      - /mnt/sam-env-legitimate/volumes/data:/data`
	roots, err := extractSAMVolumeMountRoots(yaml)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Only the legitimate path should survive
	if len(roots) != 1 {
		t.Fatalf("expected 1 root (only legitimate), got %d: %v", len(roots), roots)
	}
	if roots[0] != "/mnt/sam-env-legitimate" {
		t.Fatalf("expected /mnt/sam-env-legitimate, got %s", roots[0])
	}
}

// ---------------------------------------------------------------------------
// verifyVolumeMounts tests
// ---------------------------------------------------------------------------

func TestVerifyVolumeMounts_NoVolumes_Passes(t *testing.T) {
	yaml := `services:
  web:
    image: nginx:latest
`
	checker := newFakeMountChecker()
	if err := verifyVolumeMounts(yaml, checker); err != nil {
		t.Fatalf("expected no error for compose without volumes, got: %v", err)
	}
}

func TestVerifyVolumeMounts_AllMounted_Passes(t *testing.T) {
	yaml := `services:
  web:
    image: myapp:v1
    volumes:
      - /mnt/sam-env-env-abc123/volumes/data:/app/data
      - /mnt/sam-env-env-abc123/volumes/uploads:/app/uploads
`
	checker := newFakeMountChecker()
	checker.mountpoints["/mnt/sam-env-env-abc123"] = true

	if err := verifyVolumeMounts(yaml, checker); err != nil {
		t.Fatalf("expected no error when volume is mounted, got: %v", err)
	}
}

func TestVerifyVolumeMounts_VolumeNotMounted_Refuses(t *testing.T) {
	yaml := `services:
  web:
    image: myapp:v1
    volumes:
      - /mnt/sam-env-env-abc123/volumes/data:/app/data
`
	checker := newFakeMountChecker()
	// Path exists but is NOT a mountpoint (fell-through empty dir)
	checker.mountpoints["/mnt/sam-env-env-abc123"] = false

	err := verifyVolumeMounts(yaml, checker)
	if err == nil {
		t.Fatal("expected error when volume is not a mountpoint")
	}
	if !strings.Contains(err.Error(), "volume mount guard") {
		t.Fatalf("expected 'volume mount guard' in error, got: %v", err)
	}
	if !strings.Contains(err.Error(), "refusing to apply") {
		t.Fatalf("expected 'refusing to apply' in error, got: %v", err)
	}
	if !strings.Contains(err.Error(), "not a mountpoint") {
		t.Fatalf("expected 'not a mountpoint' in error, got: %v", err)
	}
}

func TestVerifyVolumeMounts_LongFormSAMVolumeNotMounted_Refuses(t *testing.T) {
	yaml := `services:
  db:
    image: postgres:16
    volumes:
      - type: bind
        source: /mnt/sam-env-env-abc123/volumes/postgres-data
        target: /var/lib/postgresql/data
      - type: volume
        source: postgres-cache
        target: /cache
`
	checker := newFakeMountChecker()
	checker.mountpoints["/mnt/sam-env-env-abc123"] = false

	err := verifyVolumeMounts(yaml, checker)
	if err == nil {
		t.Fatal("expected long-form SAM volume to run the mount guard and refuse")
	}
	if !strings.Contains(err.Error(), "/mnt/sam-env-env-abc123") {
		t.Fatalf("expected error to mention the SAM mount root, got: %v", err)
	}
	if !strings.Contains(err.Error(), "not a mountpoint") {
		t.Fatalf("expected 'not a mountpoint' in error, got: %v", err)
	}
}

func TestVerifyVolumeMounts_VolumeMissing_Refuses(t *testing.T) {
	yaml := `services:
  db:
    image: postgres:16
    volumes:
      - /mnt/sam-env-env-abc123/volumes/pgdata:/var/lib/postgresql/data
`
	checker := newFakeMountChecker()
	checker.missing["/mnt/sam-env-env-abc123"] = true

	err := verifyVolumeMounts(yaml, checker)
	if err == nil {
		t.Fatal("expected error when volume path does not exist")
	}
	if !strings.Contains(err.Error(), "volume mount guard") {
		t.Fatalf("expected 'volume mount guard' in error, got: %v", err)
	}
	if !strings.Contains(err.Error(), "no such file") {
		t.Fatalf("expected 'no such file' in error, got: %v", err)
	}
}

func TestVerifyVolumeMounts_MultipleVolumes_OneMissing_Refuses(t *testing.T) {
	yaml := `services:
  app:
    image: myapp:v1
    volumes:
      - /mnt/sam-env-env-aaa/volumes/data:/app/data
      - /mnt/sam-env-env-bbb/volumes/state:/app/state
`
	checker := newFakeMountChecker()
	checker.mountpoints["/mnt/sam-env-env-aaa"] = true
	checker.missing["/mnt/sam-env-env-bbb"] = true

	err := verifyVolumeMounts(yaml, checker)
	if err == nil {
		t.Fatal("expected error when one of two volumes is missing")
	}
	if !strings.Contains(err.Error(), "env-bbb") {
		t.Fatalf("expected error to mention the missing volume, got: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Engine integration: mount guard wired into Apply
// ---------------------------------------------------------------------------

// guardEngine builds an Engine wired with the given mount checker and fresh
// signing keys for the volume-mount-guard integration tests. When healthy is
// true, the compose script reports a healthy `ps --format json` container;
// otherwise it is a no-op that exits 0.
func guardEngine(t *testing.T, checker MountChecker, healthy bool) (*Engine, ed25519.PrivateKey) {
	t.Helper()
	dir := t.TempDir()
	disk, err := NewDiskState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}

	composeBody := "#!/bin/sh\nexit 0\n"
	if healthy {
		composeBody = `#!/bin/sh
case "$*" in
  *" ps --format json"*) echo '{"Name":"web","State":"running","Health":"healthy"}' ;;
esac
exit 0
`
	}
	composeScript := filepath.Join(dir, "compose.sh")
	if err := os.WriteFile(composeScript, []byte(composeBody), 0755); err != nil {
		t.Fatalf("write compose script: %v", err)
	}

	reloadScript := filepath.Join(dir, "reload.sh")
	if err := os.WriteFile(reloadScript, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
		t.Fatalf("write reload script: %v", err)
	}

	pub, priv := generateTestKeys(t)
	verifier, _ := NewVerifier(base64.StdEncoding.EncodeToString(pub))

	engine := NewEngine(disk, verifier, EngineConfig{
		EnvironmentID:      "env-1",
		NodeID:             "node-1",
		ComposeCmd:         composeScript,
		CaddyfilePath:      filepath.Join(dir, "active", "Caddyfile"),
		CaddyReloadCmd:     reloadScript,
		HealthTimeout:      1 * time.Second,
		HealthPollInterval: 10 * time.Millisecond,
		MountChecker:       checker,
	})
	return engine, priv
}

// guardPayload builds and signs a seq-1 ApplyPayload for the given compose YAML.
func guardPayload(t *testing.T, priv ed25519.PrivateKey, composeYAML string) *ApplyPayload {
	t.Helper()
	payload := &ApplyPayload{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		Seq:           1,
		ExpiresAt:     time.Now().Add(1 * time.Hour).Unix(),
		ComposeYAML:   composeYAML,
		Routes: []RouteTarget{{
			Hostname:      "app.example.com",
			Service:       "web",
			ContainerPort: 3000,
			HostPort:      35000,
		}},
	}
	sig, _ := SignPayload(payload, priv)
	payload.Signature = sig
	return payload
}

const guardVolumeComposeYAML = `services:
  web:
    image: myapp:v1
    volumes:
      - /mnt/sam-env-env-1/volumes/data:/app/data
    ports:
      - "127.0.0.1:35000:3000"
`

func TestEngine_Apply_VolumeMountGuard_Proceeds(t *testing.T) {
	checker := newFakeMountChecker()
	checker.mountpoints["/mnt/sam-env-env-1"] = true

	engine, priv := guardEngine(t, checker, true)
	payload := guardPayload(t, priv, guardVolumeComposeYAML)

	if err := engine.Apply(context.Background(), payload); err != nil {
		t.Fatalf("Apply should succeed when volume is mounted, got: %v", err)
	}

	observed := engine.GetObserved()
	if observed.Status != StatusApplied {
		t.Fatalf("expected status=applied, got %s", observed.Status)
	}
}

func TestEngine_Apply_VolumeMountGuard_Refuses(t *testing.T) {
	checker := newFakeMountChecker()
	// Volume path does NOT exist
	checker.missing["/mnt/sam-env-env-1"] = true

	engine, priv := guardEngine(t, checker, false)
	payload := guardPayload(t, priv, guardVolumeComposeYAML)

	err := engine.Apply(context.Background(), payload)
	if err == nil {
		t.Fatal("Apply should fail when volume is not mounted")
	}
	if !strings.Contains(err.Error(), "volume mount guard") {
		t.Fatalf("expected 'volume mount guard' in error, got: %v", err)
	}

	// Should trigger failure handling (failed-initial since no previous seq)
	observed := engine.GetObserved()
	if observed.Status != StatusFailedInitial {
		t.Fatalf("expected status=failed-initial, got %s", observed.Status)
	}
}

func TestEngine_Apply_VolumeMountGuard_NoVolumes_Skips(t *testing.T) {
	// No SAM volumes in the compose YAML, so the mount check is skipped entirely.
	checker := newFakeMountChecker()

	engine, priv := guardEngine(t, checker, true)

	composeYAML := `services:
  web:
    image: nginx:latest
    ports:
      - "127.0.0.1:35000:3000"
`
	payload := guardPayload(t, priv, composeYAML)

	if err := engine.Apply(context.Background(), payload); err != nil {
		t.Fatalf("Apply should succeed when no SAM volumes are declared, got: %v", err)
	}
}

func TestEngine_Apply_VolumeMountGuard_ExistsButNotMountpoint_Refuses(t *testing.T) {
	checker := newFakeMountChecker()
	// Path exists but is NOT a mountpoint — this is the "fell-through empty dir" case
	checker.mountpoints["/mnt/sam-env-env-1"] = false

	engine, priv := guardEngine(t, checker, false)

	composeYAML := `services:
  web:
    image: myapp:v1
    volumes:
      - /mnt/sam-env-env-1/volumes/data:/app/data
`
	payload := guardPayload(t, priv, composeYAML)

	err := engine.Apply(context.Background(), payload)
	if err == nil {
		t.Fatal("Apply should refuse when volume path exists but is not a mountpoint")
	}
	if !strings.Contains(err.Error(), "not a mountpoint") {
		t.Fatalf("expected 'not a mountpoint' in error, got: %v", err)
	}
}
