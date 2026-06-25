package tools

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
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
	boundary, err := newWorkspaceBoundary(t.WorkDir)
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
	cmd.Dir = boundary.root
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 2 * time.Second
	cmd.Cancel = func() error {
		return killProcessGroup(cmd.Process)
	}

	stdout := &limitedBuffer{Limit: MaxBashOutputBytes}
	stderr := &limitedBuffer{Limit: MaxBashOutputBytes}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	err = cmd.Run()
	_ = killProcessGroup(cmd.Process)

	var result strings.Builder
	if stdout.Len() > 0 {
		result.WriteString(stdout.String())
		if stdout.Truncated {
			fmt.Fprintf(&result, "\n(truncated stdout: showing first %d bytes)", MaxBashOutputBytes)
		}
	}
	if stderr.Len() > 0 {
		if result.Len() > 0 {
			result.WriteString("\n")
		}
		result.WriteString("STDERR:\n")
		result.WriteString(stderr.String())
		if stderr.Truncated {
			fmt.Fprintf(&result, "\n(truncated stderr: showing first %d bytes)", MaxBashOutputBytes)
		}
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

func killProcessGroup(process *os.Process) error {
	if process == nil {
		return nil
	}
	err := syscall.Kill(-process.Pid, syscall.SIGKILL)
	if err == nil || err == syscall.ESRCH {
		return nil
	}
	return err
}

type limitedBuffer struct {
	Limit     int
	buf       bytes.Buffer
	Truncated bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.Limit <= 0 {
		return len(p), nil
	}
	remaining := b.Limit - b.buf.Len()
	if remaining > 0 {
		toWrite := len(p)
		if toWrite > remaining {
			toWrite = remaining
		}
		if _, err := b.buf.Write(p[:toWrite]); err != nil {
			return 0, err
		}
	}
	if len(p) > remaining {
		b.Truncated = true
	}
	return len(p), nil
}

func (b *limitedBuffer) Len() int {
	return b.buf.Len()
}

func (b *limitedBuffer) String() string {
	return b.buf.String()
}

var _ io.Writer = (*limitedBuffer)(nil)
