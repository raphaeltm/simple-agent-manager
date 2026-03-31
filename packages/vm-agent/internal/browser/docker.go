package browser

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
)

// CLIDockerExecutor implements DockerExecutor using the docker CLI.
type CLIDockerExecutor struct{}

// NewCLIDockerExecutor creates a CLI-based Docker executor.
func NewCLIDockerExecutor() *CLIDockerExecutor {
	return &CLIDockerExecutor{}
}

// Run executes a docker command and returns combined output.
func (d *CLIDockerExecutor) Run(ctx context.Context, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "docker", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("docker %v: %w (stderr: %s)", args, err, stderr.String())
	}
	return stdout.Bytes(), nil
}

// RunSilent executes a docker command, returning only the error.
func (d *CLIDockerExecutor) RunSilent(ctx context.Context, args ...string) error {
	cmd := exec.CommandContext(ctx, "docker", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("docker %v: %w (stderr: %s)", args, err, stderr.String())
	}
	return nil
}
