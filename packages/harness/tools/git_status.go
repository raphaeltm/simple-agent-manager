package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// GitStatus runs `git status --porcelain` and returns parsed file statuses.
type GitStatus struct {
	WorkDir string
}

func (t *GitStatus) Name() string        { return "git_status" }
func (t *GitStatus) Description() string { return "Show the working tree status as structured data." }
func (t *GitStatus) Schema() map[string]any {
	return map[string]any{
		"type":       "object",
		"properties": map[string]any{},
	}
}

// StatusEntry represents a single file's status from git status --porcelain.
type StatusEntry struct {
	Path    string `json:"path"`
	Index   string `json:"index"`
	WorkDir string `json:"workdir"`
}

func (t *GitStatus) Execute(ctx context.Context, _ map[string]any) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "status", "--porcelain")
	cmd.Dir = t.WorkDir

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		errMsg := strings.TrimSpace(stderr.String())
		if errMsg == "" {
			errMsg = err.Error()
		}
		return "", fmt.Errorf("git status: %s", errMsg)
	}

	output := strings.TrimRight(stdout.String(), "\n")
	if output == "" {
		result := map[string]any{
			"clean":   true,
			"entries": []StatusEntry{},
			"summary": "Working tree clean",
		}
		data, _ := json.Marshal(result)
		return string(data), nil
	}

	lines := strings.Split(output, "\n")
	entries := make([]StatusEntry, 0, len(lines))
	var staged, modified, untracked []string

	for _, line := range lines {
		if len(line) < 4 {
			continue
		}
		entry := StatusEntry{
			Index:   string(line[0]),
			WorkDir: string(line[1]),
			Path:    line[3:],
		}
		entries = append(entries, entry)

		// Categorize for summary.
		switch {
		case entry.Index == "?" && entry.WorkDir == "?":
			untracked = append(untracked, entry.Path)
		case entry.Index != " " && entry.Index != "?":
			staged = append(staged, entry.Path)
			if entry.WorkDir != " " && entry.WorkDir != "?" {
				modified = append(modified, entry.Path)
			}
		case entry.WorkDir != " " && entry.WorkDir != "?":
			modified = append(modified, entry.Path)
		}
	}

	// Build human-readable summary.
	var parts []string
	if len(staged) > 0 {
		parts = append(parts, fmt.Sprintf("Staged: %d", len(staged)))
	}
	if len(modified) > 0 {
		parts = append(parts, fmt.Sprintf("Modified: %d", len(modified)))
	}
	if len(untracked) > 0 {
		parts = append(parts, fmt.Sprintf("Untracked: %d", len(untracked)))
	}

	result := map[string]any{
		"clean":   false,
		"entries": entries,
		"summary": strings.Join(parts, ", "),
		"counts": map[string]int{
			"staged":    len(staged),
			"modified":  len(modified),
			"untracked": len(untracked),
		},
	}
	data, _ := json.Marshal(result)
	return string(data), nil
}
