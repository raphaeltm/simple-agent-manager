package acp

import (
	"context"
	_ "embed" // Required by the go:embed directive below.
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	codexSharedDaemonEnabledEnv          = "SAM_CODEX_SHARED_DAEMON"
	codexSharedDaemonRemoteControlEnv    = "SAM_CODEX_SHARED_DAEMON_REMOTE_CONTROL"
	codexSharedDaemonSocketEnv           = "SAM_CODEX_SHARED_DAEMON_SOCKET"
	codexSharedDaemonOwnerFileEnv        = "SAM_CODEX_SHARED_DAEMON_SOCKET_OWNER_FILE"
	codexSharedDaemonExpectedEnv         = "SAM_CODEX_SHARED_DAEMON_EXPECTED_VERSION"
	codexSharedDaemonCLIEnv              = "SAM_CODEX_SHARED_DAEMON_CLI"
	codexSharedDaemonHandshakeEnv        = "SAM_CODEX_SHARED_DAEMON_HANDSHAKE_TIMEOUT_MS"
	codexSharedDaemonRequestEnv          = "SAM_CODEX_SHARED_DAEMON_REQUEST_TIMEOUT_MS"
	codexSharedDaemonWSBufferEnv         = "SAM_CODEX_SHARED_DAEMON_WS_BUFFER_BYTES"
	codexSharedDaemonReconnectDelayEnv   = "SAM_CODEX_SHARED_DAEMON_RECONNECT_DELAY_MS"
	codexSharedDaemonReconnectTimeoutEnv = "SAM_CODEX_SHARED_DAEMON_RECONNECT_TIMEOUT_MS"
	codexSharedDaemonMaxMessageEnv       = "SAM_CODEX_SHARED_DAEMON_MAX_FRAME_BYTES"
	codexSharedDaemonPingIntervalEnv     = "SAM_CODEX_SHARED_DAEMON_PING_INTERVAL_MS"
	codexSharedDaemonPongTimeoutEnv      = "SAM_CODEX_SHARED_DAEMON_PONG_TIMEOUT_MS"
	codexSharedDaemonDedupeLimitEnv      = "SAM_CODEX_SHARED_DAEMON_DEDUPE_LIMIT"
	codexSharedDaemonBridgePath          = ".sam/codex-shared-daemon/codex"
	codexSharedDaemonVersion             = "0.156.1"
	defaultCodexNativeDedupeLimit        = 4096
	defaultCodexNativeReconnectDelay     = 2 * time.Second
	defaultCodexNativeReconnectTimeout   = 30 * time.Second
	defaultCodexNativeMaxMessageBytes    = 16 * 1024 * 1024
	defaultCodexNativePingInterval       = 2 * time.Second
	defaultCodexNativePongTimeout        = 5 * time.Second
	maxCodexNativeDuration               = 24 * time.Hour
	maxCodexNativeWebSocketBufferSize    = 1024 * 1024
	maxCodexNativeMessageBytes           = 64 * 1024 * 1024
	maxCodexNativeDedupeLimit            = 1024 * 1024
)

//go:embed codex_shared_daemon_bridge.mjs
var codexSharedDaemonBridge []byte

type codexSharedDaemonConfig struct {
	enabled             bool
	socketPath          string
	bridgePath          string
	containerID         string
	containerUser       string
	workDir             string
	envVars             []string
	dedupeLimit         int
	cliPath             string
	handshakeTimeout    time.Duration
	requestTimeout      time.Duration
	websocketBufferSize int
	reconnectDelay      time.Duration
	reconnectTimeout    time.Duration
	maxMessageBytes     int64
	pingInterval        time.Duration
	pongTimeout         time.Duration
}

type codexSharedDaemonLimits struct {
	duration            time.Duration
	websocketBufferSize int
	messageBytes        int64
	dedupeLimit         int
}

