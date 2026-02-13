package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEventsSourceContract(t *testing.T) {
	path := filepath.Join("events.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	for _, needle := range []string{
		"handleListNodeEvents",
		"handleListWorkspaceEvents",
		"nextCursor",
		"parseEventLimit",
		"requireNodeEventAuth",
	} {
		if !strings.Contains(content, needle) {
			t.Fatalf("expected %q in %s", needle, path)
		}
	}
}

func TestEventsHandlersAcceptBrowserAuth(t *testing.T) {
	path := filepath.Join("events.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	// Workspace events should accept browser workspace auth (same pattern as tabs)
	if !strings.Contains(content, "requireWorkspaceRequestAuth") {
		t.Fatal("workspace events handler must accept workspace request auth for browser direct access")
	}

	// Node events should accept management token via query param
	if !strings.Contains(content, "r.URL.Query().Get(\"token\")") {
		t.Fatal("node events handler must accept token via query parameter for browser direct access")
	}

	// Node events should accept workspace session cookie
	if !strings.Contains(content, "sessionManager.GetSessionFromRequest") {
		t.Fatal("node events handler must accept workspace session cookie for browser direct access")
	}
}
