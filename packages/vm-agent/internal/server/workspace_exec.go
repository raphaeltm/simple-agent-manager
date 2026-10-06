package server

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

const dockerBinaryPath = "/usr/bin/docker"

func (s *Server) isStandaloneWorkspaceExec() bool {
	return s != nil && s.config != nil && s.config.IsStandaloneMode()
}

func standaloneWorkspaceCommandPath(command string) (string, error) {
	switch command {
	case "cat":
		return "/usr/bin/cat", nil
	case "cp":
		return "/usr/bin/cp", nil
	case "find":
		return "/usr/bin/find", nil
	case "gh":
		return "/usr/bin/gh", nil
	case "git":
		return "/usr/bin/git", nil
	case "mkdir":
		return "/usr/bin/mkdir", nil
	case "printenv":
		return "/usr/bin/printenv", nil
	case "pwd":
		return "/usr/bin/pwd", nil
	case "stat":
		return "/usr/bin/stat", nil
	case "rm":
		return "/usr/bin/rm", nil
	case "tar":
		return "/usr/bin/tar", nil
	case "tee":
		return "/usr/bin/tee", nil
	default:
		return "", fmt.Errorf("unsupported standalone workspace command %q", command)
	}
}

func validateWorkspaceExecArgs(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("workspace exec command is required")
	}
	if _, err := standaloneWorkspaceCommandPath(args[0]); err != nil {
		return err
	}
	for _, arg := range args {
		if strings.ContainsRune(arg, '\x00') {
			return fmt.Errorf("workspace exec argument contains NUL byte")
		}
	}
	return nil
}

func dockerWorkspaceExecCommand(ctx context.Context, dockerArgs []string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, dockerBinaryPath)
	cmd.Args = append([]string{dockerBinaryPath}, dockerArgs...)
	return cmd
}

func (s *Server) workspaceExecCommand(ctx context.Context, containerID, user, workDir string, args ...string) (*exec.Cmd, error) {
	return s.workspaceExecCommandWithEnv(ctx, containerID, user, workDir, nil, args...)
}

func (s *Server) workspaceExecCommandWithEnv(ctx context.Context, containerID, user, workDir string, extraEnv []string, args ...string) (*exec.Cmd, error) {
	if err := validateWorkspaceExecArgs(args); err != nil {
		return nil, err
	}
	for _, entry := range extraEnv {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || key == "" || strings.ContainsAny(key, "\x00\r\n") || strings.ContainsAny(value, "\x00\r\n") {
			return nil, fmt.Errorf("invalid workspace exec environment entry")
		}
	}

	if s.isStandaloneWorkspaceExec() {
		commandPath, err := standaloneWorkspaceCommandPath(args[0])
		if err != nil {
			return nil, err
		}
		cmd := exec.CommandContext(ctx, commandPath, args[1:]...)
		if workDir != "" {
			cmd.Dir = workDir
		}
		if len(extraEnv) > 0 {
			cmd.Env = append(os.Environ(), extraEnv...)
		}
		return cmd, nil
	}

	dockerArgs := []string{"exec", "-i"}
	for _, entry := range extraEnv {
		dockerArgs = append(dockerArgs, "-e", entry)
	}
	if user != "" {
		dockerArgs = append(dockerArgs, "-u", user)
	}
	if workDir != "" {
		dockerArgs = append(dockerArgs, "-w", workDir)
	}
	dockerArgs = append(dockerArgs, containerID)
	dockerArgs = append(dockerArgs, args...)
	return dockerWorkspaceExecCommand(ctx, dockerArgs), nil
}
