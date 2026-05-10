package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// ApplyDiff applies a unified diff to one or more files.
type ApplyDiff struct {
	WorkDir string
}

func (t *ApplyDiff) Name() string        { return "apply_diff" }
func (t *ApplyDiff) Description() string { return "Apply a unified diff to one or more files." }
func (t *ApplyDiff) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"diff": map[string]any{
				"type":        "string",
				"description": "A unified diff (the format produced by git diff or diff -u). May contain hunks for one or more files.",
			},
		},
		"required": []string{"diff"},
	}
}

func (t *ApplyDiff) Execute(_ context.Context, params map[string]any) (string, error) {
	diffStr, err := requireString(params, "diff")
	if err != nil {
		return "", err
	}

	fileDiffs, err := parseDiff(diffStr)
	if err != nil {
		return "", fmt.Errorf("parsing diff: %w", err)
	}
	if len(fileDiffs) == 0 {
		return "", fmt.Errorf("no file diffs found in input")
	}

	var summaries []string
	totalHunks := 0

	for _, fd := range fileDiffs {
		summary, err := t.applyFileDiff(fd)
		if err != nil {
			return "", err
		}
		totalHunks += len(fd.Hunks)
		summaries = append(summaries, summary)
	}

	return fmt.Sprintf("Applied %d hunks to %d files: %s",
		totalHunks, len(fileDiffs), strings.Join(summaries, ", ")), nil
}

// applyFileDiff applies all hunks for a single file.
func (t *ApplyDiff) applyFileDiff(fd fileDiff) (string, error) {
	// Handle file deletion.
	if fd.NewPath == "/dev/null" {
		resolved, err := safePath(t.WorkDir, fd.OldPath)
		if err != nil {
			return "", err
		}
		if err := os.Remove(resolved); err != nil {
			return "", fmt.Errorf("deleting %s: %w", fd.OldPath, err)
		}
		return fmt.Sprintf("%s (deleted)", fd.OldPath), nil
	}

	// Handle file creation.
	if fd.OldPath == "/dev/null" {
		resolved, err := safePath(t.WorkDir, fd.NewPath)
		if err != nil {
			return "", err
		}
		dir := filepath.Dir(resolved)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", fmt.Errorf("creating directory %s: %w", dir, err)
		}
		// Build content from the hunk's add lines.
		var lines []string
		for _, h := range fd.Hunks {
			for _, dl := range h.Lines {
				if dl.Op == opAdd {
					lines = append(lines, dl.Text)
				}
			}
		}
		content := strings.Join(lines, "\n")
		if len(lines) > 0 {
			content += "\n"
		}
		if err := atomicWrite(resolved, []byte(content), 0o644); err != nil {
			return "", fmt.Errorf("creating %s: %w", fd.NewPath, err)
		}
		added := 0
		for _, h := range fd.Hunks {
			for _, dl := range h.Lines {
				if dl.Op == opAdd {
					added++
				}
			}
		}
		return fmt.Sprintf("%s (+%d/-0)", fd.NewPath, added), nil
	}

	// Normal edit: read, patch, write.
	resolved, err := safePath(t.WorkDir, fd.NewPath)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(resolved)
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", fd.NewPath, err)
	}

	fileLines := strings.Split(string(data), "\n")
	// Remove trailing empty element if file ended with newline.
	if len(fileLines) > 0 && fileLines[len(fileLines)-1] == "" {
		fileLines = fileLines[:len(fileLines)-1]
	}

	// Apply hunks in reverse order so earlier line numbers stay valid.
	totalAdded, totalRemoved := 0, 0
	for i := len(fd.Hunks) - 1; i >= 0; i-- {
		h := fd.Hunks[i]
		added, removed, err := applyHunk(fileLines, h, fd.NewPath)
		if err != nil {
			return "", err
		}
		fileLines = added
		totalAdded += removed   // swapped intentionally: applyHunk returns new lines
		totalRemoved += removed // we'll count properly below
	}

	// Recount properly.
	totalAdded, totalRemoved = 0, 0
	for _, h := range fd.Hunks {
		for _, dl := range h.Lines {
			switch dl.Op {
			case opAdd:
				totalAdded++
			case opRemove:
				totalRemoved++
			}
		}
	}

	result := strings.Join(fileLines, "\n") + "\n"
	if err := atomicWrite(resolved, []byte(result), 0o644); err != nil {
		return "", fmt.Errorf("writing %s: %w", fd.NewPath, err)
	}

	return fmt.Sprintf("%s (+%d/-%d)", fd.NewPath, totalAdded, totalRemoved), nil
}

