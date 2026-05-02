package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// WriteFile creates or overwrites a file.
type WriteFile struct {
	WorkDir string
}

func (t *WriteFile) Name() string        { return "write_file" }
func (t *WriteFile) Description() string { return "Create or overwrite a file with the given content." }
func (t *WriteFile) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path": map[string]any{
				"type":        "string",
				"description": "Path to the file to write (relative to working directory)",
			},
			"content": map[string]any{
				"type":        "string",
				"description": "Content to write to the file",
			},
		},
		"required": []string{"path", "content"},
	}
}

func (t *WriteFile) Execute(_ context.Context, params map[string]any) (string, error) {
	path, err := requireString(params, "path")
	if err != nil {
		return "", err
	}
	content, err := requireString(params, "content")
	if err != nil {
		return "", err
	}

	resolved := filepath.Join(t.WorkDir, path)

	// Ensure parent directory exists.
	dir := filepath.Dir(resolved)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("creating directory %s: %w", dir, err)
	}

	if err := os.WriteFile(resolved, []byte(content), 0o644); err != nil {
		return "", fmt.Errorf("writing %s: %w", path, err)
	}

	return fmt.Sprintf("wrote %d bytes to %s", len(content), path), nil
}

// requireString extracts a required string parameter.
func requireString(params map[string]any, key string) (string, error) {
	val, ok := params[key]
	if !ok {
		return "", fmt.Errorf("missing required parameter: %s", key)
	}
	s, ok := val.(string)
	if !ok {
		return "", fmt.Errorf("parameter %q must be a string", key)
	}
	return s, nil
}
