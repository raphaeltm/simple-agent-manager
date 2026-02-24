// Package acp provides the ACP gateway that bridges WebSocket connections to
// agent subprocess stdio (NDJSON) for the Agent Client Protocol.
package acp

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// DefaultStopGracePeriod is how long Stop() waits after SIGTERM before
	// escalating to SIGKILL. Configurable via ProcessConfig.StopGracePeriod.
	DefaultStopGracePeriod = 5 * time.Second

	// DefaultStopTimeout is the total time Stop() is allowed to take before
	// giving up. Configurable via ProcessConfig.StopTimeout.
	DefaultStopTimeout = 10 * time.Second
)

// samEnvFiles are the paths inside the devcontainer where SAM and project
// environment variables are persisted during bootstrap. Both use the same
// shell `export KEY="value"` format.
var samEnvFiles = []string{
	"/etc/sam/env",         // SAM platform vars (GH_TOKEN, SAM_WORKSPACE_ID, etc.)
	"/etc/sam/project-env", // Project-specific vars configured by the user
}

// ReadContainerEnvFiles reads SAM env files from inside the container and
// returns parsed KEY=value pairs. The files contain shell `export KEY="value"`
// lines written during bootstrap. Missing files are silently skipped.
func ReadContainerEnvFiles(ctx context.Context, containerID string) []string {
	var result []string
	for _, path := range samEnvFiles {
		cmd := exec.CommandContext(ctx, "docker", "exec", containerID, "cat", path)
		output, err := cmd.Output()
		if err != nil {
			continue
		}
		result = append(result, parseEnvExportLines(string(output))...)
	}
	return result
}

// parseEnvExportLines parses shell `export KEY="value"` lines into KEY=value pairs.
func parseEnvExportLines(content string) []string {
	var result []string
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		// Strip "export " prefix
		line = strings.TrimPrefix(line, "export ")
		// Parse KEY="value" or KEY=value
		eqIdx := strings.Index(line, "=")
		if eqIdx <= 0 {
			continue
		}
		key := line[:eqIdx]
		value := line[eqIdx+1:]
		// Unquote if surrounded by double quotes
		if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
			value = value[1 : len(value)-1]
		}
		result = append(result, key+"="+value)
	}
	return result
}

// hasEnvVar checks whether a KEY=value list contains a non-empty value for key.
func hasEnvVar(envVars []string, key string) bool {
	prefix := key + "="
	for _, entry := range envVars {
		if strings.HasPrefix(entry, prefix) && len(entry) > len(prefix) {
			return true
		}
	}
	return false
}

// AgentProcess manages an ACP-compliant agent subprocess running inside the
// devcontainer via docker exec. It pipes stdin/stdout for NDJSON communication.
//
// The process is started in its own process group (Setpgid) so that Stop()
// can reliably kill the entire process tree (docker exec + child processes)
// using a negative PGID signal.
type AgentProcess struct {
	agentType        string
	cmd              *exec.Cmd
	stdin            io.WriteCloser
	stdout           io.ReadCloser
	stderr           io.ReadCloser
	containerID      string
	startTime        time.Time
	stopGracePeriod  time.Duration
	stopTimeout      time.Duration
	mu               sync.Mutex
	stopped          bool
}

// ProcessConfig holds configuration for spawning an agent process.
type ProcessConfig struct {
	// ContainerID is the Docker container to exec into.
	ContainerID string
	// ContainerUser is the user to run as inside the container.
	ContainerUser string
	// AcpCommand is the binary name (e.g., "claude-code-acp").
	AcpCommand string
	// AcpArgs are additional CLI arguments (e.g., ["--experimental-acp"]).
	AcpArgs []string
	// EnvVars are environment variables to set (e.g., "ANTHROPIC_API_KEY=sk-...").
	EnvVars []string
	// WorkDir is the working directory inside the container.
	WorkDir string
	// StopGracePeriod is how long Stop() waits after SIGTERM before SIGKILL.
	// Zero uses DefaultStopGracePeriod.
	StopGracePeriod time.Duration
	// StopTimeout is the total time Stop() may take. Zero uses DefaultStopTimeout.
	StopTimeout time.Duration
}

