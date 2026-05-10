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
		hint := findSimilarLines(content, oldStr)
		return "", fmt.Errorf("old_string not found in %s%s", path, hint)
	case count > 1:
		return "", fmt.Errorf("old_string found %d times in %s (must be unique)", count, path)
	}

	updated := strings.Replace(content, oldStr, newStr, 1)
	if err := atomicWrite(resolved, []byte(updated), 0o644); err != nil {
		return "", fmt.Errorf("writing %s: %w", path, err)
	}

	// Build contextual output showing the edit in place.
	result := formatEditContext(path, updated, newStr)
	return result, nil
}

// formatEditContext shows the replacement text with 3 lines of context.
func formatEditContext(path, fileContent, newStr string) string {
	lines := strings.Split(fileContent, "\n")

	// Find where the new string starts in the file.
	newStrLines := strings.Split(newStr, "\n")
	firstNewLine := newStrLines[0]
	editStartIdx := -1
	for i, line := range lines {
		if strings.Contains(line, firstNewLine) {
			editStartIdx = i
			break
		}
	}
	if editStartIdx < 0 {
		return fmt.Sprintf("Edited %s", path)
	}

	editEndIdx := editStartIdx + len(newStrLines) - 1
	if editEndIdx >= len(lines) {
		editEndIdx = len(lines) - 1
	}

	// Show 3 lines of context before and after.
	const contextSize = 3
	start := editStartIdx - contextSize
	if start < 0 {
		start = 0
	}
	end := editEndIdx + contextSize + 1
	if end > len(lines) {
		end = len(lines)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Edited %s:\n", path)
	for i := start; i < end; i++ {
		if i >= editStartIdx && i <= editEndIdx {
			fmt.Fprintf(&b, "%4d→ %s\n", i+1, lines[i])
		} else {
			fmt.Fprintf(&b, "%4d│ %s\n", i+1, lines[i])
		}
	}
	return b.String()
}

// findSimilarLines returns a hint string with up to 3 lines similar to the search string.
func findSimilarLines(content, search string) string {
	lines := strings.Split(content, "\n")
	searchLower := strings.ToLower(strings.TrimSpace(search))
	searchFirstLine := strings.ToLower(strings.TrimSpace(strings.Split(search, "\n")[0]))

	type scored struct {
		lineNum int
		text    string
		score   int
	}

	var candidates []scored
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		lineLower := strings.ToLower(trimmed)

		score := 0
		// Check for common substring words.
		searchWords := strings.Fields(searchFirstLine)
		for _, w := range searchWords {
			if len(w) >= 3 && strings.Contains(lineLower, w) {
				score += len(w)
			}
		}
		// Bonus for prefix match.
		if len(searchLower) > 0 && len(lineLower) > 0 {
			// Check if line starts with the same non-whitespace content.
			if strings.HasPrefix(lineLower, searchLower[:min(len(searchLower), 20)]) {
				score += 10
			}
		}

		if score > 0 {
			candidates = append(candidates, scored{lineNum: i + 1, text: trimmed, score: score})
		}
	}

	if len(candidates) == 0 {
		return ""
	}

	// Sort by score descending, take top 3.
	for i := 0; i < len(candidates); i++ {
		for j := i + 1; j < len(candidates); j++ {
			if candidates[j].score > candidates[i].score {
				candidates[i], candidates[j] = candidates[j], candidates[i]
			}
		}
	}
	limit := 3
	if len(candidates) < limit {
		limit = len(candidates)
	}

	var b strings.Builder
	b.WriteString("\nDid you mean one of these lines?\n")
	for _, c := range candidates[:limit] {
		fmt.Fprintf(&b, "  Line %d: %s\n", c.lineNum, c.text)
	}
	return b.String()
}