func (h *SessionHost) codexSharedDaemonLimits() codexSharedDaemonLimits {
	limits := codexSharedDaemonLimits{
		duration:            h.config.CodexSharedDaemonMaxDuration,
		websocketBufferSize: h.config.CodexSharedDaemonMaxWebSocketBufferSize,
		messageBytes:        h.config.CodexSharedDaemonMaxMessageBytes,
		dedupeLimit:         h.config.CodexSharedDaemonMaxDedupeLimit,
	}
	if limits.duration <= 0 {
		limits.duration = maxCodexNativeDuration
	}
	if limits.websocketBufferSize <= 0 {
		limits.websocketBufferSize = maxCodexNativeWebSocketBufferSize
	}
	if limits.messageBytes <= 0 {
		limits.messageBytes = maxCodexNativeMessageBytes
	}
	if limits.dedupeLimit <= 0 {
		limits.dedupeLimit = maxCodexNativeDedupeLimit
	}
	return limits
}

func resolveCodexSharedDaemonConfig(startup *agentStartup, containerUser, workDir string, limits codexSharedDaemonLimits) (codexSharedDaemonConfig, error) {
	if startup == nil || !envFlag(startup.envVars, codexSharedDaemonEnabledEnv) {
		return codexSharedDaemonConfig{}, nil
	}
	if envFlag(startup.envVars, codexSharedDaemonRemoteControlEnv) {
		return codexSharedDaemonConfig{}, fmt.Errorf("automatic remote control is unavailable for the isolated spike; pair manually on a dedicated desktop host")
	}

	socketPath := strings.TrimSpace(envValue(startup.envVars, codexSharedDaemonSocketEnv))
	if socketPath == "" || !filepath.IsAbs(socketPath) {
		return codexSharedDaemonConfig{}, fmt.Errorf("%s must be an absolute private Unix socket path", codexSharedDaemonSocketEnv)
	}
	if !pathWithinRoot(socketPath, workDir) {
		return codexSharedDaemonConfig{}, fmt.Errorf("%s must be inside this runtime's workspace", codexSharedDaemonSocketEnv)
	}
	config, err := resolveCodexSharedDaemonRuntime(startup.envVars, limits)
	if err != nil {
		return codexSharedDaemonConfig{}, err
	}
	config.enabled = true
	config.socketPath = socketPath
	config.containerID = startup.containerID
	config.containerUser = containerUser
	config.workDir = workDir
	config.envVars = append([]string(nil), startup.envVars...)
	return config, nil
}

func resolveCodexSharedDaemonRuntime(envVars []string, limits codexSharedDaemonLimits) (codexSharedDaemonConfig, error) {
	dedupeLimit, err := codexSharedDaemonInt(envVars, codexSharedDaemonDedupeLimitEnv, defaultCodexNativeDedupeLimit, limits.dedupeLimit)
	if err != nil {
		return codexSharedDaemonConfig{}, err
	}
	handshakeTimeout, err := codexSharedDaemonDuration(envVars, codexSharedDaemonHandshakeEnv, defaultCodexNativeHandshakeTimeout, limits.duration)
	if err != nil {
		return codexSharedDaemonConfig{}, err
	}
	requestTimeout, err := codexSharedDaemonDuration(envVars, codexSharedDaemonRequestEnv, defaultCodexNativeRequestTimeout, limits.duration)
	if err != nil {
		return codexSharedDaemonConfig{}, err
	}
	websocketBufferSize, err := codexSharedDaemonInt(envVars, codexSharedDaemonWSBufferEnv, defaultCodexNativeWebSocketBufferSize, limits.websocketBufferSize)
	if err != nil {
		return codexSharedDaemonConfig{}, err
	}
	cliPath := strings.TrimSpace(envValue(envVars, codexSharedDaemonCLIEnv))
	if cliPath == "" {
		cliPath = "codex"
	}
	reconnectDelay, err := codexSharedDaemonDuration(envVars, codexSharedDaemonReconnectDelayEnv, defaultCodexNativeReconnectDelay, limits.duration)
	if err != nil {
		return codexSharedDaemonConfig{}, err
	}
	reconnectTimeout, err := codexSharedDaemonDuration(envVars, codexSharedDaemonReconnectTimeoutEnv, defaultCodexNativeReconnectTimeout, limits.duration)
	if err != nil {
		return codexSharedDaemonConfig{}, err
	}
	maxMessageBytes, err := codexSharedDaemonInt64(envVars, codexSharedDaemonMaxMessageEnv, defaultCodexNativeMaxMessageBytes, limits.messageBytes)
	if err != nil {
		return codexSharedDaemonConfig{}, err
	}
	pingInterval, err := codexSharedDaemonDuration(envVars, codexSharedDaemonPingIntervalEnv, defaultCodexNativePingInterval, limits.duration)
	if err != nil {
		return codexSharedDaemonConfig{}, err
	}
	pongTimeout, err := codexSharedDaemonDuration(envVars, codexSharedDaemonPongTimeoutEnv, defaultCodexNativePongTimeout, limits.duration)
	if err != nil {
		return codexSharedDaemonConfig{}, err
	}

	return codexSharedDaemonConfig{
		dedupeLimit:         dedupeLimit,
		cliPath:             cliPath,
		handshakeTimeout:    handshakeTimeout,
		requestTimeout:      requestTimeout,
		websocketBufferSize: websocketBufferSize,
		reconnectDelay:      reconnectDelay,
		reconnectTimeout:    reconnectTimeout,
		maxMessageBytes:     maxMessageBytes,
		pingInterval:        pingInterval,
		pongTimeout:         pongTimeout,
	}, nil
}