// StartProcess spawns an agent process inside the devcontainer.
// The process communicates via NDJSON over stdin/stdout.
// The process is placed in its own process group (Setpgid) so that Stop()
// can signal the entire tree reliably.
func StartProcess(cfg ProcessConfig) (*AgentProcess, error) {
	// Build docker exec command: docker exec -i [-u user] [-w dir] [-e VAR=val...] container command args...
	args := []string{"exec", "-i"}

	if cfg.ContainerUser != "" {
		args = append(args, "-u", cfg.ContainerUser)
	}
	if cfg.WorkDir != "" {
		args = append(args, "-w", cfg.WorkDir)
	}
	for _, env := range cfg.EnvVars {
		args = append(args, "-e", env)
	}

	args = append(args, cfg.ContainerID, cfg.AcpCommand)
	args = append(args, cfg.AcpArgs...)

	cmd := exec.Command("docker", args...)

	// Place the process in its own process group so we can signal the entire
	// tree (docker exec CLI + its children) via negative PGID in Stop().
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return nil, fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		stdin.Close()
		stdout.Close()
		return nil, fmt.Errorf("failed to create stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		stderr.Close()
		return nil, fmt.Errorf("failed to start agent process: %w", err)
	}

	slog.Info("ACP agent process started", "command", cfg.AcpCommand, "container", cfg.ContainerID, "pid", cmd.Process.Pid)

	gracePeriod := cfg.StopGracePeriod
	if gracePeriod <= 0 {
		gracePeriod = DefaultStopGracePeriod
	}
	stopTimeout := cfg.StopTimeout
	if stopTimeout <= 0 {
		stopTimeout = DefaultStopTimeout
	}

	return &AgentProcess{
		agentType:       cfg.AcpCommand,
		cmd:             cmd,
		stdin:           stdin,
		stdout:          stdout,
		stderr:          stderr,
		containerID:     cfg.ContainerID,
		startTime:       time.Now(),
		stopGracePeriod: gracePeriod,
		stopTimeout:     stopTimeout,
	}, nil
}

// Stdin returns the writer to the agent's stdin (for sending NDJSON).
func (p *AgentProcess) Stdin() io.Writer {
	return p.stdin
}

// Stdout returns the reader from the agent's stdout (for reading NDJSON).
func (p *AgentProcess) Stdout() io.Reader {
	return p.stdout
}

// Stderr returns the reader from the agent's stderr (for error monitoring).
func (p *AgentProcess) Stderr() io.Reader {
	return p.stderr
}

// Stop gracefully terminates the agent process using a three-stage sequence:
//  1. Close stdin to signal the agent to exit on its own.
//  2. Send SIGTERM to the process group (negative PGID) and wait up to
//     stopGracePeriod for a clean exit.
//  3. If still running, send SIGKILL to the process group.
//
// The entire operation is bounded by stopTimeout so Stop() never blocks
// indefinitely.
func (p *AgentProcess) Stop() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.stopped {
		return nil
	}
	p.stopped = true

	pid := 0
	if p.cmd.Process != nil {
		pid = p.cmd.Process.Pid
	}
	slog.Info("Stopping ACP agent process", "agentType", p.agentType, "pid", pid)

	// Close stdin first to signal the agent to exit gracefully.
	p.stdin.Close()

	if p.cmd.Process == nil {
		return nil
	}

	// waitCh is closed when cmd.Wait() returns. We use it to detect when the
	// process has actually exited, avoiding busy-polling.
	waitCh := make(chan struct{})
	go func() {
		_ = p.cmd.Wait()
		close(waitCh)
	}()

	// Overall deadline — Stop() must not block longer than this.
	deadline := time.NewTimer(p.stopTimeout)
	defer deadline.Stop()

	// Stage 1: SIGTERM to process group — gives the process a chance to
	// clean up (flush buffers, write state, etc.).
	pgid := pid
	if err := syscall.Kill(-pgid, syscall.SIGTERM); err != nil {
		slog.Warn("SIGTERM to process group failed", "pgid", pgid, "error", err)
	}

	// Wait for graceful exit or grace period expiry.
	graceTimer := time.NewTimer(p.stopGracePeriod)
	defer graceTimer.Stop()

	select {
	case <-waitCh:
		slog.Info("Agent process exited after SIGTERM", "agentType", p.agentType, "pid", pid)
		return nil
	case <-graceTimer.C:
		slog.Warn("Agent process did not exit within grace period, sending SIGKILL",
			"agentType", p.agentType, "pid", pid, "gracePeriod", p.stopGracePeriod)
	case <-deadline.C:
		slog.Error("Agent process stop deadline reached during SIGTERM phase, sending SIGKILL",
			"agentType", p.agentType, "pid", pid)
	}

	// Stage 2: SIGKILL to process group — forceful termination.
	if err := syscall.Kill(-pgid, syscall.SIGKILL); err != nil {
		slog.Warn("SIGKILL to process group failed", "pgid", pgid, "error", err)
	}

	// Wait for the process to actually exit (or deadline).
	select {
	case <-waitCh:
		slog.Info("Agent process exited after SIGKILL", "agentType", p.agentType, "pid", pid)
	case <-deadline.C:
		slog.Error("Agent process did not exit after SIGKILL within deadline",
			"agentType", p.agentType, "pid", pid, "timeout", p.stopTimeout)
		return fmt.Errorf("agent process %d did not exit within %s", pid, p.stopTimeout)
	}

	return nil
}

// Wait waits for the agent process to exit and returns the error (if any).
func (p *AgentProcess) Wait() error {
	return p.cmd.Wait()
}
