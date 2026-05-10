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

// maxOutputLines is the maximum number of output lines returned from bash.
const maxOutputLines = 200

// defaultDenyPatterns are command patterns rejected for safety.
var defaultDenyPatterns = []string{
	"rm -rf /",
	"rm -rf /*",
	"mkfs",
	"dd if=",
	"chmod -R 777 /",
	":(){:|:&};:",
}

// Bash executes shell commands with timeout and cancellation.
//
// SECURITY: This tool runs arbitrary shell commands with NO sandboxing beyond
// setting the initial working directory. An LLM can execute any command the
// host process can. In production, this tool MUST run inside a container or VM
// with restricted filesystem and network access. This is acceptable for the
// spike because SAM workspaces already run inside isolated DevContainers on VMs.
type Bash struct {
	WorkDir      string
	Timeout      time.Duration // 0 means DefaultBashTimeout
	DenyPatterns []string      // additional deny patterns; nil uses defaults only
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

	// Check command denylist.
	if reason := t.checkDenyList(command); reason != "" {
		return "", fmt.Errorf("command rejected: %s", reason)
	}

	timeout := t.Timeout
	if timeout == 0 {
		timeout = DefaultBashTimeout
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	start := time.Now()
	workDir := filepath.Clean(t.WorkDir)

	cmd := exec.CommandContext(ctx, "bash", "-c", command)
	cmd.Dir = workDir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 2 * time.Second

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err = cmd.Run()
	elapsed := time.Since(start)

	// Kill the entire process group on context cancellation to prevent orphans.
	if ctx.Err() != nil && cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}

	var result strings.Builder
	fmt.Fprintf(&result, "[cwd: %s]\n", workDir)

	if stdout.Len() > 0 {
		result.WriteString(truncateOutput(stdout.String()))
	}
	if stderr.Len() > 0 {
		if stdout.Len() > 0 {
			result.WriteString("\n")
		}
		result.WriteString("STDERR:\n")
		result.WriteString(truncateOutput(stderr.String()))
	}

	// Add timing info.
	fmt.Fprintf(&result, "\n(completed in %s)", formatDuration(elapsed))

	// Timeout warning if command took >80% of the limit.
	if elapsed > time.Duration(float64(timeout)*0.8) && err == nil {
		fmt.Fprintf(&result, "\n⚠ Command used %.0f%% of the %s timeout", float64(elapsed)/float64(timeout)*100, timeout)
	}

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return result.String(), fmt.Errorf("command timed out after %s", timeout)
		}
		if ctx.Err() == context.Canceled {
			return result.String(), fmt.Errorf("command cancelled")
		}
		return fmt.Sprintf("%s\nexit code: %s", result.String(), err.Error()),
			fmt.Errorf("non-zero exit: %w", err)
	}

	if stdout.Len() == 0 && stderr.Len() == 0 {
		return fmt.Sprintf("[cwd: %s]\n(no output)\n(completed in %s)", workDir, formatDuration(elapsed)), nil
	}
	return result.String(), nil
}

// checkDenyList returns a reason string if the command matches a denied pattern.
func (t *Bash) checkDenyList(command string) string {
	patterns := defaultDenyPatterns
	if t.DenyPatterns != nil {
		patterns = append(patterns, t.DenyPatterns...)
	}
	for _, p := range patterns {
		if strings.Contains(command, p) {
			return fmt.Sprintf("%q matches dangerous pattern %q", command, p)
		}
	}
	return ""
}

// truncateOutput limits output to the last maxOutputLines lines.
func truncateOutput(s string) string {
	lines := strings.Split(s, "\n")
	// Remove trailing empty line from final newline.
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	total := len(lines)
	if total <= maxOutputLines {
		return s
	}
	kept := lines[total-maxOutputLines:]
	return fmt.Sprintf("[output truncated — showing last %d lines of %d]\n%s\n",
		maxOutputLines, total, strings.Join(kept, "\n"))
}

// formatDuration formats a duration in a human-readable way.
func formatDuration(d time.Duration) string {
	if d < time.Second {
		return fmt.Sprintf("%.0fms", float64(d)/float64(time.Millisecond))
	}
	return fmt.Sprintf("%.1fs", d.Seconds())
}
