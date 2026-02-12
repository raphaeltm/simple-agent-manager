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
	} {
		if !strings.Contains(content, needle) {
			t.Fatalf("expected %q in %s", needle, path)
		}
	}
}
