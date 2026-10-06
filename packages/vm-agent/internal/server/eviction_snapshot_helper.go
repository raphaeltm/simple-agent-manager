package server

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"

	"github.com/workspace/vm-agent/internal/container"
	"github.com/workspace/vm-agent/internal/resourcemon"
)

func noopSnapshotHelperCleanup() {
	// No helper resources exist when snapshot-helper setup fails.
}

// startExitedEvictionSnapshotHelper mounts an exact stopped OOM victim's
// volumes into a short-lived container created from that victim's writable
// layer. The original entrypoint never runs, while the ordinary snapshot code
// can still capture HOME and the worktree through docker exec.
func (s *Server) startExitedEvictionSnapshotHelper(ctx context.Context, target resourcemon.EvictionTarget, runtime *WorkspaceRuntime) (*containerSnapshotTarget, func(), error) {
	if err := s.verifyExitedOOMContainer(ctx, target.ContainerID); err != nil {
		return nil, noopSnapshotHelperCleanup, err
	}
	suffix := randomEventID()
	image := "sam-eviction-snapshot:" + suffix
	name := "sam-eviction-snapshot-" + suffix
	cleanup := func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), s.config.EvictionSnapshotTimeout)
		defer cancel()
		if _, err := s.runEvictionDockerCommand(cleanupCtx, "rm", "--force", "--volumes", name); err != nil {
			slog.Warn("Failed to remove OOM snapshot helper container", "name", name, "error", err)
		}
		if _, err := s.runEvictionDockerCommand(cleanupCtx, "image", "rm", "--force", image); err != nil {
			slog.Warn("Failed to remove OOM snapshot helper image", "image", image, "error", err)
		}
	}

	if _, err := s.runEvictionDockerCommand(ctx, "commit", target.ContainerID, image); err != nil {
		return nil, noopSnapshotHelperCleanup, fmt.Errorf("commit stopped OOM container for snapshot: %w", err)
	}
	helperID, err := s.runEvictionDockerCommand(ctx,
		"create",
		"--name", name,
		"--label", s.config.ContainerLabelKey+"=sam-eviction-snapshot-helper",
		"--volumes-from", target.ContainerID,
		"--network", "none",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--entrypoint", "/bin/sh",
		image,
		"-c", "exec tail -f /dev/null",
	)
	if err != nil {
		cleanup()
		return nil, noopSnapshotHelperCleanup, fmt.Errorf("create stopped OOM snapshot helper: %w", err)
	}
	helperID = strings.TrimSpace(helperID)
	if !isValidContainerID(helperID) {
		cleanup()
		return nil, noopSnapshotHelperCleanup, fmt.Errorf("stopped OOM snapshot helper identity unavailable")
	}
	if _, err := s.runEvictionDockerCommand(ctx, "start", helperID); err != nil {
		cleanup()
		return nil, noopSnapshotHelperCleanup, fmt.Errorf("start stopped OOM snapshot helper: %w", err)
	}
	return &containerSnapshotTarget{
		containerID: helperID,
		workDir:     runtime.ContainerWorkDir,
		user:        runtime.ContainerUser,
	}, cleanup, nil
}

func (s *Server) verifyExitedOOMContainer(ctx context.Context, containerID string) error {
	state, err := s.runEvictionDockerCommand(
		ctx,
		"inspect",
		"--format", "{{.State.Running}} {{.State.OOMKilled}} {{.State.ExitCode}}",
		containerID,
	)
	if err != nil {
		return fmt.Errorf("inspect OOM snapshot source: %w", err)
	}
	fields := strings.Fields(state)
	if len(fields) != 3 || fields[0] != "false" || (fields[1] != "true" && fields[2] != "137") {
		return fmt.Errorf("OOM snapshot source is not an exited OOM container")
	}
	return nil
}

func (s *Server) runEvictionDockerCommand(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, container.DockerCLIPath(), args...)
	cmd.WaitDelay = s.config.EvictionResolveTimeout
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return "", fmt.Errorf("docker %s failed: %s", args[0], message)
	}
	return strings.TrimSpace(stdout.String()), nil
}
