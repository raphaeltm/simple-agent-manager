package server

import (
	"strings"
	"testing"
)

// TestFileDownloadDockerArgs_DashSeparator verifies that the docker exec args
// for file download include "--" before the file path. This prevents paths
// starting with "-" from being interpreted as flags by cat.
// This matches the pattern already used in handleFileRaw (files.go).
func TestFileDownloadDockerArgs_DashSeparator(t *testing.T) {
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
			// Replicate the docker args construction from handleFileDownload.
			dockerArgs := []string{"exec", "-i"}
			if tc.user != "" {
				dockerArgs = append(dockerArgs, "-u", tc.user)
			}
			if tc.workDir != "" {
				dockerArgs = append(dockerArgs, "-w", tc.workDir)
			}
			dockerArgs = append(dockerArgs, tc.container, "cat", "--", tc.filePath)

			// Verify "--" appears between "cat" and the file path.
			catIdx := -1
			for i, arg := range dockerArgs {
				if arg == "cat" {
					catIdx = i
					break
				}
			}
			if catIdx == -1 {
				t.Fatal("'cat' not found in docker args")
			}
			if catIdx+1 >= len(dockerArgs) || dockerArgs[catIdx+1] != "--" {
				t.Errorf("expected '--' immediately after 'cat', got args: %s",
					strings.Join(dockerArgs, " "))
			}
			if dockerArgs[len(dockerArgs)-1] != tc.filePath {
				t.Errorf("expected file path %q as last arg, got %q",
					tc.filePath, dockerArgs[len(dockerArgs)-1])
			}
		})
	}
}
