package tools

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
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
	pattern, err := requireString(params, "pattern")
	if err != nil {
		return "", err
	}
	pattern, err = validateRelativePattern(pattern)
	if err != nil {
		return "", err
	}

	boundary, err := newWorkspaceBoundary(t.WorkDir)
	if err != nil {
		return "", err
	}

	var matches []string

	err = filepath.WalkDir(boundary.root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return fmt.Errorf("walking %s: %w", path, walkErr)
		}
		if d.Type()&os.ModeSymlink != 0 {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			name := d.Name()
			if _, skip := skippedSearchDirs[name]; skip {
				return fs.SkipDir
			}
			return nil
		}
		if len(matches) >= MaxGlobResults {
			return fs.SkipAll
		}

		relPath, err := filepath.Rel(boundary.root, path)
		if err != nil {
			return err
		}
		relPath = filepath.ToSlash(relPath)

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

	sort.Strings(matches)
	output := strings.Join(matches, "\n")
	if len(matches) >= MaxGlobResults {
		output += fmt.Sprintf("\n\n(truncated: showing first %d results)", MaxGlobResults)
	}
	return output, nil
}

// globMatch checks whether a relative path matches a glob pattern supporting "**".
func globMatch(pattern, path string) bool {
	pattern = filepath.ToSlash(pattern)
	path = filepath.ToSlash(path)
	return globSegments(strings.Split(pattern, "/"), strings.Split(path, "/"))
}

func globSegments(patternParts, pathParts []string) bool {
	if len(patternParts) == 0 {
		return len(pathParts) == 0
	}
	if patternParts[0] == "**" {
		if globSegments(patternParts[1:], pathParts) {
			return true
		}
		for i := range pathParts {
			if globSegments(patternParts[1:], pathParts[i+1:]) {
				return true
			}
		}
		return false
	}
	if len(pathParts) == 0 {
		return false
	}
	ok, err := filepath.Match(patternParts[0], pathParts[0])
	if err != nil || !ok {
		return false
	}
	return globSegments(patternParts[1:], pathParts[1:])
}
