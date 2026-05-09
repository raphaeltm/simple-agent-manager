package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// GitDiff runs `git diff` with configurable options and returns the diff output.
type GitDiff struct {
	WorkDir string
}

func (t *GitDiff) Name() string        { return "git_diff" }
func (t *GitDiff) Description() string { return "Show changes between commits, index, and working tree." }
func (t *GitDiff) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"staged": map[string]any{
				"type":        "boolean",
				"description": "If true, show staged changes (--staged). Default: false.",
			},
			"path": map[string]any{
				"type":        "string",
				"description": "Optional file path to limit the diff to.",
			},
		},
	}
}

func (t *GitDiff) Execute(ctx context.Context, params map[string]any) (string, error) {
	args := []string{"diff"}

	if staged, ok := params["staged"].(bool); ok && staged {
		args = append(args, "--staged")
	}

	if path, ok := params["path"].(string); ok && path != "" {
		resolved, err := safePath(t.WorkDir, path)
		if err != nil {
			return "", err
		}
		// Use resolved path relative to workdir for git
		_ = resolved
		args = append(args, "--", path)
	}

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
		return "", fmt.Errorf("git diff: %s", errMsg)
	}

	diff := stdout.String()
	if diff == "" {
		result := map[string]any{"diff": "", "empty": true}
		data, _ := json.Marshal(result)
		return string(data), nil
	}

	result := map[string]any{"diff": diff, "empty": false}
	data, _ := json.Marshal(result)
	return string(data), nil
}
