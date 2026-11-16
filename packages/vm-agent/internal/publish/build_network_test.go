package publish

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRemoteBuildNetworkPreservesResolvedOverridesAndUserFiles(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "docker")
	// The fake receiver enforces the real Compose argument boundary and copies
	// temporary config while it exists, before the helper cleans up.
	script := `#!/bin/sh
if [ "$2" = "config" ]; then
  printf 'name: fixture\nservices:\n  web:\n    image: fixture\n    build:\n      context: .\n      args:\n        OVERRIDE: present\n'
  exit 0
fi
if [ "$2" != "--project-directory" ] || [ "$4" != "-f" ] || [ "$6" != "-f" ] || [ "$8" != "build" ]; then exit 91; fi
cp "$5" "$3/captured.yaml"
cp "$7" "$3/network.yaml"
`
	if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	original := []byte("original compose override")
	if err := os.WriteFile(filepath.Join(dir, "compose.override.yaml"), original, 0600); err != nil {
		t.Fatal(err)
	}
	cfg := &composeConfig{Services: map[string]composeConfigService{"web": {Build: json.RawMessage(`{"context":"."}`)}, "db": {Image: "postgres"}}}
	beforeExecution := ExecutionCounters()
	if _, err := buildComposeServices(context.Background(), "docker compose", BuildOptions{WorkspaceDir: dir, BuildNetwork: "host"}, cfg, nil); err != nil {
		t.Fatal(err)
	}
	if ExecutionCounters().ComposeBuildAttempts != beforeExecution.ComposeBuildAttempts+1 {
		t.Fatal("host-network build attempt not observed")
	}
	base, err := os.ReadFile(filepath.Join(dir, "captured.yaml"))
	if err != nil || !strings.Contains(string(base), "OVERRIDE: present") {
		t.Fatalf("override lost %s %v", base, err)
	}
	network, err := os.ReadFile(filepath.Join(dir, "network.yaml"))
	if err != nil || !strings.Contains(string(network), "network: host") || strings.Contains(string(network), "db:") {
		t.Fatalf("network override %s %v", network, err)
	}
	unchanged, err := os.ReadFile(filepath.Join(dir, "compose.override.yaml"))
	if err != nil || string(unchanged) != string(original) {
		t.Fatal("source compose was modified")
	}
}

func TestRemoteBuildConfigInterpolatesBeforePathResolution(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "docker")
	script := `#!/bin/sh
if [ "$2" = "config" ]; then
 [ "$#" = 2 ] || exit 92
 [ "$SUBDIR" = "services/api" ] || exit 93
 printf 'services:\n  web:\n    build:\n      context: /resolved/services\n'
 exit 0
fi
[ "$8" = build ] || exit 94
cp "$5" "$3/captured.yaml"
`
	if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	cfg := &composeConfig{Services: map[string]composeConfigService{"web": {Build: json.RawMessage(`{"context":"${SUBDIR}/.."}`)}}}
	if _, err := buildComposeServices(context.Background(), "docker compose", BuildOptions{WorkspaceDir: dir, BuildNetwork: "host"}, cfg, map[string]string{"SUBDIR": "services/api"}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "captured.yaml"))
	if err != nil || !strings.Contains(string(data), "/resolved/services") {
		t.Fatalf("resolved build context %q, %v", data, err)
	}
}

// Compose's interpolation/path normalization cannot be represented by a shell
// fixture. This exercises the real config command without a daemon or image.
func TestRemoteBuildRealComposeInterpolatesContextBeforeDotDot(t *testing.T) {
	docker, err := exec.LookPath("docker")
	if err != nil {
		t.Skip("Docker Compose unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err = exec.CommandContext(ctx, docker, "compose", "version").Run(); err != nil {
		t.Skip("Docker Compose plugin unavailable")
	}
	dir := t.TempDir()
	if err = os.MkdirAll(filepath.Join(dir, "services/api"), 0755); err != nil {
		t.Fatal(err)
	}
	compose := []byte("services:\n  web:\n    image: fixture\n    build:\n      context: ${SUBDIR}/..\n    environment:\n      RUNTIME_SECRET: ${RUNTIME_SECRET}\n")
	if err = os.WriteFile(filepath.Join(dir, "compose.yaml"), compose, 0600); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(dir, "compose-shim")
	script := `#!/bin/sh
if [ "$2" = config ]; then exec "$REAL_COMPOSE_DOCKER" "$@"; fi
[ "$8" = build ] || exit 94
cp "$5" "$3/captured.yaml"
cp "$7" "$3/network.yaml"
`
	if err = os.WriteFile(shim, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REAL_COMPOSE_DOCKER", docker)
	cfg := &composeConfig{Services: map[string]composeConfigService{"web": {Build: json.RawMessage(`{"context":"."}`)}}}
	env := buildComposeCommandEnv(map[string]string{"SUBDIR": "services/api"}, []string{"RUNTIME_SECRET"})
	if _, err = buildComposeServices(ctx, shim+" compose", BuildOptions{WorkspaceDir: dir, BuildNetwork: "host"}, cfg, env); err != nil {
		t.Fatal(err)
	}
	base, err := os.ReadFile(filepath.Join(dir, "captured.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(base), "context: "+filepath.Join(dir, "services")) {
		t.Fatalf("build context normalized before interpolation: %s", base)
	}
	if !strings.Contains(string(base), secretInterpolationPlaceholder) {
		t.Fatalf("missing harmless runtime placeholder: %s", base)
	}
	release, err := runCompose(ctx, docker+" compose", dir, nil, "config", "--no-interpolate")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(release), "${RUNTIME_SECRET}") || strings.Contains(string(release), secretInterpolationPlaceholder) || strings.Contains(string(release), "network: host") {
		t.Fatalf("release runtime references changed: %s", release)
	}
}
