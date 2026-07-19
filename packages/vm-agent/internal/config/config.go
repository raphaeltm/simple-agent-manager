// Package config provides configuration loading for the VM Agent.
package config

import (
	"errors"
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
// Uses the Node 22 devcontainer image so lightweight workspaces have a compatible Node.js runtime
// without a slow apt-get install step. Override via DEFAULT_DEVCONTAINER_IMAGE env var.
const DefaultDevcontainerImage = "mcr.microsoft.com/devcontainers/typescript-node:22-bookworm"

// DefaultDevcontainerConfigPath is where the VM agent writes the default devcontainer.json
// when a repo has no devcontainer config. Override via DEFAULT_DEVCONTAINER_CONFIG_PATH env var.
const DefaultDevcontainerConfigPath = "/etc/sam/default-devcontainer.json"

const (
	// DefaultACPRecoveryWatchdogTimeout bounds crash recovery after an ACP
	// disconnect. Override via DEFAULT_RECOVERY_WATCHDOG_TIMEOUT.
	DefaultACPRecoveryWatchdogTimeout = 2 * time.Minute

	// DefaultACPRestartDecayWindow is the quiet period after which restartCount
	// resets. Override via DEFAULT_RESTART_DECAY_WINDOW.
	DefaultACPRestartDecayWindow = 5 * time.Minute

	// DefaultACPActivityRereportInterval refreshes prompt activity while a
	// prompt is in flight. Override via ACTIVITY_REREPORT_INTERVAL.
	DefaultACPActivityRereportInterval = 60 * time.Second

	// DefaultACPTerminalActivityReportAttempts is the retry budget for
	// terminal/error activity reports. Override via ACTIVITY_TERMINAL_REPORT_ATTEMPTS.
	DefaultACPTerminalActivityReportAttempts = 5

	// DefaultACPTerminalActivityReportBackoff is the delay between terminal
	// activity report retries. Override via ACTIVITY_TERMINAL_REPORT_BACKOFF.
	DefaultACPTerminalActivityReportBackoff = time.Second

	// DefaultGitCredentialTimeout bounds credential-helper calls back to the
	// local VM agent. Override via GIT_CREDENTIAL_TIMEOUT.
	DefaultGitCredentialTimeout = 5 * time.Second

	// DefaultStandaloneCloneFilter is the git partial-clone filter used by
	// standalone (container) workspace preparation. Blobless clones skip all
	// history blobs that are not in the checked-out tree, keeping clone time
	// proportional to the working tree instead of the full pack — critical
	// because standalone clones run synchronously inside the control plane's
	// create-workspace request deadline. Override via STANDALONE_CLONE_FILTER;
	// set to "off" (or "none"/"false") to force a full clone.
	DefaultStandaloneCloneFilter = "blob:none"
)

const (
	// DefaultDeployArtifactDialTimeout bounds TCP connection establishment for
	// artifact downloads without imposing a total body-read deadline. Override
	// via DEPLOY_ARTIFACT_DIAL_TIMEOUT.
	DefaultDeployArtifactDialTimeout = 30 * time.Second

	// DefaultDeployArtifactTLSHandshakeTimeout bounds TLS handshakes for
	// artifact downloads. Override via DEPLOY_ARTIFACT_TLS_HANDSHAKE_TIMEOUT.
	DefaultDeployArtifactTLSHandshakeTimeout = 15 * time.Second

	// DefaultDeployArtifactResponseHeaderTimeout bounds waiting for the first
	// response headers. Override via DEPLOY_ARTIFACT_RESPONSE_HEADER_TIMEOUT.
	DefaultDeployArtifactResponseHeaderTimeout = 60 * time.Second

	// DefaultDeployArtifactIdleTimeout bounds lack of body-read progress. Slow
	// transfers that keep yielding bytes are allowed to continue. Override via
	// DEPLOY_ARTIFACT_IDLE_TIMEOUT.
	DefaultDeployArtifactIdleTimeout = 2 * time.Minute

	// DefaultDeployApplyIdleTimeout bounds deployment apply goroutines only when
	// no progress events have been emitted. Override via DEPLOY_APPLY_IDLE_TIMEOUT.
	DefaultDeployApplyIdleTimeout = 15 * time.Minute

	// DefaultDeployBuildPublishTimeout bounds host build + push + release publish
	// work. Override via DEPLOY_BUILD_PUBLISH_TIMEOUT.
	DefaultDeployBuildPublishTimeout = 20 * time.Minute

	// DefaultDeployTeardownTimeout bounds per-environment deployment teardown.
	// Override via DEPLOY_TEARDOWN_TIMEOUT.
	DefaultDeployTeardownTimeout = 2 * time.Minute
)

// Node role constants.
const (
	RoleWorkspace  = "workspace"
	RoleDeployment = "deployment"
	RoleStandalone = "standalone"
)

// Config holds all configuration values for the VM Agent.
type Config struct {
	// Node role: "workspace" (default), "deployment", or "standalone"
	Role string

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
	RepoProvider       string
	CloneURL           string
	RepositoryHost     string
	RepositoryPath     string
	WorkspaceDir       string
	BootstrapStatePath string
	BootstrapMaxWait   time.Duration
	BootstrapTimeout   time.Duration // Overall bootstrap timeout including devcontainer build

	// StandaloneCloneFilter is the resolved git partial-clone filter for
	// standalone (container) workspace clones. Empty means "full clone".
	// See DefaultStandaloneCloneFilter and env STANDALONE_CLONE_FILTER.
	StandaloneCloneFilter string

	// Session settings
	SessionTTL             time.Duration
	SessionCleanupInterval time.Duration
	SessionMaxCount        int
	CookieName             string
	CookieSecure           bool

	// Node health reporter interval
	HeartbeatInterval time.Duration

	// HTTP server timeouts
	HTTPReadTimeout     time.Duration
	HTTPWriteTimeout    time.Duration
	HTTPIdleTimeout     time.Duration
	HTTPCallbackTimeout time.Duration // timeout for outbound HTTP callbacks to the control plane

	// WebSocket settings
	WSReadBufferSize           int
	WSWriteBufferSize          int
	TerminalWSMaxMessageBytes  int64
	TerminalWSReadTimeout      time.Duration
	TerminalWSPingInterval     time.Duration
	TerminalWSMessageRate      int
	TerminalWSMessageBurst     int
	TerminalSessionIDMaxLength int

	// PTY settings
	DefaultShell string
	DefaultRows  int
	DefaultCols  int

	// PTY session persistence settings - configurable per constitution principle XI
	PTYOrphanGracePeriod time.Duration // How long orphaned sessions survive before cleanup (0 = disabled)
	PTYOutputBufferSize  int           // Ring buffer capacity per session in bytes
	PTYCloseGracePeriod  time.Duration // Bounded wait after graceful PTY close signals (env: PTY_CLOSE_GRACE_PERIOD)

	// ACP settings - configurable per constitution principle XI
	ACPInitTimeoutMs                  int // Fallback timeout for all ACP init phases (default: 30000ms)
	ACPInitializeTimeoutMs            int // Per-phase timeout for Initialize RPC; 0 = use ACPInitTimeoutMs (default: 0)
	ACPNewSessionTimeoutMs            int // Per-phase timeout for NewSession RPC; 0 = use ACPInitTimeoutMs (default: 0)
	ACPLoadSessionTimeoutMs           int // Per-phase timeout for LoadSession RPC; 0 = use ACPInitTimeoutMs (default: 0)
	ACPReconnectDelayMs               int
	ACPReconnectTimeoutMs             int
	ACPMaxRestartAttempts             int
	ACPMessageBufferSize              int           // Max buffered messages per SessionHost for late-join replay
	ACPViewerSendBuffer               int           // Per-viewer send channel buffer size
	ACPStderrBufferBytes              int           // Max agent stderr bytes retained for crash reports
	ACPPingInterval                   time.Duration // WebSocket ping interval (default: 30s)
	ACPPongTimeout                    time.Duration // WebSocket pong deadline after ping (default: 10s)
	ACPPromptTimeout                  time.Duration // Max prompt runtime; 0 = no timeout (default: 0). Used for workspace sessions; task sessions use ACPTaskPromptTimeout via effectivePromptTimeout().
	ACPTaskPromptTimeout              time.Duration // Max prompt runtime for task-driven sessions; 0 = no timeout (default: 6h)
	ACPPromptCancelGrace              time.Duration // Wait after cancel before force-stop fallback (default: 5s)
	ACPPromptRetryMaxRetries          int           // Retryable transient provider prompt errors after initial attempt (default: 2)
	ACPPromptRetryInitial             time.Duration // Initial backoff for transient provider prompt retries (default: 15s)
	ACPPromptRetryMax                 time.Duration // Max backoff for transient provider prompt retries (default: 2m)
	ACPRecoveryWatchdog               time.Duration // Max crash recovery duration before terminal error (default: 2m)
	ACPRestartDecayWindow             time.Duration // Quiet period before restartCount decays (default: 5m)
	ACPIdleSuspendTimeout             time.Duration // Auto-suspend after this idle duration with no viewers (default: 30m, 0=disabled)
	ACPNotifSerializeTimeout          time.Duration // Max wait for previous notification processing before delivering next (default: 5s)
	ACPHeartbeatInterval              time.Duration // Interval for direct ACP session heartbeats to control plane (default: 60s, env: ACP_HEARTBEAT_INTERVAL)
	ACPActivityRereportInterval       time.Duration // Re-report prompting while a prompt is active (default: 60s, env: ACTIVITY_REREPORT_INTERVAL)
	ACPTerminalActivityReportAttempts int           // Retry attempts for terminal activity reports (default: 5, env: ACTIVITY_TERMINAL_REPORT_ATTEMPTS)
	ACPTerminalActivityReportBackoff  time.Duration // Retry backoff for terminal activity reports (default: 1s, env: ACTIVITY_TERMINAL_REPORT_BACKOFF)

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

	// Devcontainer build timeout — prevents indefinite hangs when apt/network fails.
	// Configurable per constitution principle XI.
	DevcontainerBuildTimeout time.Duration // Max time for a single devcontainer up call (env: DEVCONTAINER_BUILD_TIMEOUT, default: 15m)

	// Devcontainer cache settings — opportunistic image caching via container registry.
	// Configurable per constitution principle XI.
	DevcontainerCacheEnabled  bool   // Enable devcontainer image caching (env: DEVCONTAINER_CACHE_ENABLED, default: false)
	DevcontainerCacheRegistry string // Container registry for cache images (env: DEVCONTAINER_CACHE_REGISTRY, default: ghcr.io)
	DevcontainerCacheUsername string // Optional registry username (env: DEVCONTAINER_CACHE_USERNAME)
	DevcontainerCachePassword string // Optional registry password/token (env: DEVCONTAINER_CACHE_PASSWORD)
	DevcontainerCacheRef      string // Optional full cache image ref (env: DEVCONTAINER_CACHE_REF)

	// Cloud provider — used for provider-specific optimizations (apt mirrors, etc.)
	Provider string // Cloud provider name (env: PROVIDER, e.g. "hetzner", "scaleway", "gcp")

	// Project linkage — set via cloud-init when the workspace belongs to a project.
	// If ProjectID is empty, the message reporter is disabled (no-op).
	ProjectID     string // Linked project ID (env: PROJECT_ID)
	ChatSessionID string // Chat session created during workspace provisioning (env: CHAT_SESSION_ID)
	TaskID        string // Task ID for task-driven workspaces (env: TASK_ID)
	TaskMode      string // Task execution mode: "task" or "conversation" (env: TASK_MODE, default: "task")

	// Persistence settings - configurable per constitution principle XI
	PersistenceDBPath string        // SQLite database path for session state persistence
	EventStoreDBPath  string        // SQLite database path for persistent event logs
	MetricsDBPath     string        // SQLite database path for resource metrics snapshots
	MetricsInterval   time.Duration // Resource metrics collection interval (default: 1m)

	// Git integration settings - configurable per constitution principle XI
	GitCredentialTimeout     time.Duration // Timeout for credential-helper callbacks (env: GIT_CREDENTIAL_TIMEOUT, default: 5s)
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
	LogReaderTimeout      time.Duration // Timeout for journalctl read commands (default: 30s)
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

	// Resource diagnostics thresholds - configurable per constitution principle XI
	DiagCPUSaturationThreshold float64 // Load per core above which build is "CPU saturated" (env: DIAG_CPU_SATURATION_THRESHOLD, default: 2.0)
	DiagMemExhaustedThreshold  float64 // Memory % above which build is "memory exhausted" (env: DIAG_MEM_EXHAUSTED_THRESHOLD, default: 90)
	DiagDiskFullThreshold      float64 // Disk % above which build is "disk full" (env: DIAG_DISK_FULL_THRESHOLD, default: 90)

	// Deployment mode settings (only used when Role == "deployment")
	EnvironmentID         string        // Deployment environment ID (env: ENVIRONMENT_ID)
	DeployBaseDir         string        // Base directory for deployment state (env: DEPLOY_BASE_DIR, default: /var/lib/sam-deploy)
	DeploySigningPubKey   string        // Ed25519 public key for payload verification, base64-encoded (env: DEPLOY_SIGNING_PUB_KEY)
	DeployRuntimeTimeout  time.Duration // Max time for deployment-node host dependency setup (env: DEPLOY_RUNTIME_TIMEOUT, default: 15m)
	DeployHealthTimeout   time.Duration // Max time to wait for container health checks (env: DEPLOY_HEALTH_TIMEOUT, default: 5m)
	DeployComposeCmd      string        // Docker Compose command (env: DEPLOY_COMPOSE_CMD, default: "docker compose")
	DeployACMEEmail       string        // Contact email for ACME/Let's Encrypt account (env: DEPLOY_ACME_EMAIL)
	DeployACMECA          string        // Optional ACME CA directory URL override, e.g. LE staging (env: DEPLOY_ACME_CA)
	DeployTeardownTimeout time.Duration // Max time for deployment environment teardown (env: DEPLOY_TEARDOWN_TIMEOUT)

	// Deployment artifact/apply watchdog settings - configurable per constitution principle XI.
	DeployArtifactDialTimeout           time.Duration // TCP dial timeout for artifact downloads (env: DEPLOY_ARTIFACT_DIAL_TIMEOUT)
	DeployArtifactTLSHandshakeTimeout   time.Duration // TLS handshake timeout for artifact downloads (env: DEPLOY_ARTIFACT_TLS_HANDSHAKE_TIMEOUT)
	DeployArtifactResponseHeaderTimeout time.Duration // Response-header timeout for artifact downloads (env: DEPLOY_ARTIFACT_RESPONSE_HEADER_TIMEOUT)
	DeployArtifactIdleTimeout           time.Duration // Max no-progress body read interval for artifact downloads (env: DEPLOY_ARTIFACT_IDLE_TIMEOUT)
	DeployApplyIdleTimeout              time.Duration // Max no-progress interval for detached apply goroutines (env: DEPLOY_APPLY_IDLE_TIMEOUT)
	DeployBuildPublishTimeout           time.Duration // Max host build/push/release publish duration (env: DEPLOY_BUILD_PUBLISH_TIMEOUT)
}

func loadCallbackToken() (string, error) {
	tokenFile := strings.TrimSpace(os.Getenv("CALLBACK_TOKEN_FILE"))
	if tokenFile == "" {
		return getEnv("CALLBACK_TOKEN", ""), nil
	}

	data, err := os.ReadFile(tokenFile)
	if err != nil {
		return "", fmt.Errorf("read callback token file: %w", err)
	}

	token := strings.TrimSpace(string(data))
	if token == "" {
		return "", errors.New("callback token file is empty")
	}

	return token, nil
}

// Load reads configuration from environment variables.
func Load() (*Config, error) {
	controlPlaneURL := getEnv("CONTROL_PLANE_URL", "")
	repository := getEnv("REPOSITORY", "")
	callbackToken, err := loadCallbackToken()
	if err != nil {
		return nil, err
	}

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
		// Node role
		Role: getEnv("NODE_ROLE", RoleWorkspace),

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
		CallbackToken:      callbackToken,
		BootstrapToken:     getEnv("BOOTSTRAP_TOKEN", ""),
		Repository:         repository,
		Branch:             getEnv("BRANCH", "main"),
		WorkspaceDir:       workspaceDir,
		BootstrapStatePath: getEnv("BOOTSTRAP_STATE_PATH", "/var/lib/vm-agent/bootstrap-state.json"),
		BootstrapMaxWait:   getEnvDuration("BOOTSTRAP_MAX_WAIT", 5*time.Minute),

		StandaloneCloneFilter: ResolveStandaloneCloneFilter(getEnv("STANDALONE_CLONE_FILTER", DefaultStandaloneCloneFilter)),
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

		// WebSocket buffer sizes and terminal socket limits - configurable per constitution
		WSReadBufferSize:           getEnvInt("WS_READ_BUFFER_SIZE", 1024),
		WSWriteBufferSize:          getEnvInt("WS_WRITE_BUFFER_SIZE", 1024),
		TerminalWSMaxMessageBytes:  int64(getEnvInt("TERMINAL_WS_MAX_MESSAGE_BYTES", DefaultTerminalWSMaxMessageBytes)),
		TerminalWSReadTimeout:      getEnvDuration("TERMINAL_WS_READ_TIMEOUT", DefaultTerminalWSReadTimeout),
		TerminalWSPingInterval:     getEnvDuration("TERMINAL_WS_PING_INTERVAL", DefaultTerminalWSPingInterval),
		TerminalWSMessageRate:      getEnvInt("TERMINAL_WS_MESSAGE_RATE", DefaultTerminalWSMessageRate),
		TerminalWSMessageBurst:     getEnvInt("TERMINAL_WS_MESSAGE_BURST", DefaultTerminalWSMessageBurst),
		TerminalSessionIDMaxLength: getEnvInt("TERMINAL_SESSION_ID_MAX_LENGTH", DefaultTerminalSessionIDMaxLength),

		DefaultShell: getEnv("DEFAULT_SHELL", "/bin/bash"),
		DefaultRows:  getEnvInt("DEFAULT_ROWS", 24),
		DefaultCols:  getEnvInt("DEFAULT_COLS", 80),

		// PTY session persistence - configurable per constitution principle XI.
		// Default keeps orphaned sessions until explicitly closed by the user.
		PTYOrphanGracePeriod: time.Duration(getEnvInt("PTY_ORPHAN_GRACE_PERIOD", 0)) * time.Second,
		PTYOutputBufferSize:  getEnvInt("PTY_OUTPUT_BUFFER_SIZE", 262144), // 256 KB default
		PTYCloseGracePeriod:  getEnvDuration("PTY_CLOSE_GRACE_PERIOD", 250*time.Millisecond),

		// ACP settings - configurable per constitution principle XI
		ACPInitTimeoutMs:                  getEnvInt("ACP_INIT_TIMEOUT_MS", 30000),
		ACPInitializeTimeoutMs:            getEnvInt("ACP_INITIALIZE_TIMEOUT_MS", 0),   // 0 = use ACPInitTimeoutMs
		ACPNewSessionTimeoutMs:            getEnvInt("ACP_NEW_SESSION_TIMEOUT_MS", 0),  // 0 = use ACPInitTimeoutMs
		ACPLoadSessionTimeoutMs:           getEnvInt("ACP_LOAD_SESSION_TIMEOUT_MS", 0), // 0 = use ACPInitTimeoutMs
		ACPReconnectDelayMs:               getEnvInt("ACP_RECONNECT_DELAY_MS", 2000),
		ACPReconnectTimeoutMs:             getEnvInt("ACP_RECONNECT_TIMEOUT_MS", 30000),
		ACPMaxRestartAttempts:             getEnvInt("ACP_MAX_RESTART_ATTEMPTS", 3),
		ACPMessageBufferSize:              getEnvInt("ACP_MESSAGE_BUFFER_SIZE", 5000),
		ACPViewerSendBuffer:               getEnvInt("ACP_VIEWER_SEND_BUFFER", 256),
		ACPStderrBufferBytes:              getEnvInt("ACP_STDERR_BUFFER_BYTES", 4096),
		ACPPingInterval:                   getEnvDuration("ACP_PING_INTERVAL", 30*time.Second),
		ACPPongTimeout:                    getEnvDuration("ACP_PONG_TIMEOUT", 10*time.Second),
		ACPPromptTimeout:                  getEnvDuration("ACP_PROMPT_TIMEOUT", 0),
		ACPTaskPromptTimeout:              getEnvDuration("ACP_TASK_PROMPT_TIMEOUT", 6*time.Hour),
		ACPPromptCancelGrace:              getEnvDuration("ACP_PROMPT_CANCEL_GRACE_PERIOD", 5*time.Second),
		ACPPromptRetryMaxRetries:          getEnvInt("ACP_PROMPT_RETRY_MAX_RETRIES", 2),
		ACPPromptRetryInitial:             getEnvDuration("ACP_PROMPT_RETRY_INITIAL_BACKOFF", 15*time.Second),
		ACPPromptRetryMax:                 getEnvDuration("ACP_PROMPT_RETRY_MAX_BACKOFF", 2*time.Minute),
		ACPRecoveryWatchdog:               getEnvDuration("DEFAULT_RECOVERY_WATCHDOG_TIMEOUT", DefaultACPRecoveryWatchdogTimeout),
		ACPRestartDecayWindow:             getEnvDuration("DEFAULT_RESTART_DECAY_WINDOW", DefaultACPRestartDecayWindow),
		ACPIdleSuspendTimeout:             getEnvDuration("ACP_IDLE_SUSPEND_TIMEOUT", 30*time.Minute),
		ACPNotifSerializeTimeout:          getEnvDuration("ACP_NOTIF_SERIALIZE_TIMEOUT", 5*time.Second),
		ACPHeartbeatInterval:              getEnvDuration("ACP_HEARTBEAT_INTERVAL", 60*time.Second),
		ACPActivityRereportInterval:       getEnvDuration("ACTIVITY_REREPORT_INTERVAL", DefaultACPActivityRereportInterval),
		ACPTerminalActivityReportAttempts: getEnvInt("ACTIVITY_TERMINAL_REPORT_ATTEMPTS", DefaultACPTerminalActivityReportAttempts),
		ACPTerminalActivityReportBackoff:  getEnvDuration("ACTIVITY_TERMINAL_REPORT_BACKOFF", DefaultACPTerminalActivityReportBackoff),

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

		// Devcontainer build timeout — prevents indefinite hangs on network failures.
		DevcontainerBuildTimeout: getEnvDuration("DEVCONTAINER_BUILD_TIMEOUT", 15*time.Minute),

		// Devcontainer cache settings — opportunistic image caching.
		DevcontainerCacheEnabled:  getEnvBool("DEVCONTAINER_CACHE_ENABLED", false),
		DevcontainerCacheRegistry: getEnv("DEVCONTAINER_CACHE_REGISTRY", "ghcr.io"),
		DevcontainerCacheUsername: getEnv("DEVCONTAINER_CACHE_USERNAME", ""),
		DevcontainerCachePassword: getEnv("DEVCONTAINER_CACHE_PASSWORD", ""),
		DevcontainerCacheRef:      getEnv("DEVCONTAINER_CACHE_REF", ""),

		// Cloud provider (set via cloud-init)
		Provider: getEnv("PROVIDER", ""),

		// Project linkage (set via cloud-init)
		ProjectID:     getEnv("PROJECT_ID", ""),
		ChatSessionID: getEnv("CHAT_SESSION_ID", ""),
		TaskID:        getEnv("TASK_ID", ""),
		TaskMode:      getEnv("TASK_MODE", "task"),

		// Persistence settings
		PersistenceDBPath: getEnv("PERSISTENCE_DB_PATH", "/var/lib/vm-agent/state.db"),
		EventStoreDBPath:  getEnv("EVENTSTORE_DB_PATH", "/var/lib/vm-agent/events.db"),
		MetricsDBPath:     getEnv("METRICS_DB_PATH", "/var/lib/vm-agent/metrics.db"),
		MetricsInterval:   getEnvDuration("METRICS_INTERVAL", time.Minute),

		// Git integration settings - configurable per constitution principle XI
		GitCredentialTimeout:     getEnvDuration("GIT_CREDENTIAL_TIMEOUT", DefaultGitCredentialTimeout),
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
		FileUploadBatchMaxBytes: getEnvInt64("FILE_UPLOAD_BATCH_MAX_BYTES", 250*1024*1024), // 250 MB
		FileUploadTimeout:       getEnvDuration("FILE_UPLOAD_TIMEOUT", 120*time.Second),
		FileDownloadTimeout:     getEnvDuration("FILE_DOWNLOAD_TIMEOUT", 60*time.Second),
		FileDownloadMaxBytes:    getEnvInt64("FILE_DOWNLOAD_MAX_BYTES", 50*1024*1024), // 50 MB

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

		DiagCPUSaturationThreshold: getEnvFloat("DIAG_CPU_SATURATION_THRESHOLD", 2.0),
		DiagMemExhaustedThreshold:  getEnvFloat("DIAG_MEM_EXHAUSTED_THRESHOLD", 90),
		DiagDiskFullThreshold:      getEnvFloat("DIAG_DISK_FULL_THRESHOLD", 90),

		// Deployment mode settings
		EnvironmentID:         getEnv("ENVIRONMENT_ID", ""),
		DeployBaseDir:         getEnv("DEPLOY_BASE_DIR", "/var/lib/sam-deploy"),
		DeploySigningPubKey:   getEnv("DEPLOY_SIGNING_PUB_KEY", ""),
		DeployRuntimeTimeout:  getEnvDuration("DEPLOY_RUNTIME_TIMEOUT", 15*time.Minute),
		DeployHealthTimeout:   getEnvDuration("DEPLOY_HEALTH_TIMEOUT", 5*time.Minute),
		DeployComposeCmd:      getEnv("DEPLOY_COMPOSE_CMD", "docker compose"),
		DeployACMEEmail:       getEnv("DEPLOY_ACME_EMAIL", ""),
		DeployACMECA:          getEnv("DEPLOY_ACME_CA", ""),
		DeployTeardownTimeout: getEnvDuration("DEPLOY_TEARDOWN_TIMEOUT", DefaultDeployTeardownTimeout),

		DeployArtifactDialTimeout:           getEnvDuration("DEPLOY_ARTIFACT_DIAL_TIMEOUT", DefaultDeployArtifactDialTimeout),
		DeployArtifactTLSHandshakeTimeout:   getEnvDuration("DEPLOY_ARTIFACT_TLS_HANDSHAKE_TIMEOUT", DefaultDeployArtifactTLSHandshakeTimeout),
		DeployArtifactResponseHeaderTimeout: getEnvDuration("DEPLOY_ARTIFACT_RESPONSE_HEADER_TIMEOUT", DefaultDeployArtifactResponseHeaderTimeout),
		DeployArtifactIdleTimeout:           getEnvDuration("DEPLOY_ARTIFACT_IDLE_TIMEOUT", DefaultDeployArtifactIdleTimeout),
		DeployApplyIdleTimeout:              getEnvDuration("DEPLOY_APPLY_IDLE_TIMEOUT", DefaultDeployApplyIdleTimeout),
		DeployBuildPublishTimeout:           getEnvDuration("DEPLOY_BUILD_PUBLISH_TIMEOUT", DefaultDeployBuildPublishTimeout),
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

	// Validate Role enum
	switch cfg.Role {
	case RoleWorkspace, RoleDeployment, RoleStandalone:
		// valid
	default:
		return nil, fmt.Errorf("NODE_ROLE must be %q, %q, or %q, got %q", RoleWorkspace, RoleDeployment, RoleStandalone, cfg.Role)
	}

	// Validate TaskMode enum (workspace mode only)
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

// IsDeploymentMode returns true if the agent is running in deployment role.
func (c *Config) IsDeploymentMode() bool {
	return c.Role == RoleDeployment
}

// IsStandaloneMode returns true if the agent is running directly inside a
// single-workspace container without Docker/devcontainer indirection.
func (c *Config) IsStandaloneMode() bool {
	return c.Role == RoleStandalone
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
