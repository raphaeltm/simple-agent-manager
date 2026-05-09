package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// GitBranch manages git branches: list, create, and checkout.
type GitBranch struct {
	WorkDir string
}

func (t *GitBranch) Name() string        { return "git_branch" }
func (t *GitBranch) Description() string { return "List, create, or checkout git branches." }
func (t *GitBranch) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"action": map[string]any{
				"type":        "string",
				"enum":        []string{"list", "create", "checkout"},
				"description": "The branch operation to perform.",
			},
			"name": map[string]any{
				"type":        "string",
				"description": "Branch name (required for create and checkout).",
			},
		},
		"required": []string{"action"},
	}
}

func (t *GitBranch) Execute(ctx context.Context, params map[string]any) (string, error) {
	action, err := requireString(params, "action")
	if err != nil {
		return "", err
	}

	switch action {
	case "list":
		return t.list(ctx)
	case "create":
		name, err := requireString(params, "name")
		if err != nil {
			return "", fmt.Errorf("branch name is required for create")
		}
		return t.create(ctx, name)
	case "checkout":
		name, err := requireString(params, "name")
		if err != nil {
			return "", fmt.Errorf("branch name is required for checkout")
		}
		return t.checkout(ctx, name)
	default:
		return "", fmt.Errorf("unknown action %q: must be list, create, or checkout", action)
	}
}

func (t *GitBranch) list(ctx context.Context) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "branch", "--no-color")
	cmd.Dir = t.WorkDir

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		errMsg := strings.TrimSpace(stderr.String())
		if errMsg == "" {
			errMsg = err.Error()
		}
		return "", fmt.Errorf("git branch: %s", errMsg)
	}

	output := strings.TrimRight(stdout.String(), "\n")
	var branches []string
	var current string
	if output != "" {
		for _, line := range strings.Split(output, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "* ") {
				name := strings.TrimPrefix(line, "* ")
				current = name
				branches = append(branches, name)
			} else {
				branches = append(branches, line)
			}
		}
	}

	result := map[string]any{
		"branches": branches,
		"current":  current,
	}
	data, _ := json.Marshal(result)
	return string(data), nil
}

func (t *GitBranch) create(ctx context.Context, name string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "branch", name)
	cmd.Dir = t.WorkDir

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		errMsg := strings.TrimSpace(stderr.String())
		if errMsg == "" {
			errMsg = err.Error()
		}
		return "", fmt.Errorf("git branch create: %s", errMsg)
	}

	result := map[string]any{"created": name}
	data, _ := json.Marshal(result)
	return string(data), nil
}

func (t *GitBranch) checkout(ctx context.Context, name string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "checkout", name)
	cmd.Dir = t.WorkDir

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		errMsg := strings.TrimSpace(stderr.String())
		if errMsg == "" {
			errMsg = err.Error()
		}
		return "", fmt.Errorf("git checkout: %s", errMsg)
	}

	result := map[string]any{"checked_out": name}
	data, _ := json.Marshal(result)
	return string(data), nil
}
