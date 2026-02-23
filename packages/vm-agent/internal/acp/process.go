// Package acp provides the ACP gateway that bridges WebSocket connections to
// agent subprocess stdio (NDJSON) for the Agent Client Protocol.
package acp

import (
	"context"
	"fmt"
	"io"
	"log"
	"os/exec"
	"strings"
	"sync"
	"time"
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

// AgentProcess manages an ACP-compliant agent subprocess running inside the
// devcontainer via docker exec. It pipes stdin/stdout for NDJSON communication.
type AgentProcess struct {
	agentType   string
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	stdout      io.ReadCloser
	stderr      io.ReadCloser
	containerID string
	startTime   time.Time
	mu          sync.Mutex
	stopped     bool
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
}

// StartProcess spawns an agent process inside the devcontainer.
// The process communicates via NDJSON over stdin/stdout.
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

	log.Printf("ACP agent process started: command=%s, container=%s, pid=%d",
		cfg.AcpCommand, cfg.ContainerID, cmd.Process.Pid)

	return &AgentProcess{
		agentType:   cfg.AcpCommand,
		cmd:         cmd,
		stdin:       stdin,
		stdout:      stdout,
		stderr:      stderr,
		containerID: cfg.ContainerID,
		startTime:   time.Now(),
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

// Stop kills the agent process and waits for it to exit.
func (p *AgentProcess) Stop() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.stopped {
		return nil
	}
	p.stopped = true

	log.Printf("Stopping ACP agent process: %s", p.agentType)

	// Close stdin first to signal the agent to exit gracefully
	p.stdin.Close()

	// Kill the process if it hasn't exited
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}

	// Wait for exit (ignore error since we killed it)
	_ = p.cmd.Wait()

	return nil
}

// Wait waits for the agent process to exit and returns the error (if any).
func (p *AgentProcess) Wait() error {
	return p.cmd.Wait()
}
