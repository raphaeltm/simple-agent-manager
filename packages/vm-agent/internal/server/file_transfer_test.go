package server

import (
	"context"
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
)

// TestFileDownloadWorkspaceExecArgs_DashSeparator verifies that workspace exec args
// for file download include "--" before the file path. This prevents paths
// starting with "-" from being interpreted as flags by cat.
func TestFileDownloadWorkspaceExecArgs_DashSeparator(t *testing.T) {
	s := &Server{config: &config.Config{}}
	tests := []struct {
		name      string
		user      string
		workDir   string
		container string
		filePath  string
	}{
		{
			name:      "normal path",
			container: "abc123",
			filePath:  "/workspace/README.md",
		},
		{
			name:      "path starting with dash",
			container: "abc123",
			filePath:  "-dangerous-file.txt",
		},
		{
			name:      "path with double dash prefix",
			container: "abc123",
			filePath:  "--version",
		},
		{
			name:      "with user and workdir",
			user:      "node",
			workDir:   "/workspace",
			container: "abc123",
			filePath:  "-file.txt",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cmd, err := s.workspaceExecCommand(context.Background(), tc.container, tc.user, tc.workDir, "cat", "--", tc.filePath)
			if err != nil {
				t.Fatalf("workspaceExecCommand returned error: %v", err)
			}

			// Verify "--" appears between "cat" and the file path.
			catIdx := -1
			for i, arg := range cmd.Args {
				if arg == "cat" {
					catIdx = i
					break
				}
			}
			if catIdx == -1 {
				t.Fatal("'cat' not found in docker args")
			}
			if catIdx+1 >= len(cmd.Args) || cmd.Args[catIdx+1] != "--" {
				t.Errorf("expected '--' immediately after 'cat', got args: %s",
					strings.Join(cmd.Args, " "))
			}
			if cmd.Args[len(cmd.Args)-1] != tc.filePath {
				t.Errorf("expected file path %q as last arg, got %q",
					tc.filePath, cmd.Args[len(cmd.Args)-1])
			}
		})
	}
}
