// Package config provides configuration loading for the VM Agent.
package config

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// DefaultAdditionalFeatures is the default JSON for --additional-features on devcontainer up.
// Installs Node.js which is required by ACP adapters. The ACP adapter itself is installed
// on-demand via docker exec when the user activates an agent (see acp/gateway.go ensureAgentInstalled).
//
// IMPORTANT: These features are ONLY injected when the repo does NOT have its own
// .devcontainer config. Repos with existing devcontainer configs likely have Node.js
// and other deps set up, and injecting features like nvm can conflict with existing
// ENV vars (e.g. NPM_CONFIG_PREFIX). See hasDevcontainerConfig() in bootstrap.go.
const DefaultAdditionalFeatures = `{"ghcr.io/devcontainers/features/node:1":{"version":"22"}}`

// DefaultDevcontainerImage is the default container image used when a repo has no devcontainer config.
// Uses a lighter base image so fallback workspaces bootstrap quickly on modest nodes.
// Override via DEFAULT_DEVCONTAINER_IMAGE env var.
const DefaultDevcontainerImage = "mcr.microsoft.com/devcontainers/base:ubuntu"

// DefaultDevcontainerConfigPath is where the VM agent writes the default devcontainer.json
// when a repo has no devcontainer config. Override via DEFAULT_DEVCONTAINER_CONFIG_PATH env var.
const DefaultDevcontainerConfigPath = "/etc/sam/default-devcontainer.json"

// Config holds all configuration values for the VM Agent.
type Config struct {
	// Server settings
	Port           int
	Host           string
	AllowedOrigins []string

	// Control plane settings
	ControlPlaneURL string
	JWKSEndpoint    string

	// JWT settings
	JWTAudience string
	JWTIssuer   string

	// Workspace settings
	NodeID             string
	WorkspaceID        string
	CallbackToken      string
	BootstrapToken     string
	Repository         string
	Branch             string
	WorkspaceDir       string
	BootstrapStatePath string
	BootstrapMaxWait   time.Duration
	BootstrapTimeout   time.Duration // Overall bootstrap timeout including devcontainer build

	// Session settings
	SessionTTL             time.Duration
	SessionCleanupInterval time.Duration
	SessionMaxCount        int
	CookieName             string
	CookieSecure           bool

	// Node health reporter interval
	HeartbeatInterval time.Duration

	// HTTP server timeouts
	HTTPReadTimeout  time.Duration
	HTTPWriteTimeout time.Duration
	HTTPIdleTimeout  time.Duration

	// WebSocket settings
	WSReadBufferSize  int
	WSWriteBufferSize int

	// PTY settings
	DefaultShell string
	DefaultRows  int
	DefaultCols  int

	// PTY session persistence settings - configurable per constitution principle XI
	PTYOrphanGracePeriod time.Duration // How long orphaned sessions survive before cleanup (0 = disabled)
	PTYOutputBufferSize  int           // Ring buffer capacity per session in bytes

	// ACP settings - configurable per constitution principle XI
	ACPInitTimeoutMs      int
	ACPReconnectDelayMs   int
	ACPReconnectTimeoutMs int
	ACPMaxRestartAttempts int
	ACPMessageBufferSize  int           // Max buffered messages per SessionHost for late-join replay
	ACPViewerSendBuffer   int           // Per-viewer send channel buffer size
	ACPPingInterval       time.Duration // WebSocket ping interval (default: 30s)
	ACPPongTimeout        time.Duration // WebSocket pong deadline after ping (default: 10s)
	ACPPromptTimeout      time.Duration // Max prompt runtime before force-stop fallback (default: 10m)
	ACPPromptCancelGrace  time.Duration // Wait after cancel before force-stop fallback (default: 5s)

	// Event log settings - configurable per constitution principle XI
	MaxNodeEvents      int // Max node-level events retained in memory (default: 500)
	MaxWorkspaceEvents int // Max workspace-level events retained in memory (default: 500)

	// Container settings - exec into devcontainer instead of host shell
	ContainerMode       bool
	ContainerUser       string
	ContainerWorkDir    string
	ContainerLabelKey   string
	ContainerLabelValue string
	ContainerCacheTTL   time.Duration

	// Devcontainer features to inject via --additional-features on devcontainer up.
	// JSON string matching the "features" section of devcontainer.json.
	// Configurable per constitution principle XI.
	AdditionalFeatures string

	// Default devcontainer settings for repos without a devcontainer config.
	// Configurable per constitution principle XI.
	DefaultDevcontainerImage      string // Container image for the default config
	DefaultDevcontainerConfigPath string // Path to write the generated default config
	DefaultDevcontainerRemoteUser string // remoteUser for the default config (empty = omit, let image default)

	// Persistence settings - configurable per constitution principle XI
	PersistenceDBPath string // SQLite database path for session state persistence

	// Git integration settings - configurable per constitution principle XI
	GitExecTimeout           time.Duration // Timeout for git commands via docker exec (default: 30s)
	GitFileMaxSize           int           // Max file size in bytes for /git/file (default: 1MB)
	GitWorktreeTimeout       time.Duration // Timeout for git worktree commands (default: 30s)
	WorktreeCacheTTL         time.Duration // Cache TTL for git worktree list output (default: 5s)
	MaxWorktreesPerWorkspace int           // Max worktrees per workspace (default: 5)

	// File browser settings - configurable per constitution principle XI
	FileListTimeout    time.Duration // Timeout for file listing commands (default: 10s)
	FileListMaxEntries int           // Max entries returned per directory listing (default: 1000)
	FileFindTimeout    time.Duration // Timeout for recursive file find (default: 15s)
	FileFindMaxEntries int           // Max entries returned by file find (default: 5000)

	// Error reporting settings - configurable per constitution principle XI
	ErrorReportFlushInterval time.Duration // Background flush interval (default: 30s)
	ErrorReportMaxBatchSize  int           // Immediate flush threshold (default: 10)
	ErrorReportMaxQueueSize  int           // Max queued entries before dropping (default: 100)
	ErrorReportHTTPTimeout   time.Duration // HTTP POST timeout (default: 10s)

	// System info collection settings - configurable per constitution principle XI
	SysInfoDockerTimeout  time.Duration // Timeout for Docker CLI commands in system info (default: 10s)
	SysInfoVersionTimeout time.Duration // Timeout for version check commands (default: 5s)
	SysInfoCacheTTL       time.Duration // Cache TTL for system info responses (default: 5s)

	// Log reader/stream settings - configurable per constitution principle XI
	LogReaderTimeout     time.Duration // Timeout for journalctl read commands (default: 30s)
	LogStreamPingInterval time.Duration // WebSocket ping interval for log stream (default: 30s)
	LogStreamPongTimeout  time.Duration // WebSocket pong deadline for log stream (default: 90s)
}

