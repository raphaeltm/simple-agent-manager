package publish

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	if _, err := runComposeBuild(context.Background(), "docker compose", BuildOptions{WorkspaceDir: dir, BuildNetwork: "host"}, cfg, nil); err != nil {
		t.Fatal(err)
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
