package tools

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
)

// ReadFile reads file contents with line numbers.
type ReadFile struct {
	// WorkDir is the base working directory. All paths are resolved relative to it.
	WorkDir string
}

func (t *ReadFile) Name() string        { return "read_file" }
func (t *ReadFile) Description() string { return "Read the contents of a file with line numbers." }
func (t *ReadFile) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path": map[string]any{
				"type":        "string",
				"description": "Path to the file to read (relative to working directory)",
			},
		},
		"required": []string{"path"},
	}
}

func (t *ReadFile) Execute(_ context.Context, params map[string]any) (string, error) {
	pathVal, ok := params["path"]
	if !ok {
		return "", fmt.Errorf("missing required parameter: path")
	}
	path, ok := pathVal.(string)
	if !ok {
		return "", fmt.Errorf("parameter 'path' must be a string")
	}

	boundary, err := newWorkspaceBoundary(t.WorkDir)
	if err != nil {
		return "", err
	}
	resolved, err := boundary.existingFile(path)
	if err != nil {
		return "", err
	}
	f, err := os.Open(resolved)
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", path, err)
	}
	defer f.Close()

	data, err := io.ReadAll(io.LimitReader(f, MaxReadFileBytes+1))
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", path, err)
	}
	truncated := len(data) > MaxReadFileBytes
	if truncated {
		data = data[:MaxReadFileBytes]
	}

	lines := strings.Split(string(data), "\n")
	var b strings.Builder
	for i, line := range lines {
		fmt.Fprintf(&b, "%4d\t%s\n", i+1, line)
	}
	if truncated {
		fmt.Fprintf(&b, "\n(truncated: showing first %d bytes)", MaxReadFileBytes)
	}
	return b.String(), nil
}
