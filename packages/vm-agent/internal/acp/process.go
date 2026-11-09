// Package acp provides the ACP gateway that bridges WebSocket connections to
// agent subprocess stdio (NDJSON) for the Agent Client Protocol.
package acp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
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

	// DefaultContainerSignalTimeout bounds each Docker process inspection/signal.
	// Override via ProcessConfig.ContainerSignalTimeout for slower containers.
	DefaultContainerSignalTimeout = 3 * time.Second
)

// samEnvFiles are the paths inside the devcontainer where SAM and project
// environment variables are persisted during bootstrap. Both files use
// POSIX single-quoting via shellSingleQuote() — values are written as
// 'value' with embedded single-quotes escaped as '"'"'.
//
// Both are parsed by parseEnvExportLines which handles both quoting styles.
var samEnvFiles = []string{
	"/etc/sam/env",         // SAM platform vars (SAM_WORKSPACE_ID, etc.) — single-quoted
	"/etc/sam/project-env", // Project-specific vars configured by the user — single-quoted
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

// parseEnvExportLines parses shell `export KEY="value"` and `export KEY='value'`
// lines into KEY=value pairs. Single-quoted values are unescaped by reversing
// the shellSingleQuote() encoding (replacing `'"'"'` back to `'`).
func parseEnvExportLines(content string) []string {
	var result []string
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		// Strip "export " prefix
		line = strings.TrimPrefix(line, "export ")
		// Parse KEY="value", KEY='value', or KEY=value
		eqIdx := strings.Index(line, "=")
		if eqIdx <= 0 {
			continue
		}
		key := line[:eqIdx]
		value := line[eqIdx+1:]
		// Unquote if surrounded by double quotes
		if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
			value = value[1 : len(value)-1]
		} else if len(value) >= 2 && value[0] == '\'' && value[len(value)-1] == '\'' {
			// Unquote single-quoted values and reverse shellSingleQuote() escaping:
			// shellSingleQuote() replaces ' with '"'"', so we reverse that here.
			value = value[1 : len(value)-1]
			value = strings.ReplaceAll(value, "'\"'\"'", "'")
		}
		result = append(result, key+"="+value)
	}
	return result
}

// secretEnvNames are well-known secret environment variable names that must
// not appear in docker exec command-line arguments (visible in /proc/*/cmdline).
var secretEnvNames = map[string]bool{
	"ANTHROPIC_API_KEY":       true,
	"ANTHROPIC_AUTH_TOKEN":    true,
	"CLAUDE_CODE_OAUTH_TOKEN": true,
	"OPENAI_API_KEY":          true,
	"GH_TOKEN":                true,
	"GEMINI_API_KEY":          true,
	"MISTRAL_API_KEY":         true,
	"OPENCODE_CONFIG_CONTENT": true,
	"OPENCODE_API_KEY":        true,
}

// secretEnvSubstrings are substrings in env var names that indicate a secret.
var secretEnvSubstrings = []string{"_KEY", "_TOKEN", "_SECRET"}

// isSecretEnvVar returns true if the KEY=VALUE entry contains a secret that
// should not be exposed in command-line arguments.
func isSecretEnvVar(entry string) bool {
	eqIdx := strings.Index(entry, "=")
	if eqIdx <= 0 {
		return false
	}
	name := entry[:eqIdx]
	if secretEnvNames[name] {
		return true
	}
	upper := strings.ToUpper(name)
	for _, sub := range secretEnvSubstrings {
		if strings.Contains(upper, sub) {
			return true
		}
	}
	return false
}

// envFileDir is the directory used for temporary env files. /dev/shm is a
// tmpfs on Linux — files never hit disk. Overridable in tests.
var envFileDir = "/dev/shm"

