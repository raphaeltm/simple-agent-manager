package acp

import (
	"context"
	_ "embed"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

//go:embed codex_runtime_installer.sh
var codexRuntimeInstaller string

const codexRuntimeArchiveSHA = "1fd3c07846581888284ed9c9d02bc1f51e3673610c3688d8da98db47030bfb95"
const codexRuntimeArchiveBytes = 136245837

var codexRuntimeHostPattern = regexp.MustCompile(`^[a-zA-Z0-9.-]+$`)

func codexRuntimeInstallScript(controlPlaneURL string, budget, killGrace time.Duration) (string, error) {
	origin, err := url.Parse(controlPlaneURL)
	if err != nil || origin.Host == "" || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" || (origin.Path != "" && origin.Path != "/") || !codexRuntimeHostPattern.MatchString(origin.Hostname()) {
		return "", fmt.Errorf("invalid runtime artifact origin")
	}
	if origin.Scheme != "https" && !(origin.Scheme == "http" && (origin.Hostname() == "127.0.0.1" || origin.Hostname() == "localhost")) {
		return "", fmt.Errorf("runtime artifact origin requires HTTPS")
	}
	if budget <= 0 {
		budget = config.DefaultCodexRuntimeInstallTimeout
	}
	if killGrace <= 0 {
		killGrace = config.DefaultCodexRuntimeInstallKillGrace
	}
	seconds := strconv.FormatFloat(budget.Seconds(), 'f', -1, 64)
	graceSeconds := strconv.FormatFloat(killGrace.Seconds(), 'f', -1, 64)
	origin.Path = "/api/acp/codex-runtime/download"
	origin.RawQuery = url.Values{"release": {codexRuntimeArchiveSHA}, "os": {"linux"}, "arch": {"amd64"}}.Encode()
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }
	script := "set -eu\n[[ -d /tmp && ! -L /tmp && $(stat -c %u /tmp) == 0 ]]\nmode=$(stat -c %a /tmp)\n(( (8#$mode & 0022) == 0 || (8#$mode & 01000) != 0 ))\nwork=$(mktemp -d /tmp/sam-codex-fetch.XXXXXX)\ntrap 'rm -rf -- \"$work\"' EXIT\n"
	script += fmt.Sprintf("curl --fail --silent --show-error --max-time %s --max-filesize %d --output \"$work/runtime.tar.gz\" %s\n", seconds, codexRuntimeArchiveBytes, quote(origin.String()))
	script += "cat >\"$work/install.sh\" <<'SAM_PINNED_CODEX_INSTALLER'\n" + codexRuntimeInstaller + "\nSAM_PINNED_CODEX_INSTALLER\n"
	script += "bash \"$work/install.sh\" \"$work/runtime.tar.gz\" " + quote(codexC2ReleaseRoot) + "\n"
	// Killing docker's client alone does not stop exec processes in the container.
	// This independent deadline also bounds work after the host context is cancelled.
	return "timeout --kill-after=" + graceSeconds + " " + seconds + " bash -c " + quote(script), nil
}

func (h *SessionHost) ensureCodexRuntimeInContainer(ctx context.Context, containerID string, info agentCommandInfo) error {
	dockerPath, err := trustedCodexRuntimeDocker()
	if err != nil {
		return err
	}
	budget := h.config.CodexRuntimeInstallTimeout
	if budget <= 0 {
		budget = config.DefaultCodexRuntimeInstallTimeout
	}
	killGrace := h.config.CodexRuntimeInstallKillGrace
	if killGrace <= 0 {
		killGrace = config.DefaultCodexRuntimeInstallKillGrace
	}
	bounded, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	// Construct each command only when it is about to run. Queueing and prior
	// verification consume the same budget; docker client cancellation alone
	// cannot stop an exec process already started inside the container.
	run := func(root bool, install bool) error {
		if err := bounded.Err(); err != nil {
			return err
		}
		deadline, _ := bounded.Deadline()
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return context.DeadlineExceeded
		}
		script := codexRuntimeBoundedCommand(info.validationCmd, remaining, killGrace)
		if install {
			var err error
			script, err = codexRuntimeInstallScript(h.config.ControlPlaneURL, remaining, killGrace)
			if err != nil {
				return err
			}
		}
		args := []string{"exec"}
		if root {
			args = append(args, "-u", "root")
		}
		args = append(args, containerID, "sh", "-c", script)
		return exec.CommandContext(bounded, dockerPath, args...).Run()
	}
	if err := run(false, false); err == nil {
		return nil
	}
	// Share the global installation gate with stock agent installers.
	release, err := acquireAgentInstall(bounded)
	if err != nil {
		return err
	}
	defer release()
	if err := run(false, false); err == nil {
		return nil
	}
	if err := run(true, true); err != nil {
		return fmt.Errorf("Codex runtime installation failed: %w", err)
	}
	if err := run(false, false); err != nil {
		return fmt.Errorf("installed Codex runtime verification failed: %w", err)
	}
	return nil
}

// Resolve once before execution, then reject a PATH shadow whose bytes or parent
// directories another user can replace. Execute the resolved absolute path so
// subsequent PATH changes cannot select a different privileged Docker client.
func trustedCodexRuntimeDocker() (string, error) {
	path, err := exec.LookPath("docker")
	if err != nil {
		return "", fmt.Errorf("resolve runtime Docker client: %w", err)
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return "", err
	}
	for current := path; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil {
			return "", err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || (stat.Uid != 0 && stat.Uid != uint32(os.Geteuid())) {
			return "", fmt.Errorf("untrusted runtime Docker path owner: %s", current)
		}
		stickyRoot := info.IsDir() && stat.Uid == 0 && info.Mode()&os.ModeSticky != 0
		if info.Mode().Perm()&0022 != 0 && !stickyRoot {
			return "", fmt.Errorf("writable runtime Docker path: %s", current)
		}
		if (current == path && !info.Mode().IsRegular()) || (current != path && !info.IsDir()) {
			return "", fmt.Errorf("invalid runtime Docker path type: %s", current)
		}
		if current == filepath.Dir(current) {
			return path, nil
		}
	}
}

func codexRuntimeBoundedCommand(script string, budget, killGrace time.Duration) string {
	seconds := strconv.FormatFloat(budget.Seconds(), 'f', -1, 64)
	grace := strconv.FormatFloat(killGrace.Seconds(), 'f', -1, 64)
	quoted := "'" + strings.ReplaceAll(script, "'", "'\"'\"'") + "'"
	return "timeout --kill-after=" + grace + " " + seconds + " bash -c " + quoted
}
