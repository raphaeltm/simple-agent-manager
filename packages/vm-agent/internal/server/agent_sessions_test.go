package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentSessionsSourceContract(t *testing.T) {
	path := filepath.Join("workspaces.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	for _, needle := range []string{
		"handleListAgentSessions",
		"handleCreateAgentSession",
		"handleStopAgentSession",
		"Idempotency-Key",
	} {
		if !strings.Contains(content, needle) {
			t.Fatalf("expected %q in %s", needle, path)
		}
	}
}
