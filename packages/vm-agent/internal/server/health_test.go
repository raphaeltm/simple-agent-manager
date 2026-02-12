package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHealthSourceContract(t *testing.T) {
	path := filepath.Join("health.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	for _, needle := range []string{
		"sendNodeReady",
		"sendNodeHeartbeat",
		"/api/nodes/",
		"/ready",
		"/heartbeat",
		"activeWorkspaceCount",
		"activeWorkspaces",
		"nodeId",
	} {
		if !strings.Contains(content, needle) {
			t.Fatalf("expected %q in %s", needle, path)
		}
	}
}
