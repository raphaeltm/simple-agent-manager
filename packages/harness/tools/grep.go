package tools

import (
	"bufio"
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Grep searches file contents recursively with regex support.
type Grep struct {
	WorkDir string
}

func (t *Grep) Name() string        { return "grep" }
func (t *Grep) Description() string { return "Search file contents recursively using regex." }
func (t *Grep) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"pattern": map[string]any{
				"type":        "string",
				"description": "Regex pattern to search for",
			},
			"path": map[string]any{
				"type":        "string",
				"description": "Directory or file to search in (relative to working directory). Defaults to '.'",
			},
			"include": map[string]any{
				"type":        "string",
				"description": "Glob pattern for files to include (e.g., '*.go', '*.ts')",
			},
			"context_lines": map[string]any{
				"type":        "integer",
				"description": "Number of context lines before and after each match (default: 0)",
			},
		},
		"required": []string{"pattern"},
	}
}

func (t *Grep) Execute(_ context.Context, params map[string]any) (string, error) {
	patternVal, ok := params["pattern"]
	if !ok {
		return "", fmt.Errorf("missing required parameter: pattern")
	}
	pattern, ok := patternVal.(string)
	if !ok {
		return "", fmt.Errorf("parameter 'pattern' must be a string")
	}

	re, err := regexp.Compile(pattern)
	if err != nil {
		return "", fmt.Errorf("invalid regex pattern: %w", err)
	}

	searchPath := "."
	if v, ok := params["path"].(string); ok && v != "" {
		searchPath = v
	}

	resolved, err := safePath(t.WorkDir, searchPath)
	if err != nil {
		return "", err
	}

	var include string
	if v, ok := params["include"].(string); ok {
		include = v
	}

	contextLines := 0
	if v, ok := params["context_lines"].(float64); ok {
		contextLines = int(v)
	}

	const maxMatches = 200
	var results []string
	matchCount := 0

	err = filepath.WalkDir(resolved, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil // skip unreadable entries
		}
		if d.IsDir() {
			name := d.Name()
			if name == ".git" || name == "node_modules" || name == "vendor" {
				return fs.SkipDir
			}
			return nil
		}
		if matchCount >= maxMatches {
			return fs.SkipAll
		}

		// Apply include filter
		if include != "" {
			matched, _ := filepath.Match(include, d.Name())
			if !matched {
				return nil
			}
		}

		// Skip binary files heuristic: check first 512 bytes
		if isBinary(path) {
			return nil
		}

		relPath, _ := filepath.Rel(t.WorkDir, path)
		matches := searchFile(path, re, relPath, contextLines)
		for _, m := range matches {
			if matchCount >= maxMatches {
				break
			}
			results = append(results, m)
			matchCount++
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("walking directory: %w", err)
	}

	if len(results) == 0 {
		return "No matches found.", nil
	}

	output := strings.Join(results, "\n")
	if matchCount >= maxMatches {
		output += fmt.Sprintf("\n\n(truncated: showing first %d matches)", maxMatches)
	}
	return output, nil
}

func searchFile(path string, re *regexp.Regexp, relPath string, contextLines int) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	var lines []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if scanner.Err() != nil {
		return nil
	}

	var results []string
	for i, line := range lines {
		if re.MatchString(line) {
			start := i - contextLines
			if start < 0 {
				start = 0
			}
			end := i + contextLines + 1
			if end > len(lines) {
				end = len(lines)
			}

			if contextLines == 0 {
				results = append(results, fmt.Sprintf("%s:%d:%s", relPath, i+1, line))
			} else {
				var block strings.Builder
				for j := start; j < end; j++ {
					prefix := " "
					if j == i {
						prefix = ">"
					}
					fmt.Fprintf(&block, "%s %s:%d:%s\n", prefix, relPath, j+1, lines[j])
				}
				results = append(results, strings.TrimRight(block.String(), "\n"))
			}
		}
	}
	return results
}

func isBinary(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return true
	}
	defer f.Close()

	buf := make([]byte, 512)
	n, _ := f.Read(buf)
	if n == 0 {
		return false
	}
	for _, b := range buf[:n] {
		if b == 0 {
			return true
		}
	}
	return false
}
