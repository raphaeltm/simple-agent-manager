package tools

import (
	"context"
	"fmt"
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

// maxReadLines is the maximum number of lines returned from a single read.
const maxReadLines = 2000

func (t *ReadFile) Execute(_ context.Context, params map[string]any) (string, error) {
	pathVal, ok := params["path"]
	if !ok {
		return "", fmt.Errorf("missing required parameter: path")
	}
	path, ok := pathVal.(string)
	if !ok {
		return "", fmt.Errorf("parameter 'path' must be a string")
	}

	resolved, err := safePath(t.WorkDir, path)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(resolved)
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", path, err)
	}

	lines := strings.Split(string(data), "\n")
	totalLines := len(lines)
	// Trailing empty element from final newline isn't a real line.
	if totalLines > 0 && lines[totalLines-1] == "" {
		totalLines--
	}

	var b strings.Builder
	fmt.Fprintf(&b, "File: %s (%d lines)\n", path, totalLines)

	truncated := false
	showLines := lines
	if len(showLines) > maxReadLines {
		showLines = showLines[:maxReadLines]
		truncated = true
	}

	for i, line := range showLines {
		fmt.Fprintf(&b, "%4d\t%s\n", i+1, line)
	}

	if truncated {
		omitted := len(lines) - maxReadLines
		fmt.Fprintf(&b, "\n[truncated — showing first %d of %d lines, %d lines omitted]\n", maxReadLines, len(lines), omitted)
	}

	return b.String(), nil
}