// --- diff parsing types ---

type diffOp int

const (
	opContext diffOp = iota
	opAdd
	opRemove
)

type diffLine struct {
	Op   diffOp
	Text string
}

type hunk struct {
	OldStart int
	OldCount int
	NewStart int
	NewCount int
	Lines    []diffLine
}

type fileDiff struct {
	OldPath string
	NewPath string
	Hunks   []hunk
}

// parseDiff parses a unified diff string into per-file diffs.
func parseDiff(input string) ([]fileDiff, error) {
	lines := strings.Split(input, "\n")
	var diffs []fileDiff
	var current *fileDiff

	i := 0
	for i < len(lines) {
		line := lines[i]

		// Detect file header.
		if strings.HasPrefix(line, "--- ") && i+1 < len(lines) && strings.HasPrefix(lines[i+1], "+++ ") {
			oldPath := stripPathPrefix(strings.TrimPrefix(line, "--- "))
			newPath := stripPathPrefix(strings.TrimPrefix(lines[i+1], "+++ "))
			fd := fileDiff{OldPath: oldPath, NewPath: newPath}
			diffs = append(diffs, fd)
			current = &diffs[len(diffs)-1]
			i += 2
			continue
		}

		// Detect hunk header.
		if strings.HasPrefix(line, "@@") && current != nil {
			h, err := parseHunkHeader(line)
			if err != nil {
				return nil, fmt.Errorf("parsing hunk header %q: %w", line, err)
			}
			// Parse hunk body.
			i++
			for i < len(lines) {
				l := lines[i]
				if strings.HasPrefix(l, "@@") || strings.HasPrefix(l, "--- ") || strings.HasPrefix(l, "diff --git") {
					break
				}
				if strings.HasPrefix(l, "+") {
					h.Lines = append(h.Lines, diffLine{Op: opAdd, Text: l[1:]})
				} else if strings.HasPrefix(l, "-") {
					h.Lines = append(h.Lines, diffLine{Op: opRemove, Text: l[1:]})
				} else if strings.HasPrefix(l, " ") {
					h.Lines = append(h.Lines, diffLine{Op: opContext, Text: l[1:]})
				} else if l == "" && i == len(lines)-1 {
					// Trailing empty line at end of input — skip.
					break
				} else if strings.HasPrefix(l, "\\") {
					// "\ No newline at end of file" — skip.
				} else {
					// Context line without leading space (some diffs omit the space for empty lines).
					h.Lines = append(h.Lines, diffLine{Op: opContext, Text: l})
				}
				i++
			}
			current.Hunks = append(current.Hunks, h)
			continue
		}

		// Skip other lines (e.g. "diff --git", "index", etc.)
		i++
	}

	return diffs, nil
}

// stripPathPrefix removes a/ or b/ prefix from diff paths.
func stripPathPrefix(path string) string {
	path = strings.TrimSpace(path)
	if strings.HasPrefix(path, "a/") || strings.HasPrefix(path, "b/") {
		return path[2:]
	}
	return path
}

// parseHunkHeader parses "@@ -old_start,old_count +new_start,new_count @@" lines.
func parseHunkHeader(line string) (hunk, error) {
	// Find the @@ ... @@ portion.
	line = strings.TrimPrefix(line, "@@")
	idx := strings.Index(line, "@@")
	if idx < 0 {
		return hunk{}, fmt.Errorf("malformed hunk header: missing closing @@")
	}
	header := strings.TrimSpace(line[:idx])

	parts := strings.Fields(header)
	if len(parts) < 2 {
		return hunk{}, fmt.Errorf("malformed hunk header: %q", header)
	}

	oldStart, oldCount, err := parseRange(parts[0], "-")
	if err != nil {
		return hunk{}, fmt.Errorf("old range: %w", err)
	}
	newStart, newCount, err := parseRange(parts[1], "+")
	if err != nil {
		return hunk{}, fmt.Errorf("new range: %w", err)
	}

	return hunk{
		OldStart: oldStart,
		OldCount: oldCount,
		NewStart: newStart,
		NewCount: newCount,
	}, nil
}

