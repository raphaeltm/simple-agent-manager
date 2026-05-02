package tools

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// DefaultBashTimeout is the default timeout for bash commands.
const DefaultBashTimeout = 30 * time.Second

// Bash executes shell commands with timeout and cancellation.
//
// SECURITY: This tool runs arbitrary shell commands with NO sandboxing beyond
// setting the initial working directory. An LLM can execute any command the
// host process can. In production, this tool MUST run inside a container or VM
// with restricted filesystem and network access. This is acceptable for the
// spike because SAM workspaces already run inside isolated DevContainers on VMs.
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
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 2 * time.Second

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err = cmd.Run()

	// Kill the entire process group on context cancellation to prevent orphans.
	if ctx.Err() != nil && cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}

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
		// Non-zero exit: return output with exit code and a non-nil error
		// so Dispatch correctly sets IsError on the ToolResult.
		return fmt.Sprintf("%s\nexit code: %s", result.String(), err.Error()),
			fmt.Errorf("non-zero exit: %w", err)
	}

	if result.Len() == 0 {
		return "(no output)", nil
	}
	return result.String(), nil
}
