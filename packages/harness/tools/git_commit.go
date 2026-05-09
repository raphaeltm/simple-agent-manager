package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// GitCommit stages files and creates a commit.
type GitCommit struct {
	WorkDir string
}

func (t *GitCommit) Name() string { return "git_commit" }
func (t *GitCommit) Description() string {
	return "Stage files and create a git commit. Stages all changes by default, or specific paths if provided."
}
func (t *GitCommit) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"message": map[string]any{
				"type":        "string",
				"description": "The commit message.",
			},
			"paths": map[string]any{
				"type":        "array",
				"items":       map[string]any{"type": "string"},
				"description": "Specific paths to stage. If empty, stages all changes (git add -A).",
			},
		},
		"required": []string{"message"},
	}
}

func (t *GitCommit) Execute(ctx context.Context, params map[string]any) (string, error) {
	message, err := requireString(params, "message")
	if err != nil {
		return "", err
	}
	if message == "" {
		return "", fmt.Errorf("commit message cannot be empty")
	}

	// Stage files
	var addArgs []string
	if paths, ok := params["paths"].([]any); ok && len(paths) > 0 {
		addArgs = []string{"add"}
		for _, p := range paths {
			ps, ok := p.(string)
			if !ok {
				continue
			}
			// Validate path containment
			if _, err := safePath(t.WorkDir, ps); err != nil {
				return "", err
			}
			addArgs = append(addArgs, ps)
		}
	} else {
		addArgs = []string{"add", "-A"}
	}

	addCmd := exec.CommandContext(ctx, "git", addArgs...)
	addCmd.Dir = t.WorkDir
	var addStderr bytes.Buffer
	addCmd.Stderr = &addStderr
	if err := addCmd.Run(); err != nil {
		errMsg := strings.TrimSpace(addStderr.String())
		if errMsg == "" {
			errMsg = err.Error()
		}
		return "", fmt.Errorf("git add: %s", errMsg)
	}

	// Create commit
	commitCmd := exec.CommandContext(ctx, "git", "commit", "-m", message)
	commitCmd.Dir = t.WorkDir
	var commitStdout, commitStderr bytes.Buffer
	commitCmd.Stdout = &commitStdout
	commitCmd.Stderr = &commitStderr

	if err := commitCmd.Run(); err != nil {
		errMsg := strings.TrimSpace(commitStderr.String())
		if errMsg == "" {
			errMsg = strings.TrimSpace(commitStdout.String())
		}
		if errMsg == "" {
			errMsg = err.Error()
		}
		return "", fmt.Errorf("git commit: %s", errMsg)
	}

	// Get the commit hash
	hashCmd := exec.CommandContext(ctx, "git", "rev-parse", "HEAD")
	hashCmd.Dir = t.WorkDir
	var hashStdout bytes.Buffer
	hashCmd.Stdout = &hashStdout
	if err := hashCmd.Run(); err != nil {
		return "", fmt.Errorf("git rev-parse: %s", err.Error())
	}

	hash := strings.TrimSpace(hashStdout.String())
	result := map[string]any{
		"hash":    hash,
		"message": message,
	}
	data, _ := json.Marshal(result)
	return string(data), nil
}