// parseRange parses "-N,M" or "+N,M" (or "-N" / "+N" when count is 1).
func parseRange(s, prefix string) (int, int, error) {
	s = strings.TrimPrefix(s, prefix)
	if idx := strings.Index(s, ","); idx >= 0 {
		start, err := strconv.Atoi(s[:idx])
		if err != nil {
			return 0, 0, err
		}
		count, err := strconv.Atoi(s[idx+1:])
		if err != nil {
			return 0, 0, err
		}
		return start, count, nil
	}
	start, err := strconv.Atoi(s)
	if err != nil {
		return 0, 0, err
	}
	return start, 1, nil
}

// applyHunk applies a single hunk to file lines and returns the modified lines.
// It supports fuzzy matching: if the context doesn't match at the expected line,
// it searches ±3 lines for a match.
func applyHunk(fileLines []string, h hunk, filename string) ([]string, int, error) {
	// Collect context+remove lines for matching.
	var matchLines []string
	for _, dl := range h.Lines {
		if dl.Op == opContext || dl.Op == opRemove {
			matchLines = append(matchLines, dl.Text)
		}
	}

	if len(matchLines) == 0 {
		// Pure addition at the specified position.
		pos := h.NewStart - 1
		if pos < 0 {
			pos = 0
		}
		if pos > len(fileLines) {
			pos = len(fileLines)
		}
		var newLines []string
		for _, dl := range h.Lines {
			if dl.Op == opAdd {
				newLines = append(newLines, dl.Text)
			}
		}
		result := make([]string, 0, len(fileLines)+len(newLines))
		result = append(result, fileLines[:pos]...)
		result = append(result, newLines...)
		result = append(result, fileLines[pos:]...)
		return result, 0, nil
	}

	// Try to find the match position. Start at the expected position (0-indexed).
	expectedPos := h.OldStart - 1
	if expectedPos < 0 {
		expectedPos = 0
	}

	matchPos := -1
	// Try exact position first, then fuzzy ±3.
	for _, offset := range []int{0, -1, 1, -2, 2, -3, 3} {
		pos := expectedPos + offset
		if pos < 0 || pos+len(matchLines) > len(fileLines) {
			continue
		}
		if linesMatch(fileLines, pos, matchLines) {
			matchPos = pos
			break
		}
	}

	if matchPos < 0 {
		// Show what we expected vs what was at the expected position.
		snippet := "EOF"
		if expectedPos < len(fileLines) {
			end := expectedPos + len(matchLines)
			if end > len(fileLines) {
				end = len(fileLines)
			}
			snippet = strings.Join(fileLines[expectedPos:end], "\n")
		}
		return nil, 0, fmt.Errorf(
			"hunk for %s at line %d failed: context mismatch\nexpected:\n%s\nactual:\n%s",
			filename, h.OldStart,
			strings.Join(matchLines, "\n"),
			snippet,
		)
	}

	// Build the replacement.
	var replacement []string
	for _, dl := range h.Lines {
		switch dl.Op {
		case opContext, opAdd:
			replacement = append(replacement, dl.Text)
		// opRemove: skip (removed from output)
		}
	}

	result := make([]string, 0, len(fileLines)-len(matchLines)+len(replacement))
	result = append(result, fileLines[:matchPos]...)
	result = append(result, replacement...)
	result = append(result, fileLines[matchPos+len(matchLines):]...)

	return result, len(matchLines), nil
}

// linesMatch checks if fileLines[start:start+len(match)] equals match.
func linesMatch(fileLines []string, start int, match []string) bool {
	for i, m := range match {
		if fileLines[start+i] != m {
			return false
		}
	}
	return true
}
