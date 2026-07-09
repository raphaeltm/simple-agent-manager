package server

import (
	"context"
	"fmt"
	"os/exec"
)

func (s *Server) isStandaloneWorkspaceExec() bool {
	return s != nil && s.config != nil && s.config.IsStandaloneMode()
}

func (s *Server) workspaceExecCommand(ctx context.Context, containerID, user, workDir string, args ...string) (*exec.Cmd, error) {
	if len(args) == 0 {
		return nil, fmt.Errorf("workspace exec command is required")
	}

	if s.isStandaloneWorkspaceExec() {
		cmd := exec.CommandContext(ctx, args[0], args[1:]...)
		if workDir != "" {
			cmd.Dir = workDir
		}
		return cmd, nil
	}

	dockerArgs := []string{"exec", "-i"}
	if user != "" {
		dockerArgs = append(dockerArgs, "-u", user)
	}
	if workDir != "" {
		dockerArgs = append(dockerArgs, "-w", workDir)
	}
	dockerArgs = append(dockerArgs, containerID)
	dockerArgs = append(dockerArgs, args...)
	return exec.CommandContext(ctx, "docker", dockerArgs...), nil
}
