// Package config provides configuration loading for the VM Agent.
package config

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
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

// TaskMode constants for discriminating task vs conversation mode.
const (
	TaskModeTask         = "task"
	TaskModeConversation = "conversation"
)

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
	HTTPReadTimeout      time.Duration
	HTTPWriteTimeout     time.Duration
	HTTPIdleTimeout      time.Duration
	HTTPCallbackTimeout  time.Duration // timeout for outbound HTTP callbacks to the control plane

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
	ACPInitTimeoutMs         int // Fallback timeout for all ACP init phases (default: 30000ms)
	ACPInitializeTimeoutMs   int // Per-phase timeout for Initialize RPC; 0 = use ACPInitTimeoutMs (default: 0)
	ACPNewSessionTimeoutMs   int // Per-phase timeout for NewSession RPC; 0 = use ACPInitTimeoutMs (default: 0)
	ACPLoadSessionTimeoutMs  int // Per-phase timeout for LoadSession RPC; 0 = use ACPInitTimeoutMs (default: 0)
	ACPReconnectDelayMs   int
	ACPReconnectTimeoutMs int
	ACPMaxRestartAttempts int
	ACPMessageBufferSize  int           // Max buffered messages per SessionHost for late-join replay
	ACPViewerSendBuffer   int           // Per-viewer send channel buffer size
	ACPPingInterval       time.Duration // WebSocket ping interval (default: 30s)
	ACPPongTimeout        time.Duration // WebSocket pong deadline after ping (default: 10s)
	ACPPromptTimeout      time.Duration // Max prompt runtime; 0 = no timeout (default: 0). Used for workspace sessions; task sessions use ACPTaskPromptTimeout via effectivePromptTimeout().
	ACPTaskPromptTimeout  time.Duration // Max prompt runtime for task-driven sessions; 0 = no timeout (default: 6h)
	ACPPromptCancelGrace  time.Duration // Wait after cancel before force-stop fallback (default: 5s)
	ACPIdleSuspendTimeout    time.Duration // Auto-suspend after this idle duration with no viewers (default: 30m, 0=disabled)
	ACPNotifSerializeTimeout time.Duration // Max wait for previous notification processing before delivering next (default: 5s)
	ACPHeartbeatInterval     time.Duration // Interval for direct ACP session heartbeats to control plane (default: 60s, env: ACP_HEARTBEAT_INTERVAL)

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

	// Project linkage — set via cloud-init when the workspace belongs to a project.
	// If ProjectID is empty, the message reporter is disabled (no-op).
	ProjectID     string // Linked project ID (env: PROJECT_ID)
	ChatSessionID string // Chat session created during workspace provisioning (env: CHAT_SESSION_ID)
	TaskID        string // Task ID for task-driven workspaces (env: TASK_ID)
	TaskMode      string // Task execution mode: "task" or "conversation" (env: TASK_MODE, default: "task")

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
	FileRawMaxSize     int           // Max file size in bytes for /files/raw binary endpoint (default: 50MB, env: FILE_RAW_MAX_SIZE)
	FileRawTimeout     time.Duration // Timeout for raw file reads (default: 60s, env: FILE_RAW_TIMEOUT)

	// File transfer settings - configurable per constitution principle XI
	FileUploadMaxBytes      int64         // Max single file size in bytes (default: 50MB)
	FileUploadBatchMaxBytes int64         // Max total batch upload size in bytes (default: 250MB)
	FileUploadTimeout       time.Duration // Timeout for file upload operations (default: 120s)
	FileDownloadTimeout     time.Duration // Timeout for file download operations (default: 60s)
	FileDownloadMaxBytes    int64         // Max file download size in bytes (default: 50MB)

	// Callback retry settings - configurable per constitution principle XI
	WorkspaceReadyCallbackTimeout time.Duration // HTTP timeout for workspace-ready retry callbacks (env: WORKSPACE_READY_CALLBACK_TIMEOUT, default: 10s)

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

	// TLS settings - configurable per constitution principle XI
	TLSCertPath string // Path to TLS certificate PEM (env: TLS_CERT_PATH)
	TLSKeyPath  string // Path to TLS private key PEM (env: TLS_KEY_PATH)
	TLSEnabled  bool   // Derived: true when both TLSCertPath and TLSKeyPath are set

	// Port scanning settings - configurable per constitution principle XI
	PortScanEnabled      bool          // Enable port detection (env: PORT_SCAN_ENABLED, default: true)
	PortScanInterval     time.Duration // Scan interval (env: PORT_SCAN_INTERVAL, default: 5s)
	PortScanExclude      string        // Comma-separated ports to exclude (env: PORT_SCAN_EXCLUDE, default: "22,2375,2376,8443")
	PortScanEphemeralMin int           // Min ephemeral port to exclude (env: PORT_SCAN_EPHEMERAL_MIN, default: 32768)
	PortProxyCacheTTL    time.Duration // Bridge IP cache TTL (env: PORT_PROXY_CACHE_TTL, default: 30s)

	// Neko browser sidecar settings - configurable per constitution principle XI
	NekoImage             string        // Docker image for Neko browser (env: NEKO_IMAGE, default: ghcr.io/m1k1o/neko/google-chrome:latest)
	NekoScreenResolution  string        // Default screen resolution (env: NEKO_SCREEN_RESOLUTION, default: 1920x1080)
	NekoMaxFPS            int           // Max WebRTC framerate (env: NEKO_MAX_FPS, default: 30)
	NekoWebRTCPort        int           // HTTP port for Neko web client (env: NEKO_WEBRTC_PORT, default: 6080)
	NekoSocatPollInterval time.Duration // Interval for port scan / socat sync (env: NEKO_SOCAT_POLL_INTERVAL, default: 5s)
	NekoMinRAMMB          int           // Minimum free RAM to start sidecar in MB (env: NEKO_MIN_RAM_MB, default: 2048)
	NekoEnableAudio       bool          // Enable audio streaming (env: NEKO_ENABLE_AUDIO, default: true)
	NekoTCPFallback       bool          // Use TCP fallback for WebRTC (env: NEKO_TCP_FALLBACK, default: true)
	NekoMuxPort           int           // Single port for WebRTC UDP/TCP mux (env: NEKO_MUX_PORT, default: 59000)
	NekoNAT1TO1           string        // Public IP for WebRTC NAT traversal (env: NEKO_NAT1TO1, default: auto-detect)
	NekoPassword          string        // Neko viewer password (env: NEKO_PASSWORD, default: random hex via crypto/rand)
	NekoPasswordAdmin     string        // Neko admin password (env: NEKO_PASSWORD_ADMIN, default: random hex via crypto/rand)
	NekoShmSize           string        // Shared memory size for Chrome (env: NEKO_SHM_SIZE, default: 2g)
	NekoBrowserStartTimeout time.Duration // Timeout for browser sidecar start (env: NEKO_BROWSER_START_TIMEOUT, default: 60s)
	NekoBrowserStopTimeout  time.Duration // Timeout for browser sidecar stop (env: NEKO_BROWSER_STOP_TIMEOUT, default: 30s)
	NekoMemoryLimit         string        // Docker memory limit for Neko container (env: NEKO_MEMORY_LIMIT, default: 4g)
	NekoCPULimit            string        // Docker CPU limit for Neko container (env: NEKO_CPU_LIMIT, default: 2)
	NekoPidsLimit           int           // Docker PID limit for Neko container (env: NEKO_PIDS_LIMIT, default: 512)
	NekoSocatMinPort        int           // Minimum port for socat forwarding (env: NEKO_SOCAT_MIN_PORT, default: 1024)
	NekoSocatMaxPort        int           // Maximum port for socat forwarding (env: NEKO_SOCAT_MAX_PORT, default: 65535)
	NekoViewportMinWidth    int           // Min viewport width for validation (env: NEKO_VIEWPORT_MIN_WIDTH, default: 320)
	NekoViewportMaxWidth    int           // Max viewport width for validation (env: NEKO_VIEWPORT_MAX_WIDTH, default: 7680)
	NekoViewportMinHeight   int           // Min viewport height for validation (env: NEKO_VIEWPORT_MIN_HEIGHT, default: 240)
	NekoViewportMaxHeight   int           // Max viewport height for validation (env: NEKO_VIEWPORT_MAX_HEIGHT, default: 4320)
	NekoViewportMaxDPR      int           // Max device pixel ratio for validation (env: NEKO_VIEWPORT_MAX_DPR, default: 4)
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
		// Must be <= API-side TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS (default 30m).
		// If larger, the API declares the workspace dead while bootstrap is still running.
		BootstrapTimeout: getEnvDuration("BOOTSTRAP_TIMEOUT", 30*time.Minute),

		SessionTTL:             getEnvDuration("SESSION_TTL", 24*time.Hour),
		SessionCleanupInterval: getEnvDuration("SESSION_CLEANUP_INTERVAL", 1*time.Minute),
		SessionMaxCount:        getEnvInt("SESSION_MAX_COUNT", 100),
		CookieName:             getEnv("COOKIE_NAME", "vm_session"),
		CookieSecure:           getEnvBool("COOKIE_SECURE", true),

		HeartbeatInterval: getEnvDuration("HEARTBEAT_INTERVAL", 60*time.Second),

		// HTTP server timeouts - configurable per constitution
		HTTPReadTimeout:     getEnvDuration("HTTP_READ_TIMEOUT", 15*time.Second),
		HTTPWriteTimeout:    getEnvDuration("HTTP_WRITE_TIMEOUT", 15*time.Second),
		HTTPIdleTimeout:     getEnvDuration("HTTP_IDLE_TIMEOUT", 60*time.Second),
		HTTPCallbackTimeout: getEnvDuration("HTTP_CALLBACK_TIMEOUT", 30*time.Second),

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
		ACPInitTimeoutMs:        getEnvInt("ACP_INIT_TIMEOUT_MS", 30000),
		ACPInitializeTimeoutMs:  getEnvInt("ACP_INITIALIZE_TIMEOUT_MS", 0), // 0 = use ACPInitTimeoutMs
		ACPNewSessionTimeoutMs:  getEnvInt("ACP_NEW_SESSION_TIMEOUT_MS", 0), // 0 = use ACPInitTimeoutMs
		ACPLoadSessionTimeoutMs: getEnvInt("ACP_LOAD_SESSION_TIMEOUT_MS", 0), // 0 = use ACPInitTimeoutMs
		ACPReconnectDelayMs:   getEnvInt("ACP_RECONNECT_DELAY_MS", 2000),
		ACPReconnectTimeoutMs: getEnvInt("ACP_RECONNECT_TIMEOUT_MS", 30000),
		ACPMaxRestartAttempts: getEnvInt("ACP_MAX_RESTART_ATTEMPTS", 3),
		ACPMessageBufferSize:  getEnvInt("ACP_MESSAGE_BUFFER_SIZE", 5000),
		ACPViewerSendBuffer:   getEnvInt("ACP_VIEWER_SEND_BUFFER", 256),
		ACPPingInterval:       getEnvDuration("ACP_PING_INTERVAL", 30*time.Second),
		ACPPongTimeout:        getEnvDuration("ACP_PONG_TIMEOUT", 10*time.Second),
		ACPPromptTimeout:      getEnvDuration("ACP_PROMPT_TIMEOUT", 0),
		ACPTaskPromptTimeout:  getEnvDuration("ACP_TASK_PROMPT_TIMEOUT", 6*time.Hour),
		ACPPromptCancelGrace:  getEnvDuration("ACP_PROMPT_CANCEL_GRACE_PERIOD", 5*time.Second),
		ACPIdleSuspendTimeout:    getEnvDuration("ACP_IDLE_SUSPEND_TIMEOUT", 30*time.Minute),
		ACPNotifSerializeTimeout: getEnvDuration("ACP_NOTIF_SERIALIZE_TIMEOUT", 5*time.Second),
		ACPHeartbeatInterval:     getEnvDuration("ACP_HEARTBEAT_INTERVAL", 60*time.Second),

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

		// Default installs Node.js (required by ACP adapters) and claude-agent-acp.
		// Override via ADDITIONAL_FEATURES env var. Set to empty string to disable.
		AdditionalFeatures: getEnv("ADDITIONAL_FEATURES", DefaultAdditionalFeatures),

		// Default devcontainer settings for repos without their own config.
		DefaultDevcontainerImage:      getEnv("DEFAULT_DEVCONTAINER_IMAGE", DefaultDevcontainerImage),
		DefaultDevcontainerConfigPath: getEnv("DEFAULT_DEVCONTAINER_CONFIG_PATH", DefaultDevcontainerConfigPath),
		DefaultDevcontainerRemoteUser: getEnv("DEFAULT_DEVCONTAINER_REMOTE_USER", ""), // Empty = omit, use image default

		// Project linkage (set via cloud-init)
		ProjectID:     getEnv("PROJECT_ID", ""),
		ChatSessionID: getEnv("CHAT_SESSION_ID", ""),
		TaskID:        getEnv("TASK_ID", ""),
		TaskMode:      getEnv("TASK_MODE", "task"),

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
		FileRawMaxSize:     getEnvInt("FILE_RAW_MAX_SIZE", 50*1024*1024), // 50 MB
		FileRawTimeout:     getEnvDuration("FILE_RAW_TIMEOUT", 60*time.Second),

		// File transfer settings
		FileUploadMaxBytes:      getEnvInt64("FILE_UPLOAD_MAX_BYTES", 50*1024*1024),        // 50 MB
		FileUploadBatchMaxBytes: getEnvInt64("FILE_UPLOAD_BATCH_MAX_BYTES", 250*1024*1024),  // 250 MB
		FileUploadTimeout:       getEnvDuration("FILE_UPLOAD_TIMEOUT", 120*time.Second),
		FileDownloadTimeout:     getEnvDuration("FILE_DOWNLOAD_TIMEOUT", 60*time.Second),
		FileDownloadMaxBytes:    getEnvInt64("FILE_DOWNLOAD_MAX_BYTES", 50*1024*1024),       // 50 MB

		// Callback retry settings - configurable per constitution principle XI
		WorkspaceReadyCallbackTimeout: getEnvDuration("WORKSPACE_READY_CALLBACK_TIMEOUT", 10*time.Second),

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

		// TLS settings - configurable per constitution principle XI
		TLSCertPath: getEnv("TLS_CERT_PATH", ""),
		TLSKeyPath:  getEnv("TLS_KEY_PATH", ""),

		// Port scanning settings - configurable per constitution principle XI
		PortScanEnabled:      getEnvBool("PORT_SCAN_ENABLED", true),
		PortScanInterval:     getEnvDuration("PORT_SCAN_INTERVAL", 5*time.Second),
		PortScanExclude:      getEnv("PORT_SCAN_EXCLUDE", "22,2375,2376,8443"),
		PortScanEphemeralMin: getEnvInt("PORT_SCAN_EPHEMERAL_MIN", 32768),
		PortProxyCacheTTL:    getEnvDuration("PORT_PROXY_CACHE_TTL", 30*time.Second),

		// Neko browser sidecar settings - configurable per constitution principle XI
		NekoImage:               getEnv("NEKO_IMAGE", "ghcr.io/m1k1o/neko/google-chrome:latest"),
		NekoScreenResolution:    getEnv("NEKO_SCREEN_RESOLUTION", "1920x1080"),
		NekoMaxFPS:              getEnvInt("NEKO_MAX_FPS", 30),
		NekoWebRTCPort:          getEnvInt("NEKO_WEBRTC_PORT", 6080),
		NekoSocatPollInterval:   getEnvDuration("NEKO_SOCAT_POLL_INTERVAL", 5*time.Second),
		NekoMinRAMMB:            getEnvInt("NEKO_MIN_RAM_MB", 2048),
		NekoEnableAudio:         getEnvBool("NEKO_ENABLE_AUDIO", true),
		NekoTCPFallback:         getEnvBool("NEKO_TCP_FALLBACK", true),
		NekoMuxPort:             getEnvInt("NEKO_MUX_PORT", 59000),
		NekoNAT1TO1:             getEnv("NEKO_NAT1TO1", ""),
		NekoPassword:            getEnvOrGenerate("NEKO_PASSWORD", 16),
		NekoPasswordAdmin:       getEnvOrGenerate("NEKO_PASSWORD_ADMIN", 16),
		NekoShmSize:             getEnv("NEKO_SHM_SIZE", "2g"),
		NekoBrowserStartTimeout: getEnvDuration("NEKO_BROWSER_START_TIMEOUT", 60*time.Second),
		NekoBrowserStopTimeout:  getEnvDuration("NEKO_BROWSER_STOP_TIMEOUT", 30*time.Second),
		NekoMemoryLimit:         getEnv("NEKO_MEMORY_LIMIT", "4g"),
		NekoCPULimit:            getEnv("NEKO_CPU_LIMIT", "2"),
		NekoPidsLimit:           getEnvInt("NEKO_PIDS_LIMIT", 512),
		NekoSocatMinPort:        getEnvInt("NEKO_SOCAT_MIN_PORT", 1024),
		NekoSocatMaxPort:        getEnvInt("NEKO_SOCAT_MAX_PORT", 65535),
		NekoViewportMinWidth:    getEnvInt("NEKO_VIEWPORT_MIN_WIDTH", 320),
		NekoViewportMaxWidth:    getEnvInt("NEKO_VIEWPORT_MAX_WIDTH", 7680),
		NekoViewportMinHeight:   getEnvInt("NEKO_VIEWPORT_MIN_HEIGHT", 240),
		NekoViewportMaxHeight:   getEnvInt("NEKO_VIEWPORT_MAX_HEIGHT", 4320),
		NekoViewportMaxDPR:      getEnvInt("NEKO_VIEWPORT_MAX_DPR", 4),
	}

	// Derive TLS enabled state from cert/key paths
	certSet := cfg.TLSCertPath != ""
	keySet := cfg.TLSKeyPath != ""
	if certSet != keySet {
		return nil, fmt.Errorf(
			"TLS misconfiguration: TLS_CERT_PATH and TLS_KEY_PATH must both be set or both be empty "+
				"(cert=%q, key=%q)", cfg.TLSCertPath, cfg.TLSKeyPath)
	}
	cfg.TLSEnabled = certSet && keySet

	if cfg.TLSEnabled {
		if _, err := os.Stat(cfg.TLSCertPath); err != nil {
			return nil, fmt.Errorf("TLS_CERT_PATH %q: %w", cfg.TLSCertPath, err)
		}
		if _, err := os.Stat(cfg.TLSKeyPath); err != nil {
			return nil, fmt.Errorf("TLS_KEY_PATH %q: %w", cfg.TLSKeyPath, err)
		}
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

	// Validate TaskMode enum
	switch cfg.TaskMode {
	case TaskModeTask, TaskModeConversation:
		// valid
	default:
		return nil, fmt.Errorf("TASK_MODE must be %q or %q, got %q", TaskModeTask, TaskModeConversation, cfg.TaskMode)
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

// BuildSAMEnvFallback returns KEY=value pairs for SAM environment variables
// derived from the vm-agent config. Used as fallback injection into ACP sessions
// when the bootstrap-written /etc/sam/env file is missing or incomplete.
func (c *Config) BuildSAMEnvFallback() []string {
	baseDomain := DeriveBaseDomain(c.ControlPlaneURL)

	type entry struct{ key, value string }
	entries := []entry{
		{"SAM_API_URL", strings.TrimRight(c.ControlPlaneURL, "/")},
		{"SAM_BRANCH", c.Branch},
		{"SAM_NODE_ID", c.NodeID},
		{"SAM_PROJECT_ID", c.ProjectID},
		{"SAM_CHAT_SESSION_ID", c.ChatSessionID},
		{"SAM_TASK_ID", c.TaskID},
		{"SAM_TASK_MODE", c.TaskMode},
		{"SAM_REPOSITORY", c.Repository},
		{"SAM_WORKSPACE_ID", c.WorkspaceID},
	}
	if baseDomain != "" {
		entries = append(entries, entry{"SAM_BASE_DOMAIN", baseDomain})
		if c.WorkspaceID != "" {
			entries = append(entries, entry{"SAM_WORKSPACE_URL", fmt.Sprintf("https://ws-%s.%s", c.WorkspaceID, baseDomain)})
		}
	}

	var result []string
	for _, e := range entries {
		if e.value != "" {
			result = append(result, e.key+"="+e.value)
		}
	}
	return result
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

