package config

import "time"

const (
	// DefaultGracefulShutdownTimeout bounds HTTP server shutdown after SIGTERM.
	// Override via GRACEFUL_SHUTDOWN_TIMEOUT.
	DefaultGracefulShutdownTimeout = 30 * time.Second

	// DefaultSystemProvisioningTimeout bounds workspace host provisioning before
	// bootstrap. Override via SYSTEM_PROVISIONING_TIMEOUT.
	DefaultSystemProvisioningTimeout = 15 * time.Minute

	// DefaultCFIPFetchTimeout bounds Cloudflare IP range fetches during
	// provisioning firewall setup. Override via CF_IP_FETCH_TIMEOUT.
	DefaultCFIPFetchTimeout = 10 * time.Second

	// DefaultBootLogHTTPTimeout bounds boot-log callbacks to the control plane.
	// Override via BOOT_LOG_HTTP_TIMEOUT.
	DefaultBootLogHTTPTimeout = 10 * time.Second

	// DefaultMCPShortCommandTimeout bounds short MCP workspace command probes.
	// Override via MCP_SHORT_COMMAND_TIMEOUT.
	DefaultMCPShortCommandTimeout = 10 * time.Second

	// DefaultMCPDiffCommandTimeout bounds MCP diff-summary command probes.
	// Override via MCP_DIFF_COMMAND_TIMEOUT.
	DefaultMCPDiffCommandTimeout = 30 * time.Second

	// DefaultMCPBuildPrepareTimeout bounds MCP build/publish preparation probes.
	// Override via MCP_BUILD_PREPARE_TIMEOUT.
	DefaultMCPBuildPrepareTimeout = 30 * time.Second

	// DefaultACPCredentialSyncTimeout bounds ACP auth-file sync-back during shutdown.
	// Override via ACP_CREDENTIAL_SYNC_TIMEOUT.
	DefaultACPCredentialSyncTimeout = 10 * time.Second

	// DefaultACPActivityReportTimeout preserves the per-attempt activity callback
	// timeout used before it became configurable. Override via
	// ACP_ACTIVITY_REPORT_TIMEOUT.
	DefaultACPActivityReportTimeout = 10 * time.Second

	// DefaultDevcontainerCachePushTimeout bounds best-effort devcontainer cache pushes.
	// Override via DEVCONTAINER_CACHE_PUSH_TIMEOUT.
	DefaultDevcontainerCachePushTimeout = 10 * time.Minute

	// DefaultDeployPreflightCommandTimeout bounds deployment preflight diagnostics.
	// Override via DEPLOY_PREFLIGHT_COMMAND_TIMEOUT.
	DefaultDeployPreflightCommandTimeout = 15 * time.Second

	// DefaultJWKSFetchTimeout bounds VM-agent startup JWKS fetches.
	// Override via JWKS_FETCH_TIMEOUT.
	DefaultJWKSFetchTimeout = 10 * time.Second

	// DefaultLogStreamPingWriteTimeout bounds log-stream WebSocket ping writes.
	// Override via LOG_STREAM_PING_WRITE_TIMEOUT.
	DefaultLogStreamPingWriteTimeout = 10 * time.Second

	// DefaultWorkspaceReadyCallbackTimeout preserves the workspace-ready retry
	// request timeout used before it was threaded through Config.
	DefaultWorkspaceReadyCallbackTimeout = 30 * time.Second
)
