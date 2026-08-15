// Package config provides configuration loading for the VM Agent.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

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
	persistenceDBPath := getEnv("PERSISTENCE_DB_PATH", "/var/lib/vm-agent/state.db")
	persistenceDir := filepath.Dir(persistenceDBPath)

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
		// Must be <= API-side TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS (default 30m).
		// If larger, the API declares the workspace dead while bootstrap is still running.
		BootstrapTimeout: getEnvDuration("BOOTSTRAP_TIMEOUT", 30*time.Minute),

		GracefulShutdownTimeout:   getEnvDuration("GRACEFUL_SHUTDOWN_TIMEOUT", DefaultGracefulShutdownTimeout),
		SystemProvisioningTimeout: getEnvDuration("SYSTEM_PROVISIONING_TIMEOUT", DefaultSystemProvisioningTimeout),
		CFIPFetchTimeout:          getEnvDuration("CF_IP_FETCH_TIMEOUT", DefaultCFIPFetchTimeout),
		BootLogHTTPTimeout:        getEnvDuration("BOOT_LOG_HTTP_TIMEOUT", DefaultBootLogHTTPTimeout),
		JWKSFetchTimeout:          getEnvDuration("JWKS_FETCH_TIMEOUT", DefaultJWKSFetchTimeout),

		StandaloneCloneFilter: ResolveStandaloneCloneFilter(getEnv("STANDALONE_CLONE_FILTER", DefaultStandaloneCloneFilter)),

		SessionTTL:                            getEnvDuration("SESSION_TTL", 24*time.Hour),
		SessionCleanupInterval:                getEnvDuration("SESSION_CLEANUP_INTERVAL", 1*time.Minute),
		SessionMaxCount:                       getEnvInt("SESSION_MAX_COUNT", 100),
		SessionSnapshotOperationTimeout:       getEnvDuration("SESSION_SNAPSHOT_OPERATION_TIMEOUT", DefaultSessionSnapshotOperationTimeout),
		SessionSnapshotProgressReportInterval: getEnvDuration("SESSION_SNAPSHOT_PROGRESS_REPORT_INTERVAL", DefaultSessionSnapshotProgressReportInterval),
		SessionSnapshotProgressReportTimeout:  getEnvDuration("SESSION_SNAPSHOT_PROGRESS_REPORT_TIMEOUT", DefaultSessionSnapshotProgressReportTimeout),
		CookieName:                            getEnv("COOKIE_NAME", "vm_session"),
		CookieSecure:                          getEnvBool("COOKIE_SECURE", true),

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
		ACPTaskPromptTimeout:              getEnvDuration("ACP_TASK_PROMPT_TIMEOUT", 8*time.Hour),
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
		ACPCredentialSyncTimeout:          getEnvDuration("ACP_CREDENTIAL_SYNC_TIMEOUT", DefaultACPCredentialSyncTimeout),
		ACPActivityReportTimeout:          getEnvDuration("ACP_ACTIVITY_REPORT_TIMEOUT", DefaultACPActivityReportTimeout),
		ACPCheckpointPreemptGrace:         getEnvDuration("ACP_CHECKPOINT_PREEMPT_GRACE", DefaultACPCheckpointPreemptGrace),
		ACPCheckpointPreemptMaxGrace:      getEnvDuration("ACP_CHECKPOINT_PREEMPT_MAX_GRACE", DefaultACPCheckpointPreemptMaxGrace),
		ACPCheckpointRolloverTimeout:      getEnvDuration("ACP_CHECKPOINT_ROLLOVER_TIMEOUT", DefaultACPCheckpointRolloverTimeout),

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
		DevcontainerCacheEnabled:     getEnvBool("DEVCONTAINER_CACHE_ENABLED", false),
		DevcontainerCacheRegistry:    getEnv("DEVCONTAINER_CACHE_REGISTRY", "ghcr.io"),
		DevcontainerCacheUsername:    getEnv("DEVCONTAINER_CACHE_USERNAME", ""),
		DevcontainerCachePassword:    getEnv("DEVCONTAINER_CACHE_PASSWORD", ""),
		DevcontainerCacheRef:         getEnv("DEVCONTAINER_CACHE_REF", ""),
		DevcontainerCachePushTimeout: getEnvDuration("DEVCONTAINER_CACHE_PUSH_TIMEOUT", DefaultDevcontainerCachePushTimeout),

		// Cloud provider (set via cloud-init)
		Provider: getEnv("PROVIDER", ""),

		// Project linkage (set via cloud-init)
		ProjectID:     getEnv("PROJECT_ID", ""),
		ChatSessionID: getEnv("CHAT_SESSION_ID", ""),
		TaskID:        getEnv("TASK_ID", ""),
		TaskMode:      getEnv("TASK_MODE", "task"),

		// Persistence settings
		PersistenceDBPath: persistenceDBPath,
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

		MCPShortCommandTimeout: getEnvDuration("MCP_SHORT_COMMAND_TIMEOUT", DefaultMCPShortCommandTimeout),
		MCPDiffCommandTimeout:  getEnvDuration("MCP_DIFF_COMMAND_TIMEOUT", DefaultMCPDiffCommandTimeout),
		MCPBuildPrepareTimeout: getEnvDuration("MCP_BUILD_PREPARE_TIMEOUT", DefaultMCPBuildPrepareTimeout),

		// Callback retry settings - configurable per constitution principle XI
		WorkspaceReadyCallbackTimeout: getEnvDuration("WORKSPACE_READY_CALLBACK_TIMEOUT", DefaultWorkspaceReadyCallbackTimeout),

		// Error reporting settings - configurable per constitution principle XI
		ErrorReportFlushInterval:  getEnvDuration("ERROR_REPORT_FLUSH_INTERVAL", 30*time.Second),
		ErrorReportMaxBatchSize:   getEnvInt("ERROR_REPORT_MAX_BATCH_SIZE", 10),
		ErrorReportMaxBatchBytes:  getEnvInt("ERROR_REPORT_MAX_BATCH_BYTES", DefaultErrorReportMaxBatchBytes),
		ErrorReportMaxQueueSize:   getEnvInt("ERROR_REPORT_MAX_QUEUE_SIZE", 1000),
		ErrorReportHTTPTimeout:    getEnvDuration("ERROR_REPORT_HTTP_TIMEOUT", 10*time.Second),
		ErrorReportRetryInitial:   getEnvDuration("ERROR_REPORT_RETRY_INITIAL", DefaultErrorReportRetryInitial),
		ErrorReportRetryMax:       getEnvDuration("ERROR_REPORT_RETRY_MAX", DefaultErrorReportRetryMax),
		ErrorReportMaxAttempts:    getEnvInt("ERROR_REPORT_MAX_ATTEMPTS", DefaultErrorReportMaxAttempts),
		ErrorReportDBPath:         getEnv("ERROR_REPORT_DB_PATH", filepath.Join(persistenceDir, "error-reports.db")),
		ErrorReportDBBusyTimeout:  getEnvDuration("ERROR_REPORT_DB_BUSY_TIMEOUT", DefaultErrorReportDBBusyTimeout),
		ErrorReportSpoolDir:       getEnv("ERROR_REPORT_SPOOL_DIR", filepath.Join(persistenceDir, "diagnostic-incidents")),
		ErrorReportArtifactBytes:  getEnvInt64("ERROR_REPORT_ARTIFACT_MAX_BYTES", DefaultErrorReportArtifactMaxBytes),
		ErrorReportSpoolBytes:     getEnvInt64("ERROR_REPORT_SPOOL_MAX_BYTES", DefaultErrorReportSpoolMaxBytes),
		ErrorReportRetention:      getEnvDuration("ERROR_REPORT_RETENTION", DefaultErrorReportRetention),
		ErrorReportCollectTimeout: getEnvDuration("ERROR_REPORT_COLLECTOR_TIMEOUT", DefaultErrorReportCollectorTimeout),
		ErrorReportCollectorDocs:  getEnvInt("ERROR_REPORT_MAX_COLLECTOR_DOCS", DefaultErrorReportMaxCollectorDocs),
		ErrorReportDocumentBytes:  getEnvInt("ERROR_REPORT_MAX_DOCUMENT_BYTES", DefaultErrorReportMaxDocumentBytes),
		ErrorReportValueDepth:     getEnvInt("ERROR_REPORT_MAX_VALUE_DEPTH", DefaultErrorReportMaxValueDepth),
		ErrorReportValueItems:     getEnvInt("ERROR_REPORT_MAX_VALUE_ITEMS", DefaultErrorReportMaxValueItems),
		ErrorReportStringBytes:    getEnvInt("ERROR_REPORT_MAX_STRING_BYTES", DefaultErrorReportMaxStringBytes),
		ErrorReportEventLimit:     getEnvInt("ERROR_REPORT_EVENT_LIMIT", DefaultErrorReportEventLimit),
		ErrorReportResponseBytes:  getEnvInt("ERROR_REPORT_RESPONSE_MAX_BYTES", DefaultErrorReportResponseMaxBytes),
		ErrorReportStoredErrBytes: getEnvInt("ERROR_REPORT_STORED_ERROR_MAX_BYTES", DefaultErrorReportStoredErrorBytes),
		ErrorReportCollectorJobs:  getEnvInt("ERROR_REPORT_COLLECTOR_CONCURRENCY", DefaultErrorReportCollectorWorkers),

		// System info settings - configurable per constitution principle XI
		SysInfoDockerTimeout:  getEnvDuration("SYSINFO_DOCKER_TIMEOUT", 10*time.Second),
		SysInfoVersionTimeout: getEnvDuration("SYSINFO_VERSION_TIMEOUT", 5*time.Second),
		SysInfoCacheTTL:       getEnvDuration("SYSINFO_CACHE_TTL", 5*time.Second),

		// Log reader/stream settings - configurable per constitution principle XI
		LogReaderTimeout:          getEnvDuration("LOG_READER_TIMEOUT", 30*time.Second),
		LogStreamPingInterval:     getEnvDuration("LOG_STREAM_PING_INTERVAL", 30*time.Second),
		LogStreamPongTimeout:      getEnvDuration("LOG_STREAM_PONG_TIMEOUT", 90*time.Second),
		LogStreamPingWriteTimeout: getEnvDuration("LOG_STREAM_PING_WRITE_TIMEOUT", DefaultLogStreamPingWriteTimeout),

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
		DeployPreflightCommandTimeout:       getEnvDuration("DEPLOY_PREFLIGHT_COMMAND_TIMEOUT", DefaultDeployPreflightCommandTimeout),
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
	if cfg.ACPCheckpointPreemptGrace < 0 {
		return nil, fmt.Errorf("ACP_CHECKPOINT_PREEMPT_GRACE must be non-negative")
	}
	if cfg.ACPCheckpointPreemptMaxGrace <= 0 {
		return nil, fmt.Errorf("ACP_CHECKPOINT_PREEMPT_MAX_GRACE must be positive")
	}
	if cfg.ACPCheckpointPreemptGrace > cfg.ACPCheckpointPreemptMaxGrace {
		return nil, fmt.Errorf("ACP_CHECKPOINT_PREEMPT_GRACE must not exceed ACP_CHECKPOINT_PREEMPT_MAX_GRACE")
	}
	if cfg.ACPCheckpointRolloverTimeout <= 0 {
		return nil, fmt.Errorf("ACP_CHECKPOINT_ROLLOVER_TIMEOUT must be positive")
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
