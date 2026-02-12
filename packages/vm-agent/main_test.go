package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMainShutdownSourceContract(t *testing.T) {
	path := filepath.Join("main.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	for _, needle := range []string{
		"Received signal",
		"StopAllWorkspacesAndSessions()",
		"srv.Stop(ctx)",
	} {
		if !strings.Contains(content, needle) {
			t.Fatalf("expected %q in %s", needle, path)
		}
	}
}
