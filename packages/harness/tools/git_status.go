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
		}
		data, _ := json.Marshal(result)
		return string(data), nil
	}

	lines := strings.Split(output, "\n")
	entries := make([]StatusEntry, 0, len(lines))
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
	}

	result := map[string]any{
		"clean":   false,
		"entries": entries,
	}
	data, _ := json.Marshal(result)
	return string(data), nil
}