func codexSharedDaemonInt(envVars []string, key string, fallback, ceiling int) (int, error) {
	raw := strings.TrimSpace(envValue(envVars, key))
	if raw == "" {
		return min(fallback, ceiling), nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 || value > ceiling {
		return 0, fmt.Errorf("%s must be between 1 and %d", key, ceiling)
	}
	return value, nil
}

func codexSharedDaemonInt64(envVars []string, key string, fallback int, ceiling int64) (int64, error) {
	raw := strings.TrimSpace(envValue(envVars, key))
	if raw == "" {
		return min(int64(fallback), ceiling), nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 || value > ceiling {
		return 0, fmt.Errorf("%s must be between 1 and %d", key, ceiling)
	}
	return value, nil
}

func codexSharedDaemonDuration(envVars []string, key string, fallback, ceiling time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(envValue(envVars, key))
	if raw == "" {
		return min(fallback, ceiling), nil
	}
	milliseconds, err := strconv.ParseInt(raw, 10, 64)
	maxMilliseconds := ceiling.Milliseconds()
	if err != nil || milliseconds <= 0 || milliseconds > maxMilliseconds {
		return 0, fmt.Errorf("%s must be between 1 and %d", key, maxMilliseconds)
	}
	return time.Duration(milliseconds) * time.Millisecond, nil
}

func pathWithinRoot(target, root string) bool {
	if !filepath.IsAbs(root) {
		return false
	}
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(target))
	return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func envFlag(envVars []string, key string) bool {
	switch strings.ToLower(strings.TrimSpace(envValue(envVars, key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func envValue(envVars []string, key string) string {
	prefix := key + "="
	for i := len(envVars) - 1; i >= 0; i-- {
		if strings.HasPrefix(envVars[i], prefix) {
			return strings.TrimPrefix(envVars[i], prefix)
		}
	}
	return ""
}

func (h *SessionHost) configureCodexSharedDaemon(ctx context.Context, startup *agentStartup) error {
	config, err := resolveCodexSharedDaemonConfig(startup, h.config.ContainerUser, h.config.ContainerWorkDir, h.codexSharedDaemonLimits())
	if err != nil {
		return err
	}
	if !config.enabled {
		h.setCodexSharedDaemonConfig(codexSharedDaemonConfig{})
		return nil
	}

	bridgePath, err := installCodexSharedDaemonBridge(ctx, config)
	if err != nil {
		return err
	}
	config.bridgePath = bridgePath

	startup.envVars = removeEnvVar(startup.envVars, "CODEX_PATH")
	startup.envVars = removeEnvVar(startup.envVars, codexSharedDaemonExpectedEnv)
	startup.envVars = removeEnvVar(startup.envVars, codexSharedDaemonCLIEnv)
	startup.envVars = append(startup.envVars,
		"CODEX_PATH="+bridgePath,
		codexSharedDaemonExpectedEnv+"="+codexSharedDaemonVersion,
		codexSharedDaemonCLIEnv+"="+config.cliPath,
	)
	bridgeDurations := []struct {
		key   string
		value time.Duration
	}{
		{codexSharedDaemonHandshakeEnv, config.handshakeTimeout},
		{codexSharedDaemonPingIntervalEnv, config.pingInterval},
		{codexSharedDaemonPongTimeoutEnv, config.pongTimeout},
	}
	for _, setting := range bridgeDurations {
		startup.envVars = removeEnvVar(startup.envVars, setting.key)
		startup.envVars = append(startup.envVars, fmt.Sprintf("%s=%d", setting.key, setting.value.Milliseconds()))
	}
	startup.envVars = removeEnvVar(startup.envVars, codexSharedDaemonMaxMessageEnv)
	startup.envVars = append(startup.envVars, fmt.Sprintf("%s=%d", codexSharedDaemonMaxMessageEnv, config.maxMessageBytes))
	if config.socketPath != "" {
		startup.envVars = removeEnvVar(startup.envVars, codexSharedDaemonSocketEnv)
		startup.envVars = append(startup.envVars, codexSharedDaemonSocketEnv+"="+config.socketPath)
		startup.envVars = removeEnvVar(startup.envVars, codexSharedDaemonOwnerFileEnv)
		startup.envVars = append(startup.envVars, codexSharedDaemonOwnerFileEnv+"="+config.socketPath+".sam-owner.json")
	}
	config.envVars = append([]string(nil), startup.envVars...)
	h.setCodexSharedDaemonConfig(config)
	return nil
}

func installCodexSharedDaemonBridge(ctx context.Context, config codexSharedDaemonConfig) (string, error) {
	if config.containerID == "" {
		target, err := resolveLocalAuthFileTargetPath(codexSharedDaemonBridgePath)
		if err != nil {
			return "", fmt.Errorf("resolve shared-daemon bridge path: %w", err)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return "", fmt.Errorf("create shared-daemon bridge directory: %w", err)
		}
		if err := os.WriteFile(target, codexSharedDaemonBridge, 0o700); err != nil {
			return "", fmt.Errorf("write shared-daemon bridge: %w", err)
		}
		if err := os.Chmod(target, 0o700); err != nil {
			return "", fmt.Errorf("chmod shared-daemon bridge: %w", err)
		}
		return target, nil
	}

	if err := writeAuthFileToContainer(ctx, config.containerID, config.containerUser, codexSharedDaemonBridgePath, string(codexSharedDaemonBridge)); err != nil {
		return "", fmt.Errorf("write shared-daemon bridge into container: %w", err)
	}
	target, err := resolveAuthFileTargetPath(ctx, config.containerID, config.containerUser, codexSharedDaemonBridgePath)
	if err != nil {
		return "", fmt.Errorf("resolve installed shared-daemon bridge: %w", err)
	}
	if _, stderr, err := execInContainer(ctx, config.containerID, config.containerUser, "", "chmod", "700", target); err != nil {
		return "", fmt.Errorf("chmod shared-daemon bridge: %w: %s", err, stderr)
	}
	return target, nil
}

func (h *SessionHost) setCodexSharedDaemonConfig(config codexSharedDaemonConfig) {
	h.codexNativeMu.Lock()
	h.codexSharedDaemon = config
	h.codexNativeMu.Unlock()
	h.codexSharedDaemonEnabled.Store(config.enabled)
}

func (h *SessionHost) sharedCodexDaemonEnabled() bool {
	return h.codexSharedDaemonEnabled.Load()
}