// Load reads configuration from environment variables.
func Load() (*Config, error) {
	controlPlaneURL := getEnv("CONTROL_PLANE_URL", "")
	repository := getEnv("REPOSITORY", "")

	workspaceDir := getEnv("WORKSPACE_DIR", "")
	if workspaceDir == "" {
		workspaceBaseDir := getEnv("WORKSPACE_BASE_DIR", "/workspace")
		workspaceDir = deriveWorkspaceDir(workspaceBaseDir, repository)
	}

	containerLabelValue := getEnv("CONTAINER_LABEL_VALUE", "")
	if containerLabelValue == "" {
		// The devcontainer CLI labels containers with the local folder path used for --workspace-folder.
		containerLabelValue = workspaceDir
	}

	containerWorkDir := getEnv("CONTAINER_WORK_DIR", "")
	if containerWorkDir == "" {
		// Devcontainers mount the workspace under /workspaces/<foldername> by default, where <foldername>
		// matches the basename of the local folder passed to --workspace-folder.
		containerWorkDir = deriveContainerWorkDir(workspaceDir)
	}

	cfg := &Config{
		// Default values
		Port:           getEnvInt("VM_AGENT_PORT", 8080),
		Host:           getEnv("VM_AGENT_HOST", "0.0.0.0"),
		AllowedOrigins: getEnvStringSlice("ALLOWED_ORIGINS", nil), // Parsed from comma-separated list

		ControlPlaneURL: controlPlaneURL,
		JWKSEndpoint:    getEnv("JWKS_ENDPOINT", ""),

		// JWT settings - derived from control plane URL by default
		JWTAudience: getEnv("JWT_AUDIENCE", "workspace-terminal"),
		JWTIssuer:   getEnv("JWT_ISSUER", ""), // Will be derived from ControlPlaneURL if not set

		NodeID:             getEnv("NODE_ID", getEnv("WORKSPACE_ID", "")),
		WorkspaceID:        getEnv("WORKSPACE_ID", ""),
		CallbackToken:      getEnv("CALLBACK_TOKEN", ""),
		BootstrapToken:     getEnv("BOOTSTRAP_TOKEN", ""),
		Repository:         repository,
		Branch:             getEnv("BRANCH", "main"),
		WorkspaceDir:       workspaceDir,
		BootstrapStatePath: getEnv("BOOTSTRAP_STATE_PATH", "/var/lib/vm-agent/bootstrap-state.json"),
		BootstrapMaxWait:   getEnvDuration("BOOTSTRAP_MAX_WAIT", 5*time.Minute),
		BootstrapTimeout:   getEnvDuration("BOOTSTRAP_TIMEOUT", 15*time.Minute),

		SessionTTL:             getEnvDuration("SESSION_TTL", 24*time.Hour),
		SessionCleanupInterval: getEnvDuration("SESSION_CLEANUP_INTERVAL", 1*time.Minute),
		SessionMaxCount:        getEnvInt("SESSION_MAX_COUNT", 100),
		CookieName:             getEnv("COOKIE_NAME", "vm_session"),
		CookieSecure:           getEnvBool("COOKIE_SECURE", true),

		HeartbeatInterval: getEnvDuration("HEARTBEAT_INTERVAL", 60*time.Second),

		// HTTP server timeouts - configurable per constitution
		HTTPReadTimeout:  getEnvDuration("HTTP_READ_TIMEOUT", 15*time.Second),
		HTTPWriteTimeout: getEnvDuration("HTTP_WRITE_TIMEOUT", 15*time.Second),
		HTTPIdleTimeout:  getEnvDuration("HTTP_IDLE_TIMEOUT", 60*time.Second),

		// WebSocket buffer sizes - configurable per constitution
		WSReadBufferSize:  getEnvInt("WS_READ_BUFFER_SIZE", 1024),
		WSWriteBufferSize: getEnvInt("WS_WRITE_BUFFER_SIZE", 1024),

		DefaultShell: getEnv("DEFAULT_SHELL", "/bin/bash"),
		DefaultRows:  getEnvInt("DEFAULT_ROWS", 24),
		DefaultCols:  getEnvInt("DEFAULT_COLS", 80),

		// PTY session persistence - configurable per constitution principle XI.
		// Default keeps orphaned sessions until explicitly closed by the user.
		PTYOrphanGracePeriod: time.Duration(getEnvInt("PTY_ORPHAN_GRACE_PERIOD", 0)) * time.Second,
		PTYOutputBufferSize:  getEnvInt("PTY_OUTPUT_BUFFER_SIZE", 262144), // 256 KB default

		// ACP settings - configurable per constitution principle XI
		ACPInitTimeoutMs:      getEnvInt("ACP_INIT_TIMEOUT_MS", 30000),
		ACPReconnectDelayMs:   getEnvInt("ACP_RECONNECT_DELAY_MS", 2000),
		ACPReconnectTimeoutMs: getEnvInt("ACP_RECONNECT_TIMEOUT_MS", 30000),
		ACPMaxRestartAttempts: getEnvInt("ACP_MAX_RESTART_ATTEMPTS", 3),
		ACPMessageBufferSize:  getEnvInt("ACP_MESSAGE_BUFFER_SIZE", 5000),
		ACPViewerSendBuffer:   getEnvInt("ACP_VIEWER_SEND_BUFFER", 256),
		ACPPingInterval:       getEnvDuration("ACP_PING_INTERVAL", 30*time.Second),
		ACPPongTimeout:        getEnvDuration("ACP_PONG_TIMEOUT", 10*time.Second),
		ACPPromptTimeout:      getEnvDuration("ACP_PROMPT_TIMEOUT", 60*time.Minute),
		ACPPromptCancelGrace:  getEnvDuration("ACP_PROMPT_CANCEL_GRACE_PERIOD", 5*time.Second),

		// Event log settings
		MaxNodeEvents:      getEnvInt("MAX_NODE_EVENTS", 500),
		MaxWorkspaceEvents: getEnvInt("MAX_WORKSPACE_EVENTS", 500),

		ContainerMode: getEnvBool("CONTAINER_MODE", true),
		// Optional manual override for docker exec user.
		// When empty, bootstrap resolves the effective devcontainer user
		// from devcontainer configuration/metadata at runtime.
		ContainerUser:       getEnv("CONTAINER_USER", ""),
		ContainerWorkDir:    containerWorkDir,
		ContainerLabelKey:   getEnv("CONTAINER_LABEL_KEY", "devcontainer.local_folder"),
		ContainerLabelValue: containerLabelValue,
		ContainerCacheTTL:   getEnvDuration("CONTAINER_CACHE_TTL", 30*time.Second),

		// Default installs Node.js (required by ACP adapters) and claude-code-acp.
		// Override via ADDITIONAL_FEATURES env var. Set to empty string to disable.
		AdditionalFeatures: getEnv("ADDITIONAL_FEATURES", DefaultAdditionalFeatures),

		// Default devcontainer settings for repos without their own config.
		DefaultDevcontainerImage:      getEnv("DEFAULT_DEVCONTAINER_IMAGE", DefaultDevcontainerImage),
		DefaultDevcontainerConfigPath: getEnv("DEFAULT_DEVCONTAINER_CONFIG_PATH", DefaultDevcontainerConfigPath),
		DefaultDevcontainerRemoteUser: getEnv("DEFAULT_DEVCONTAINER_REMOTE_USER", ""), // Empty = omit, use image default

		// Persistence settings
		PersistenceDBPath: getEnv("PERSISTENCE_DB_PATH", "/var/lib/vm-agent/state.db"),

		// Git integration settings - configurable per constitution principle XI
		GitExecTimeout:           getEnvDuration("GIT_EXEC_TIMEOUT", 30*time.Second),
		GitFileMaxSize:           getEnvInt("GIT_FILE_MAX_SIZE", 1048576), // 1 MB
		GitWorktreeTimeout:       getEnvDuration("GIT_WORKTREE_TIMEOUT", 30*time.Second),
		WorktreeCacheTTL:         getEnvDuration("WORKTREE_CACHE_TTL", 5*time.Second),
		MaxWorktreesPerWorkspace: getEnvInt("MAX_WORKTREES_PER_WORKSPACE", 5),

		// File browser settings
		FileListTimeout:    getEnvDuration("FILE_LIST_TIMEOUT", 10*time.Second),
		FileListMaxEntries: getEnvInt("FILE_LIST_MAX_ENTRIES", 1000),
		FileFindTimeout:    getEnvDuration("FILE_FIND_TIMEOUT", 15*time.Second),
		FileFindMaxEntries: getEnvInt("FILE_FIND_MAX_ENTRIES", 5000),

		// Error reporting settings - configurable per constitution principle XI
		ErrorReportFlushInterval: getEnvDuration("ERROR_REPORT_FLUSH_INTERVAL", 30*time.Second),
		ErrorReportMaxBatchSize:  getEnvInt("ERROR_REPORT_MAX_BATCH_SIZE", 10),
		ErrorReportMaxQueueSize:  getEnvInt("ERROR_REPORT_MAX_QUEUE_SIZE", 100),
		ErrorReportHTTPTimeout:   getEnvDuration("ERROR_REPORT_HTTP_TIMEOUT", 10*time.Second),

		// System info settings - configurable per constitution principle XI
		SysInfoDockerTimeout:  getEnvDuration("SYSINFO_DOCKER_TIMEOUT", 10*time.Second),
		SysInfoVersionTimeout: getEnvDuration("SYSINFO_VERSION_TIMEOUT", 5*time.Second),
		SysInfoCacheTTL:       getEnvDuration("SYSINFO_CACHE_TTL", 5*time.Second),

		// Log reader/stream settings - configurable per constitution principle XI
		LogReaderTimeout:      getEnvDuration("LOG_READER_TIMEOUT", 30*time.Second),
		LogStreamPingInterval: getEnvDuration("LOG_STREAM_PING_INTERVAL", 30*time.Second),
		LogStreamPongTimeout:  getEnvDuration("LOG_STREAM_PONG_TIMEOUT", 90*time.Second),
	}

	// Validate required fields
	if cfg.ControlPlaneURL == "" {
		return nil, fmt.Errorf("CONTROL_PLANE_URL is required")
	}

	// Derive JWKS endpoint if not set
	if cfg.JWKSEndpoint == "" {
		cfg.JWKSEndpoint = cfg.ControlPlaneURL + "/.well-known/jwks.json"
	}

	// Derive JWT issuer from control plane URL if not explicitly set
	if cfg.JWTIssuer == "" {
		cfg.JWTIssuer = cfg.ControlPlaneURL
	}

	// Derive allowed origins from control plane URL if not explicitly set
	if len(cfg.AllowedOrigins) == 0 {
		// Extract base domain from control plane URL to allow workspace subdomains
		// e.g., https://api.example.com -> allow *.example.com
		cfg.AllowedOrigins = deriveAllowedOrigins(cfg.ControlPlaneURL)
	}

	if cfg.NodeID == "" {
		return nil, fmt.Errorf("NODE_ID is required")
	}
	if cfg.MaxWorktreesPerWorkspace < 1 {
		cfg.MaxWorktreesPerWorkspace = 1
	}
	if cfg.WorktreeCacheTTL <= 0 {
		cfg.WorktreeCacheTTL = 5 * time.Second
	}

	return cfg, nil
}

