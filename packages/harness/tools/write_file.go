package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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

	resolved, err := safePath(t.WorkDir, path)
	if err != nil {
		return "", err
	}

	// Check if file already exists and capture old state.
	var oldLines int
	var existed bool
	if oldData, readErr := os.ReadFile(resolved); readErr == nil {
		existed = true
		oldLines = countLines(string(oldData))
	}

	// Ensure parent directory exists.
	dir := filepath.Dir(resolved)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("creating directory %s: %w", dir, err)
	}

	if err := atomicWrite(resolved, []byte(content), 0o644); err != nil {
		return "", fmt.Errorf("writing %s: %w", path, err)
	}

	newLines := countLines(content)
	if existed {
		return fmt.Sprintf("Overwrote %s (%d lines, %d bytes, was %d lines)",
			path, newLines, len(content), oldLines), nil
	}
	return fmt.Sprintf("Created %s (%d lines, %d bytes)", path, newLines, len(content)), nil
}

// countLines counts the number of lines in a string (non-empty content has at least 1 line).
func countLines(s string) int {
	if s == "" {
		return 0
	}
	n := strings.Count(s, "\n")
	if !strings.HasSuffix(s, "\n") {
		n++
	}
	return n
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

// atomicWrite writes data to a temp file then renames it, preventing partial writes.
func atomicWrite(path string, data []byte, perm os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".write-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // clean up on any error path

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

// safePath resolves path relative to workDir and rejects any path that escapes it.
// Absolute paths and "../" traversals above workDir are rejected.
func safePath(workDir, path string) (string, error) {
	if filepath.IsAbs(path) {
		return "", fmt.Errorf("path %q escapes working directory", path)
	}
	resolved := filepath.Join(workDir, path)
	absWork, err := filepath.Abs(workDir)
	if err != nil {
		return "", fmt.Errorf("resolving workdir: %w", err)
	}
	absResolved, err := filepath.Abs(resolved)
	if err != nil {
		return "", fmt.Errorf("resolving path: %w", err)
	}
	rel, err := filepath.Rel(absWork, absResolved)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("path %q escapes working directory", path)
	}
	return absResolved, nil
}
