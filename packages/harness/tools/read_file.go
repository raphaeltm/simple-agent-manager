package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
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

	resolved := t.resolvePath(path)
	data, err := os.ReadFile(resolved)
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", path, err)
	}

	lines := strings.Split(string(data), "\n")
	var b strings.Builder
	for i, line := range lines {
		fmt.Fprintf(&b, "%4d\t%s\n", i+1, line)
	}
	return b.String(), nil
}

func (t *ReadFile) resolvePath(path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(t.WorkDir, path)
}
