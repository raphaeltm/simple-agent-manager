package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceRoutingSourceContract(t *testing.T) {
	path := filepath.Join("workspace_routing.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	for _, needle := range []string{
		"X-SAM-Node-Id",
		"X-SAM-Workspace-Id",
		"requireWorkspaceRequestAuth",
		"workspace route mismatch",
	} {
		if !strings.Contains(content, needle) {
			t.Fatalf("expected %q in %s", needle, path)
		}
	}
}