func deriveWorkspaceDir(workspaceBaseDir, repository string) string {
	baseDir := strings.TrimSpace(workspaceBaseDir)
	if baseDir == "" {
		baseDir = "/workspace"
	}

	repoDirName := DeriveRepoDirName(repository)
	if repoDirName == "" {
		// Preserve legacy behavior when the repo is unknown: a fixed base directory.
		return baseDir
	}

	return filepath.Join(baseDir, repoDirName)
}

func deriveContainerWorkDir(workspaceDir string) string {
	if strings.TrimSpace(workspaceDir) == "" {
		return "/workspaces"
	}
	base := filepath.Base(workspaceDir)
	if base == "" || base == "." || base == "/" {
		return "/workspaces"
	}
	return filepath.Join("/workspaces", base)
}

// DeriveRepoDirName extracts a filesystem-safe directory name from a repository
// URL or owner/repo string. Exported for use by the bootstrap package.
func DeriveRepoDirName(repository string) string {
	repo := strings.TrimSpace(repository)
	if repo == "" {
		return ""
	}

	// Handle full URLs (https://github.com/org/repo.git).
	if strings.Contains(repo, "://") {
		if parsed, err := url.Parse(repo); err == nil {
			repo = parsed.Path
		}
	}

	repo = strings.Trim(repo, "/")
	if repo == "" {
		return ""
	}

	parts := strings.Split(repo, "/")
	name := parts[len(parts)-1]
	name = strings.TrimSuffix(name, ".git")
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}

	// Keep the name filesystem-safe. This is intentionally conservative.
	var b strings.Builder
	b.Grow(len(name))
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_' || r == '.':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	safe := strings.Trim(b.String(), "-")
	return safe
}