// writeSecretEnvFile writes secret env vars to a temp file suitable for
// docker exec --env-file. Returns the file path, or an error.
func writeSecretEnvFile(secrets []string) (string, error) {
	// Generate a unique filename
	var idBytes [8]byte
	if _, err := rand.Read(idBytes[:]); err != nil {
		return "", fmt.Errorf("failed to generate random id: %w", err)
	}
	fileName := fmt.Sprintf("sam-env-%s", hex.EncodeToString(idBytes[:]))
	filePath := envFileDir + "/" + fileName

	// Write with mode 0600 — owner-only read/write
	if err := os.WriteFile(filePath, []byte(strings.Join(secrets, "\n")+"\n"), 0600); err != nil {
		return "", fmt.Errorf("failed to write env file: %w", err)
	}
	return filePath, nil
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
// The host docker client has its own process group. Container processes use a
// distinct launch marker and PID/starttime identities; host PGIDs do not cross
// the container PID namespace.
type AgentProcess struct {
	agentType              string
	cmd                    *exec.Cmd
	stdin                  io.WriteCloser
	stdout                 io.ReadCloser
	stderr                 io.ReadCloser
	containerID            string
	containerOwner         string
	containerSessionID     int
	containerSessionStart  string
	containerTargets       map[int]string
	containerSignalTimeout time.Duration
	startTime              time.Time
	stopGracePeriod        time.Duration
	stopTimeout            time.Duration
	mu                     sync.Mutex
	stopped                bool
	recoveryMu             sync.Mutex
	recoveryNotify         recoveryNotify

	// envFilePath is the tmpfs-backed file containing secret env vars.
	// Cleaned up after the process exits (in Wait) rather than immediately
	// after cmd.Start(), because the docker CLI reads the file asynchronously
	// after the process is forked.
	envFilePath string

	// waitOnce ensures cmd.Wait() is called exactly once; both Stop() and
	// monitorProcessExit call Wait(), and Go's exec.Cmd panics or returns
	// ECHILD on the second call.
	waitOnce sync.Once
	waitErr  error
	waitDone chan struct{} // closed when cmd.Wait() returns
}

// ProcessLauncher starts an ACP agent process. The docker implementation keeps
// the existing devcontainer behavior; the local implementation is used by the
// Cloudflare Container standalone spike.
type ProcessLauncher interface {
	Start(ProcessConfig) (*AgentProcess, error)
}

type DockerExecLauncher struct{}

func (DockerExecLauncher) Start(cfg ProcessConfig) (*AgentProcess, error) {
	return startProcessWithMode(cfg, true)
}

type LocalLauncher struct{}

func (LocalLauncher) Start(cfg ProcessConfig) (*AgentProcess, error) {
	return startProcessWithMode(cfg, false)
}

// ProcessConfig holds configuration for spawning an agent process.
type ProcessConfig struct {
	// ContainerID is the Docker container to exec into.
	ContainerID string
	// ContainerUser is the user to run as inside the container.
	ContainerUser string
	// AcpCommand is the binary name (e.g., "claude-agent-acp").
	AcpCommand string
	// AcpArgs are additional CLI arguments (e.g., ["--acp"]).
	AcpArgs []string
	// EnvVars are environment variables to set (e.g., "ANTHROPIC_API_KEY=sk-...").
	EnvVars []string
	// SecretEnvKeys marks env var names that must be treated as secret even if
	// their names do not match SAM's secret-name heuristic.
	SecretEnvKeys map[string]bool
	// WorkDir is the working directory inside the container.
	WorkDir string
	// StopGracePeriod is how long Stop() waits after SIGTERM before SIGKILL.
	// Zero uses DefaultStopGracePeriod.
	StopGracePeriod time.Duration
	// ContainerSignalTimeout bounds each container inspection/signal command.
	// Zero uses DefaultContainerSignalTimeout.
	ContainerSignalTimeout time.Duration
	// StopTimeout bounds the host-process exit wait. Zero uses DefaultStopTimeout.
	StopTimeout time.Duration
}

// StartProcess spawns an agent process inside the devcontainer.
// The process communicates via NDJSON over stdin/stdout.
// The Docker client has a host process group; container ownership is established
// separately by a kernel session and per-launch marker.
func StartProcess(cfg ProcessConfig) (*AgentProcess, error) {
	return DockerExecLauncher{}.Start(cfg)
}

func StartLocalProcess(cfg ProcessConfig) (*AgentProcess, error) {
	return LocalLauncher{}.Start(cfg)
}

func startProcessWithMode(cfg ProcessConfig, dockerExec bool) (*AgentProcess, error) {
	if dockerExec {
		return startDockerExecProcess(cfg)
	}
	return startLocalProcess(cfg)
}

type processPipes struct {
	stdin  io.WriteCloser
	stdout io.ReadCloser
	stderr io.ReadCloser
}

func splitProcessEnvVars(envVars []string, explicitSecretKeys map[string]bool) (secrets []string, nonSecrets []string) {
	for _, env := range envVars {
		key, _, ok := strings.Cut(env, "=")
		explicitSecret := ok && explicitSecretKeys != nil && explicitSecretKeys[key]
		if explicitSecret || isSecretEnvVar(env) {
			secrets = append(secrets, env)
		} else {
			nonSecrets = append(nonSecrets, env)
		}
	}
	return secrets, nonSecrets
}

func buildDockerExecArgs(cfg ProcessConfig) ([]string, string, error) {
	args := []string{"exec", "-i"}

	if cfg.ContainerUser != "" {
		args = append(args, "-u", cfg.ContainerUser)
	}
	if cfg.WorkDir != "" {
		args = append(args, "-w", cfg.WorkDir)
	}

	// Separate secret env vars from non-secret ones. Secrets are written to
	// a tmpfs-backed file and passed via --env-file to avoid exposing them
	// in /proc/<pid>/cmdline on the host.
	secrets, nonSecrets := splitProcessEnvVars(cfg.EnvVars, cfg.SecretEnvKeys)

	for _, env := range nonSecrets {
		args = append(args, "-e", env)
	}

	// Write secrets to env file. Failing here is fatal — falling back to -e flags
	// would expose secrets in the process table (visible via `ps`).
	var envFilePath string
	if len(secrets) > 0 {
		path, err := writeSecretEnvFile(secrets)
		if err != nil {
			return nil, "", fmt.Errorf("failed to write secret env file: %w", err)
		}
		envFilePath = path
		args = append(args, "--env-file", envFilePath)
	}

	args = append(args, cfg.ContainerID, cfg.AcpCommand)
	args = append(args, cfg.AcpArgs...)
	return args, envFilePath, nil
}

func openProcessPipes(cmd *exec.Cmd, envFilePath string) (processPipes, error) {
	stdin, err := cmd.StdinPipe()
	if err != nil {
		removeEnvFile(envFilePath)
		return processPipes{}, fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		removeEnvFile(envFilePath)
		return processPipes{}, fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		stdin.Close()
		stdout.Close()
		removeEnvFile(envFilePath)
		return processPipes{}, fmt.Errorf("failed to create stderr pipe: %w", err)
	}
	return processPipes{stdin: stdin, stdout: stdout, stderr: stderr}, nil
}

func closeProcessPipes(pipes processPipes) {
	if pipes.stdin != nil {
		pipes.stdin.Close()
	}
	if pipes.stdout != nil {
		pipes.stdout.Close()
	}
	if pipes.stderr != nil {
		pipes.stderr.Close()
	}
}

func removeEnvFile(path string) {
	if path != "" {
		os.Remove(path)
	}
}

func startDockerExecProcess(cfg ProcessConfig) (*AgentProcess, error) {
	// Per-launch identity survives adapter exec wrappers and ordinary child forks.
	var ownerBytes [16]byte
	if _, err := rand.Read(ownerBytes[:]); err != nil {
		return nil, fmt.Errorf("generate container process ownership: %w", err)
	}
	owner := hex.EncodeToString(ownerBytes[:])
	cfg.EnvVars = mergeProcessEnv(cfg.EnvVars, []string{containerOwnerEnv + "=" + owner})
	launchCfg := cfg
	launchCfg.AcpCommand = "setsid"
	launchCfg.AcpArgs = append([]string{"--wait", "sh", "-c", containerSessionLaunchScript, "sam-acp-session", cfg.AcpCommand}, cfg.AcpArgs...)
	args, envFilePath, err := buildDockerExecArgs(launchCfg)
	if err != nil {
		return nil, err
	}

	cmd := exec.Command("docker", args...)

	// Place the process in its own process group so we can signal the entire
	// tree (docker exec CLI + its children) via negative PGID in Stop().
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	pipes, err := openProcessPipes(cmd, envFilePath)
	if err != nil {
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		closeProcessPipes(pipes)
		removeEnvFile(envFilePath)
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

	process := &AgentProcess{
		agentType:              cfg.AcpCommand,
		cmd:                    cmd,
		stdin:                  pipes.stdin,
		stdout:                 pipes.stdout,
		stderr:                 pipes.stderr,
		containerID:            cfg.ContainerID,
		containerOwner:         owner,
		containerSignalTimeout: cfg.ContainerSignalTimeout,
		envFilePath:            envFilePath,
		startTime:              time.Now(),
		stopGracePeriod:        gracePeriod,
		stopTimeout:            stopTimeout,
		waitDone:               make(chan struct{}),
	}
	if err := process.awaitContainerSession(); err != nil {
		_ = process.Stop()
		return nil, err
	}
	return process, nil
}

func startLocalProcess(cfg ProcessConfig) (*AgentProcess, error) {
	if cfg.WorkDir != "" {
		// In standalone (cf-container) mode the vm-agent owns the local
		// filesystem and there is no devcontainer to create the workspace
		// mount, so the configured work dir (derived as /workspaces/<repo>)
		// may not exist. Create it before resolving or starting the adapter.
		if err := os.MkdirAll(cfg.WorkDir, 0o755); err != nil {
			return nil, fmt.Errorf("failed to ensure local work dir %q: %w", cfg.WorkDir, err)
		}
	}
	processEnv := mergeProcessEnv(os.Environ(), cfg.EnvVars)
	command := resolveLocalProcessCommand(cfg.AcpCommand, processEnv)
	cmd := exec.Command(command, cfg.AcpArgs...)
	cmd.Env = processEnv
	if cfg.WorkDir != "" {
		cmd.Dir = cfg.WorkDir
	}
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
		return nil, fmt.Errorf("failed to start local agent process: %w", err)
	}

	slog.Info("ACP local agent process started", "command", cfg.AcpCommand, "pid", cmd.Process.Pid)

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
		startTime:       time.Now(),
		stopGracePeriod: gracePeriod,
		stopTimeout:     stopTimeout,
		waitDone:        make(chan struct{}),
	}, nil
}

