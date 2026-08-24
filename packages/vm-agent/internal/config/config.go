// Package config provides configuration loading for the VM Agent.
package config

import (
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

	// DefaultClaudeHarnessLifecycleMaxBytes bounds a single `_claude/sdkMessage`
	// extension notification. Override via CLAUDE_HARNESS_LIFECYCLE_MAX_BYTES.
	DefaultClaudeHarnessLifecycleMaxBytes = 64 * 1024

	// DefaultClaudeHarnessLifecycleMaxTasks bounds how many background tasks a
	// single harness snapshot may track. Override via
	// CLAUDE_HARNESS_LIFECYCLE_MAX_TASKS.
	DefaultClaudeHarnessLifecycleMaxTasks = 256

	// DefaultClaudeHarnessLifecycleMaxIDBytes bounds session/task identifier
	// length inside a lifecycle notification. Override via
	// CLAUDE_HARNESS_LIFECYCLE_MAX_ID_BYTES.
	DefaultClaudeHarnessLifecycleMaxIDBytes = 256

	// DefaultACPTerminalActivityReportAttempts is the retry budget for
	// terminal/error activity reports. Override via ACTIVITY_TERMINAL_REPORT_ATTEMPTS.
	DefaultACPTerminalActivityReportAttempts = 5

	// DefaultACPTerminalActivityReportBackoff is the delay between terminal
	// activity report retries. Override via ACTIVITY_TERMINAL_REPORT_BACKOFF.
	DefaultACPTerminalActivityReportBackoff = time.Second

	// DefaultACPCheckpointPreemptGrace bounds graceful ACP cancel/close before
	// checkpoint rollover force-stops the harness.
	DefaultACPCheckpointPreemptGrace = 30 * time.Second

	// DefaultACPCheckpointPreemptMaxGrace caps caller-requested graceful waits.
	DefaultACPCheckpointPreemptMaxGrace = 2 * time.Minute

	// DefaultACPCheckpointRolloverTimeout bounds the full strict restart/resume.
	DefaultACPCheckpointRolloverTimeout = 2 * time.Minute

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

	// DefaultSessionSnapshotOperationTimeout is the VM-agent deadline for one
	// asynchronous snapshot checkpoint. Override via
	// SESSION_SNAPSHOT_OPERATION_TIMEOUT.
	DefaultSessionSnapshotOperationTimeout = 15 * time.Minute

	// DefaultSessionSnapshotProgressReportInterval throttles control-plane
	// progress callbacks while a data-scaled snapshot operation is still making
	// progress. Override via SESSION_SNAPSHOT_PROGRESS_REPORT_INTERVAL.
	DefaultSessionSnapshotProgressReportInterval = 15 * time.Second

	// DefaultSessionSnapshotProgressReportTimeout bounds each best-effort
	// control-plane progress callback. Override via
	// SESSION_SNAPSHOT_PROGRESS_REPORT_TIMEOUT.
	DefaultSessionSnapshotProgressReportTimeout = 5 * time.Second
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
	BaseBranch         string
	RepoProvider       string
	CloneURL           string
	RepositoryHost     string
	RepositoryPath     string
	WorkspaceDir       string
	BootstrapStatePath string
	BootstrapMaxWait   time.Duration
	BootstrapTimeout   time.Duration // Overall bootstrap timeout including devcontainer build

	// VM-agent lifecycle/provisioning settings - configurable per constitution principle XI
	GracefulShutdownTimeout   time.Duration // Max time to wait for HTTP shutdown after SIGTERM (env: GRACEFUL_SHUTDOWN_TIMEOUT, default: 30s)
	SystemProvisioningTimeout time.Duration // Max time for workspace host provisioning (env: SYSTEM_PROVISIONING_TIMEOUT, default: 15m)
	CFIPFetchTimeout          time.Duration // Timeout for Cloudflare IP range fetches during firewall setup (env: CF_IP_FETCH_TIMEOUT, default: 10s)
	BootLogHTTPTimeout        time.Duration // Timeout for boot-log callbacks (env: BOOT_LOG_HTTP_TIMEOUT, default: 10s)
	JWKSFetchTimeout          time.Duration // Timeout for startup JWKS fetches (env: JWKS_FETCH_TIMEOUT, default: 10s)

	// StandaloneCloneFilter is the resolved git partial-clone filter for
	// standalone (container) workspace clones. Empty means "full clone".
	// See DefaultStandaloneCloneFilter and env STANDALONE_CLONE_FILTER.
	StandaloneCloneFilter string

	// Session settings
	SessionTTL                            time.Duration
	SessionCleanupInterval                time.Duration
	SessionMaxCount                       int
	SessionSnapshotOperationTimeout       time.Duration // Overall background/final snapshot deadline (env: SESSION_SNAPSHOT_OPERATION_TIMEOUT, default: 15m)
	SessionSnapshotProgressReportInterval time.Duration // Min interval between snapshot progress callbacks (env: SESSION_SNAPSHOT_PROGRESS_REPORT_INTERVAL, default: 15s)
	SessionSnapshotProgressReportTimeout  time.Duration // Timeout for each snapshot progress callback (env: SESSION_SNAPSHOT_PROGRESS_REPORT_TIMEOUT, default: 5s)
	CookieName                            string
	CookieSecure                          bool

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
	ACPTaskPromptTimeout              time.Duration // Max prompt runtime for task-driven sessions; 0 = no timeout (default: 8h)
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
	ClaudeHarnessLifecycleMaxBytes    int           // Max bytes per harness lifecycle notification (default: 65536, env: CLAUDE_HARNESS_LIFECYCLE_MAX_BYTES)
	ClaudeHarnessLifecycleMaxTasks    int           // Max tracked background tasks per snapshot (default: 256, env: CLAUDE_HARNESS_LIFECYCLE_MAX_TASKS)
	ClaudeHarnessLifecycleMaxIDBytes  int           // Max identifier length in a lifecycle notification (default: 256, env: CLAUDE_HARNESS_LIFECYCLE_MAX_ID_BYTES)
	ACPTerminalActivityReportAttempts int           // Retry attempts for terminal activity reports (default: 5, env: ACTIVITY_TERMINAL_REPORT_ATTEMPTS)
	ACPTerminalActivityReportBackoff  time.Duration // Retry backoff for terminal activity reports (default: 1s, env: ACTIVITY_TERMINAL_REPORT_BACKOFF)
	ACPCredentialSyncTimeout          time.Duration // Timeout for auth-file sync-back during shutdown (default: 10s, env: ACP_CREDENTIAL_SYNC_TIMEOUT)
	ACPActivityReportTimeout          time.Duration // Timeout for each ACP activity callback attempt (default: 10s, env: ACP_ACTIVITY_REPORT_TIMEOUT)
	ACPCheckpointPreemptGrace         time.Duration // Graceful cancel/close wait before force fallback (default: 30s, env: ACP_CHECKPOINT_PREEMPT_GRACE)
	ACPCheckpointPreemptMaxGrace      time.Duration // Maximum caller-selected grace (default: 2m, env: ACP_CHECKPOINT_PREEMPT_MAX_GRACE)
	ACPCheckpointRolloverTimeout      time.Duration // Full strict rollover operation deadline (default: 2m, env: ACP_CHECKPOINT_ROLLOVER_TIMEOUT)

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
	DevcontainerCacheEnabled     bool          // Enable devcontainer image caching (env: DEVCONTAINER_CACHE_ENABLED, default: false)
	DevcontainerCacheRegistry    string        // Container registry for cache images (env: DEVCONTAINER_CACHE_REGISTRY, default: ghcr.io)
	DevcontainerCacheUsername    string        // Optional registry username (env: DEVCONTAINER_CACHE_USERNAME)
	DevcontainerCachePassword    string        // Optional registry password/token (env: DEVCONTAINER_CACHE_PASSWORD)
	DevcontainerCacheRef         string        // Optional full cache image ref (env: DEVCONTAINER_CACHE_REF)
	DevcontainerCachePushTimeout time.Duration // Timeout for best-effort cache image push (env: DEVCONTAINER_CACHE_PUSH_TIMEOUT, default: 10m)

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

	// MCP tool command settings - configurable per constitution principle XI
	MCPShortCommandTimeout time.Duration // Timeout for short MCP workspace probes (default: 10s, env: MCP_SHORT_COMMAND_TIMEOUT)
	MCPDiffCommandTimeout  time.Duration // Timeout for MCP diff-summary commands (default: 30s, env: MCP_DIFF_COMMAND_TIMEOUT)
	MCPBuildPrepareTimeout time.Duration // Timeout for MCP build/publish preparation probes (default: 30s, env: MCP_BUILD_PREPARE_TIMEOUT)

	// Callback retry settings - configurable per constitution principle XI
	WorkspaceReadyCallbackTimeout time.Duration // HTTP timeout for workspace-ready retry callbacks (env: WORKSPACE_READY_CALLBACK_TIMEOUT, default: 30s)

	// Error reporting settings - configurable per constitution principle XI
	ErrorReportFlushInterval  time.Duration // Background flush interval (default: 30s)
	ErrorReportMaxBatchSize   int           // Immediate flush threshold (default: 10)
	ErrorReportMaxBatchBytes  int           // Maximum structured error body bytes (default: 32 KiB)
	ErrorReportMaxQueueSize   int           // Maximum durable outbox rows (default: 1000)
	ErrorReportHTTPTimeout    time.Duration // HTTP POST timeout (default: 10s)
	ErrorReportRetryInitial   time.Duration // Initial transient delivery backoff (default: 1s)
	ErrorReportRetryMax       time.Duration // Maximum transient delivery backoff (default: 5m)
	ErrorReportMaxAttempts    int           // Bounded delivery attempts (default: 20)
	ErrorReportDBPath         string        // SQLite WAL outbox path
	ErrorReportDBBusyTimeout  time.Duration // SQLite outbox contention timeout (default: 5s)
	ErrorReportSpoolDir       string        // Private automatic-evidence spool directory
	ErrorReportArtifactBytes  int64         // Maximum compressed automatic artifact bytes (default: 2 MiB)
	ErrorReportSpoolBytes     int64         // Maximum local spool bytes (default: 20 MiB)
	ErrorReportRetention      time.Duration // Maximum local outbox/spool retention (default: 24h)
	ErrorReportCollectTimeout time.Duration // Total safe collector deadline (default: 10s)
	ErrorReportCollectorDocs  int           // Maximum allowlisted collector documents (default: 8)
	ErrorReportDocumentBytes  int           // Maximum bytes per collector document (default: 128 KiB)
	ErrorReportValueDepth     int           // Recursive evidence depth bound (default: 8)
	ErrorReportValueItems     int           // Recursive evidence item bound (default: 256)
	ErrorReportStringBytes    int           // Maximum safe evidence string bytes (default: 4096)
	ErrorReportEventLimit     int           // Maximum structured events in automatic evidence (default: 100)
	ErrorReportResponseBytes  int           // Maximum control-plane response bytes read for diagnostics (default: 4096)
	ErrorReportStoredErrBytes int           // Maximum durable last-error bytes (default: 512)
	ErrorReportCollectorJobs  int           // Maximum concurrent automatic evidence collectors (default: 1)

	// System info collection settings - configurable per constitution principle XI
	SysInfoDockerTimeout  time.Duration // Timeout for Docker CLI commands in system info (default: 10s)
	SysInfoVersionTimeout time.Duration // Timeout for version check commands (default: 5s)
	SysInfoCacheTTL       time.Duration // Cache TTL for system info responses (default: 5s)

	// Log reader/stream settings - configurable per constitution principle XI
	LogReaderTimeout          time.Duration // Timeout for journalctl read commands (default: 30s)
	LogStreamPingInterval     time.Duration // WebSocket ping interval for log stream (default: 30s)
	LogStreamPongTimeout      time.Duration // WebSocket pong deadline for log stream (default: 90s)
	LogStreamPingWriteTimeout time.Duration // WebSocket ping write deadline for log stream (default: 10s)

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
	DeployPreflightCommandTimeout       time.Duration // Max deployment preflight diagnostic command duration (env: DEPLOY_PREFLIGHT_COMMAND_TIMEOUT)
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
