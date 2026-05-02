package tools

import (
	"context"
	"fmt"
	"os"
	"strings"
)

// EditFile performs search-and-replace editing with unique match validation.
type EditFile struct {
	WorkDir string
}

func (t *EditFile) Name() string { return "edit_file" }
func (t *EditFile) Description() string {
	return "Replace a unique string in a file. The old_string must appear exactly once."
}
func (t *EditFile) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path": map[string]any{
				"type":        "string",
				"description": "Path to the file to edit (relative to working directory)",
			},
			"old_string": map[string]any{
				"type":        "string",
				"description": "The exact string to find (must appear exactly once)",
			},
			"new_string": map[string]any{
				"type":        "string",
				"description": "The replacement string",
			},
		},
		"required": []string{"path", "old_string", "new_string"},
	}
}

func (t *EditFile) Execute(_ context.Context, params map[string]any) (string, error) {
	path, err := requireString(params, "path")
	if err != nil {
		return "", err
	}
	oldStr, err := requireString(params, "old_string")
	if err != nil {
		return "", err
	}
	newStr, err := requireString(params, "new_string")
	if err != nil {
		return "", err
	}

	resolved, err := safePath(t.WorkDir, path)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(resolved)
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", path, err)
	}

	content := string(data)
	count := strings.Count(content, oldStr)

	switch {
	case count == 0:
		return "", fmt.Errorf("old_string not found in %s", path)
	case count > 1:
		return "", fmt.Errorf("old_string found %d times in %s (must be unique)", count, path)
	}

	updated := strings.Replace(content, oldStr, newStr, 1)
	if err := atomicWrite(resolved, []byte(updated), 0o644); err != nil {
		return "", fmt.Errorf("writing %s: %w", path, err)
	}

	return fmt.Sprintf("replaced 1 occurrence in %s", path), nil
}
