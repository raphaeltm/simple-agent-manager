package tools

import (
	"bufio"
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
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
	pattern, err := requireString(params, "pattern")
	if err != nil {
		return "", err
	}
	if pattern == "" {
		return "", fmt.Errorf("parameter \"pattern\" must not be empty")
	}

	re, err := regexp.Compile(pattern)
	if err != nil {
		return "", fmt.Errorf("invalid regex pattern: %w", err)
	}

	searchPath := "."
	if v, ok := params["path"]; ok {
		path, ok := v.(string)
		if !ok {
			return "", fmt.Errorf("parameter \"path\" must be a string")
		}
		if strings.TrimSpace(path) != "" {
			searchPath = path
		}
	}

	boundary, err := newWorkspaceBoundary(t.WorkDir)
	if err != nil {
		return "", err
	}
	resolved, err := boundary.existingSearchRoot(searchPath)
	if err != nil {
		return "", err
	}

	var include string
	if v, ok := params["include"]; ok {
		includeVal, ok := v.(string)
		if !ok {
			return "", fmt.Errorf("parameter \"include\" must be a string")
		}
		include, err = validateRelativePattern(includeVal)
		if err != nil {
			return "", err
		}
	}

	contextLines := 0
	if v, ok := params["context_lines"]; ok {
		switch n := v.(type) {
		case float64:
			contextLines = int(n)
			if float64(contextLines) != n {
				return "", fmt.Errorf("parameter \"context_lines\" must be an integer")
			}
		case int:
			contextLines = n
		default:
			return "", fmt.Errorf("parameter \"context_lines\" must be an integer")
		}
		if contextLines < 0 {
			return "", fmt.Errorf("parameter \"context_lines\" must be non-negative")
		}
	}

	var results []string
	matchCount := 0

	err = filepath.WalkDir(resolved, func(path string, d fs.DirEntry, walkErr error) error {
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
		if matchCount >= MaxGrepMatches {
			return fs.SkipAll
		}

		if include != "" {
			relPath, err := filepath.Rel(boundary.root, path)
			if err != nil {
				return err
			}
			matched := globMatch(include, relPath)
			if !matched {
				return nil
			}
		}

		if isBinary(path) {
			return nil
		}

		relPath, err := filepath.Rel(boundary.root, path)
		if err != nil {
			return err
		}
		matches, err := searchFile(path, re, filepath.ToSlash(relPath), contextLines)
		if err != nil {
			return err
		}
		for _, m := range matches {
			if matchCount >= MaxGrepMatches {
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

	sort.Strings(results)
	output := strings.Join(results, "\n")
	if matchCount >= MaxGrepMatches {
		output += fmt.Sprintf("\n\n(truncated: showing first %d matches)", MaxGrepMatches)
	}
	return output, nil
}

func searchFile(path string, re *regexp.Regexp, relPath string, contextLines int) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var lines []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 4096), MaxGrepLineBytes)
	bytesRead := 0
	for scanner.Scan() {
		line := scanner.Text()
		bytesRead += len(line) + 1
		if bytesRead > MaxGrepFileBytes {
			return nil, fmt.Errorf("file %s exceeds grep limit of %d bytes", relPath, MaxGrepFileBytes)
		}
		lines = append(lines, line)
	}
	if scanner.Err() != nil {
		return nil, fmt.Errorf("scanning %s: %w", relPath, scanner.Err())
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
	return results, nil
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
