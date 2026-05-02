package tools

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// DefaultBashTimeout is the default timeout for bash commands.
const DefaultBashTimeout = 30 * time.Second

// Bash executes shell commands with timeout, cancellation, and working directory sandboxing.
type Bash struct {
	WorkDir string
	Timeout time.Duration // 0 means DefaultBashTimeout
}

func (t *Bash) Name() string        { return "bash" }
func (t *Bash) Description() string { return "Execute a bash command and return stdout+stderr." }
func (t *Bash) Schema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"command": map[string]any{
				"type":        "string",
				"description": "The bash command to execute",
			},
		},
		"required": []string{"command"},
	}
}

func (t *Bash) Execute(ctx context.Context, params map[string]any) (string, error) {
	command, err := requireString(params, "command")
	if err != nil {
		return "", err
	}

	timeout := t.Timeout
	if timeout == 0 {
		timeout = DefaultBashTimeout
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "bash", "-c", command)
	cmd.Dir = filepath.Clean(t.WorkDir)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err = cmd.Run()

	var result strings.Builder
	if stdout.Len() > 0 {
		result.WriteString(stdout.String())
	}
	if stderr.Len() > 0 {
		if result.Len() > 0 {
			result.WriteString("\n")
		}
		result.WriteString("STDERR:\n")
		result.WriteString(stderr.String())
	}

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return result.String(), fmt.Errorf("command timed out after %s", timeout)
		}
		if ctx.Err() == context.Canceled {
			return result.String(), fmt.Errorf("command cancelled")
		}
		// Include exit code in result but return the output too.
		return fmt.Sprintf("%s\nexit code: %s", result.String(), err.Error()), nil
	}

	if result.Len() == 0 {
		return "(no output)", nil
	}
	return result.String(), nil
}
