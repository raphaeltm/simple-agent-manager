package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// GitLog runs `git log --oneline` and returns recent commit history.
type GitLog struct {
	WorkDir string
}

func (t *GitLog) Name() string        { return "git_log" }
func (t *GitLog) Description() string { return "Show recent commit history." }
func (t *GitLog) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"count": map[string]any{
				"type":        "number",
				"description": "Number of commits to show. Default: 10.",
			},
		},
	}
}

// LogEntry represents a single commit from git log.
type LogEntry struct {
	Hash    string `json:"hash"`
	Message string `json:"message"`
}

func (t *GitLog) Execute(ctx context.Context, params map[string]any) (string, error) {
	count := 10
	if c, ok := params["count"].(float64); ok && c > 0 {
		count = int(c)
	}

	args := []string{"log", "--oneline", fmt.Sprintf("-n%d", count)}
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = t.WorkDir

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		errMsg := strings.TrimSpace(stderr.String())
		if errMsg == "" {
			errMsg = err.Error()
		}
		return "", fmt.Errorf("git log: %s", errMsg)
	}

	output := strings.TrimRight(stdout.String(), "\n")
	if output == "" {
		result := map[string]any{"commits": []LogEntry{}}
		data, _ := json.Marshal(result)
		return string(data), nil
	}

	lines := strings.Split(output, "\n")
	entries := make([]LogEntry, 0, len(lines))
	for _, line := range lines {
		parts := strings.SplitN(line, " ", 2)
		if len(parts) < 2 {
			continue
		}
		entries = append(entries, LogEntry{
			Hash:    parts[0],
			Message: parts[1],
		})
	}

	result := map[string]any{"commits": entries}
	data, _ := json.Marshal(result)
	return string(data), nil
}
