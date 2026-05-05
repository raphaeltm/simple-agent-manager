package tools

import (
	"context"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
)

// Glob finds files matching a glob pattern within the working directory.
type Glob struct {
	WorkDir string
}

func (t *Glob) Name() string        { return "glob" }
func (t *Glob) Description() string { return "Find files matching a glob pattern." }
func (t *Glob) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"pattern": map[string]any{
				"type":        "string",
				"description": "Glob pattern to match (e.g., '**/*.go', 'src/**/*.ts')",
			},
		},
		"required": []string{"pattern"},
	}
}

func (t *Glob) Execute(_ context.Context, params map[string]any) (string, error) {
	patternVal, ok := params["pattern"]
	if !ok {
		return "", fmt.Errorf("missing required parameter: pattern")
	}
	pattern, ok := patternVal.(string)
	if !ok {
		return "", fmt.Errorf("parameter 'pattern' must be a string")
	}

	// Reject absolute patterns
	if filepath.IsAbs(pattern) {
		return "", fmt.Errorf("path %q escapes working directory", pattern)
	}
	// Reject traversal in pattern
	if strings.Contains(pattern, "..") {
		return "", fmt.Errorf("path %q escapes working directory", pattern)
	}

	const maxResults = 1000
	var matches []string

	err := filepath.WalkDir(t.WorkDir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if d.IsDir() {
			name := d.Name()
			if name == ".git" || name == "node_modules" || name == "vendor" {
				return fs.SkipDir
			}
			return nil
		}
		if len(matches) >= maxResults {
			return fs.SkipAll
		}

		relPath, err := filepath.Rel(t.WorkDir, path)
		if err != nil {
			return nil
		}

		if globMatch(pattern, relPath) {
			matches = append(matches, relPath)
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("walking directory: %w", err)
	}

	if len(matches) == 0 {
		return "No files matched.", nil
	}

	output := strings.Join(matches, "\n")
	if len(matches) >= maxResults {
		output += fmt.Sprintf("\n\n(truncated: showing first %d results)", maxResults)
	}
	return output, nil
}

// globMatch checks whether a relative path matches a glob pattern supporting "**".
func globMatch(pattern, path string) bool {
	// Normalize separators for matching
	pattern = filepath.ToSlash(pattern)
	path = filepath.ToSlash(path)

	return doubleStarMatch(pattern, path)
}

// doubleStarMatch implements glob matching with ** support.
func doubleStarMatch(pattern, name string) bool {
	// Split pattern by "**" segments
	parts := strings.Split(pattern, "**")

	if len(parts) == 1 {
		// No ** in pattern, use standard match
		ok, _ := filepath.Match(pattern, name)
		return ok
	}

	// Handle prefix before first **
	prefix := parts[0]
	if prefix != "" {
		prefix = strings.TrimSuffix(prefix, "/")
		if prefix != "" && !hasPathPrefix(name, prefix) {
			return false
		}
		if prefix != "" {
			name = name[len(prefix):]
			name = strings.TrimPrefix(name, "/")
		}
	}

	// Handle suffix after last **
	suffix := parts[len(parts)-1]
	if suffix != "" {
		suffix = strings.TrimPrefix(suffix, "/")
		if suffix != "" {
			// The suffix is a glob pattern for the filename
			ok, _ := filepath.Match(suffix, filepath.Base(name))
			if !ok {
				// Also try matching against the full remaining path
				ok, _ = filepath.Match(suffix, name)
			}
			return ok
		}
	}

	// Pattern like "**" alone matches everything
	return true
}

// hasPathPrefix checks if path starts with the given directory prefix.
func hasPathPrefix(path, prefix string) bool {
	if path == prefix {
		return true
	}
	return strings.HasPrefix(path, prefix+"/")
}