// DeriveBaseDomain extracts the base domain from a control plane URL by stripping
// the protocol, path, port, and "api." subdomain prefix.
// Example: "https://api.example.com/foo" → "example.com"
func DeriveBaseDomain(controlPlaneURL string) string {
	host := controlPlaneURL
	host = strings.TrimPrefix(host, "https://")
	host = strings.TrimPrefix(host, "http://")

	if idx := strings.Index(host, "/"); idx != -1 {
		host = host[:idx]
	}
	if idx := strings.Index(host, ":"); idx != -1 {
		host = host[:idx]
	}
	if strings.HasPrefix(host, "api.") {
		return host[4:]
	}
	return host
}

// deriveAllowedOrigins extracts allowed origins from the control plane URL.
// This allows the control plane domain and workspace subdomains.
func deriveAllowedOrigins(controlPlaneURL string) []string {
	baseDomain := DeriveBaseDomain(controlPlaneURL)
	return []string{
		controlPlaneURL,
		"https://*." + baseDomain, // Allow workspace subdomains
	}
}

// getEnv returns the value of an environment variable or a default.
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

// getEnvInt returns an integer environment variable or a default.
func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if i, err := strconv.Atoi(value); err == nil {
			return i
		}
	}
	return defaultValue
}

// getEnvBool returns a boolean environment variable or a default.
func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		if b, err := strconv.ParseBool(value); err == nil {
			return b
		}
	}
	return defaultValue
}

// getEnvDuration returns a duration environment variable or a default.
func getEnvDuration(key string, defaultValue time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		if d, err := time.ParseDuration(value); err == nil {
			return d
		}
	}
	return defaultValue
}

// getEnvStringSlice returns a slice from a comma-separated environment variable.
func getEnvStringSlice(key string, defaultValue []string) []string {
	if value := os.Getenv(key); value != "" {
		parts := strings.Split(value, ",")
		result := make([]string, 0, len(parts))
		for _, p := range parts {
			trimmed := strings.TrimSpace(p)
			if trimmed != "" {
				result = append(result, trimmed)
			}
		}
		if len(result) > 0 {
			return result
		}
	}
	return defaultValue
}