func resolveLocalProcessCommand(command string, envVars []string) string {
	if command == "" || strings.ContainsRune(command, os.PathSeparator) {
		return command
	}
	pathValue := ""
	for _, entry := range envVars {
		if key, value, ok := strings.Cut(entry, "="); ok && key == "PATH" {
			pathValue = value
		}
	}
	for _, dir := range filepath.SplitList(pathValue) {
		// Keep Go's ErrDot protection: profile runtime environments may select
		// an explicit absolute adapter directory, but an empty or relative PATH
		// entry must never make a repository executable implicit authority.
		if !filepath.IsAbs(dir) {
			continue
		}
		candidate := filepath.Join(dir, command)
		info, err := os.Stat(candidate)
		if err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0 {
			return candidate
		}
	}
	return command
}

func mergeProcessEnv(ambient, overrides []string) []string {
	overrideValues := make(map[string]string, len(overrides))
	overrideOrder := make([]string, 0, len(overrides))
	for _, entry := range overrides {
		key, _, ok := strings.Cut(entry, "=")
		if !ok || key == "" {
			continue
		}
		if _, exists := overrideValues[key]; !exists {
			overrideOrder = append(overrideOrder, key)
		}
		overrideValues[key] = entry
	}

	merged := make([]string, 0, len(ambient)+len(overrideOrder))
	for _, entry := range ambient {
		key, _, ok := strings.Cut(entry, "=")
		if ok {
			if _, overridden := overrideValues[key]; overridden {
				continue
			}
		}
		merged = append(merged, entry)
	}
	for _, key := range overrideOrder {
		merged = append(merged, overrideValues[key])
	}
	return merged
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

// Stop gracefully terminates the agent process using a multi-stage sequence:
//  1. Close stdin to signal the agent to exit on its own.
//  2. Send SIGTERM inside the container to the actual agent processes.
//     Killing only the host-side `docker exec` process (via PGID signals)
//     does NOT terminate the processes inside the container — they run in
//     a separate PID namespace and will keep consuming resources.
//  3. Send SIGTERM to the host-side process group to clean up docker exec.
//  4. If still running after grace period, SIGKILL both inside and outside.
//
// Docker commands have a configurable per-command deadline; the host-process
// exit wait is bounded by stopTimeout.
func (p *AgentProcess) Stop() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.stopped {
		return nil
	}
	p.stopped = true

	pid := 0
	if p.cmd != nil && p.cmd.Process != nil {
		pid = p.cmd.Process.Pid
	}
	slog.Info("Stopping ACP agent process", "agentType", p.agentType, "pid", pid, "container", p.containerID)

	// Capture descendants before EOF can make their marked parent exit. Retain
	// PID/starttime identities across TERM so reparented, env-cleared children
	// remain owned during escalation.
	cleanupErr := p.captureContainerProcesses()
	// Close stdin to signal the agent to exit gracefully.
	if p.stdin != nil {
		p.stdin.Close()
	}

	if p.cmd == nil || p.cmd.Process == nil {
		// No host process, but container processes may still be running.
		return errors.Join(cleanupErr, p.killContainerProcesses(syscall.SIGKILL))
	}

	// Trigger the Wait-once machinery so waitDone closes when the process exits.
	// This also starts cmd.Wait() if it hasn't been called yet.
	go func() { _ = p.Wait() }()
	waitCh := p.waitDone

	// Bound the host-process exit wait; Docker commands have separate deadlines.
	deadline := time.NewTimer(p.stopTimeout)
	defer deadline.Stop()

	// Stage 1: SIGTERM inside the container. This is the critical step —
	// the agent processes (claude-agent-acp, claude) run inside the container's
	// PID namespace. Host-side PGID signals only affect docker exec itself.
	cleanupErr = errors.Join(cleanupErr, p.killContainerProcesses(syscall.SIGTERM))

	// Stage 2: SIGTERM to host-side process group — cleans up the docker exec CLI.
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
		// docker exec exiting does not prove its container descendants exited.
		return errors.Join(cleanupErr, p.killContainerProcesses(syscall.SIGKILL))
	case <-graceTimer.C:
		slog.Warn("Agent process did not exit within grace period, sending SIGKILL",
			"agentType", p.agentType, "pid", pid, "gracePeriod", p.stopGracePeriod)
	case <-deadline.C:
		slog.Error("Agent process stop deadline reached during SIGTERM phase, sending SIGKILL",
			"agentType", p.agentType, "pid", pid)
	}

	// Stage 3: SIGKILL inside the container, then to host-side process group.
	cleanupErr = errors.Join(cleanupErr, p.killContainerProcesses(syscall.SIGKILL))
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
		return errors.Join(cleanupErr, fmt.Errorf("agent process %d did not exit within %s", pid, p.stopTimeout))
	}

	return cleanupErr
}

// Wait waits for the agent process to exit and returns the error (if any).
// Safe to call from multiple goroutines — cmd.Wait() is invoked exactly once.
// Also cleans up the tmpfs-backed secret env file if one was created.
func (p *AgentProcess) Wait() error {
	p.waitOnce.Do(func() {
		p.waitErr = p.cmd.Wait()
		// Clean up the secret env file now that the process has exited.
		// We defer this to Wait() rather than doing it right after cmd.Start()
		// because the docker CLI reads --env-file asynchronously after fork.
		if p.envFilePath != "" {
			if removeErr := os.Remove(p.envFilePath); removeErr != nil && !os.IsNotExist(removeErr) {
				slog.Warn("Failed to remove secret env file", "path", p.envFilePath, "error", removeErr)
			}
		}
		close(p.waitDone)
	})
	<-p.waitDone
	return p.waitErr
}
