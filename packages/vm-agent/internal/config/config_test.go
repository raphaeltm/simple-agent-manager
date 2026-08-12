package config

import (
	"bytes"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDeriveRepoDirName(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "owner/repo", in: "octo/repo", want: "repo"},
		{name: "github url with dot git", in: "https://github.com/octo/repo.git", want: "repo"},
		{name: "github url without dot git", in: "https://github.com/octo/repo", want: "repo"},
		{name: "path with trailing slash", in: "octo/repo/", want: "repo"},
		{name: "empty", in: "", want: ""},
		{name: "weird chars", in: "octo/my repo!", want: "my-repo"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := DeriveRepoDirName(tc.in)
			if got != tc.want {
				t.Fatalf("deriveRepoDirName(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestDeriveWorkspaceDir(t *testing.T) {
	t.Parallel()

	base := "/workspace"
	if got := deriveWorkspaceDir(base, "octo/repo"); got != filepath.Join(base, "repo") {
		t.Fatalf("unexpected workspace dir: %s", got)
	}
	if got := deriveWorkspaceDir(base, ""); got != base {
		t.Fatalf("expected base dir when repo empty, got: %s", got)
	}
}

func TestDeriveContainerWorkDir(t *testing.T) {
	t.Parallel()

	if got := deriveContainerWorkDir("/workspace/repo"); got != "/workspaces/repo" {
		t.Fatalf("deriveContainerWorkDir returned %q", got)
	}
	if got := deriveContainerWorkDir("/workspace"); got != "/workspaces/workspace" {
		t.Fatalf("deriveContainerWorkDir returned %q", got)
	}
	if got := deriveContainerWorkDir(""); got != "/workspaces" {
		t.Fatalf("deriveContainerWorkDir returned %q", got)
	}
}

func TestLoadDerivesWorkspaceAndContainerDefaults(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("REPOSITORY", "octo/repo")
	t.Setenv("WORKSPACE_BASE_DIR", "/workspace")
	t.Setenv("WORKSPACE_DIR", "")
	t.Setenv("CONTAINER_LABEL_VALUE", "")
	t.Setenv("CONTAINER_WORK_DIR", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}

	if cfg.WorkspaceDir != "/workspace/repo" {
		t.Fatalf("WorkspaceDir=%q, want %q", cfg.WorkspaceDir, "/workspace/repo")
	}
	if cfg.ContainerLabelValue != "/workspace/repo" {
		t.Fatalf("ContainerLabelValue=%q, want %q", cfg.ContainerLabelValue, "/workspace/repo")
	}
	if cfg.ContainerWorkDir != "/workspaces/repo" {
		t.Fatalf("ContainerWorkDir=%q, want %q", cfg.ContainerWorkDir, "/workspaces/repo")
	}
}

func TestLoadCallbackTokenFromFile(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "callback-token")
	if err := os.WriteFile(tokenPath, []byte(" file-token-123\n"), 0o600); err != nil {
		t.Fatalf("write token file: %v", err)
	}
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("CALLBACK_TOKEN", "env-token-legacy")
	t.Setenv("CALLBACK_TOKEN_FILE", tokenPath)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.CallbackToken != "file-token-123" {
		t.Fatalf("CallbackToken=%q, want token from file", cfg.CallbackToken)
	}
}

func TestLoadCallbackTokenFileFailsClosed(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("CALLBACK_TOKEN", "env-token-legacy")
	t.Setenv("CALLBACK_TOKEN_FILE", filepath.Join(t.TempDir(), "missing-token"))

	_, err := Load()
	if err == nil {
		t.Fatal("Load should fail when CALLBACK_TOKEN_FILE is set but unreadable")
	}
	if !strings.Contains(err.Error(), "read callback token file") {
		t.Fatalf("expected callback token file error, got: %v", err)
	}
}

func TestLoadCallbackTokenEnvFallback(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("CALLBACK_TOKEN", "env-token-legacy")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.CallbackToken != "env-token-legacy" {
		t.Fatalf("CallbackToken=%q, want env fallback", cfg.CallbackToken)
	}
}

func TestLoadDurableErrorReportGuardrails(t *testing.T) {
	persistenceDir := t.TempDir()
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("PERSISTENCE_DB_PATH", filepath.Join(persistenceDir, "state.db"))
	t.Setenv("ERROR_REPORT_FLUSH_INTERVAL", "11s")
	t.Setenv("ERROR_REPORT_MAX_BATCH_SIZE", "4")
	t.Setenv("ERROR_REPORT_MAX_BATCH_BYTES", "12000")
	t.Setenv("ERROR_REPORT_MAX_QUEUE_SIZE", "44")
	t.Setenv("ERROR_REPORT_HTTP_TIMEOUT", "12s")
	t.Setenv("ERROR_REPORT_RETRY_INITIAL", "2s")
	t.Setenv("ERROR_REPORT_RETRY_MAX", "1m")
	t.Setenv("ERROR_REPORT_MAX_ATTEMPTS", "7")
	t.Setenv("ERROR_REPORT_DB_BUSY_TIMEOUT", "750ms")
	t.Setenv("ERROR_REPORT_ARTIFACT_MAX_BYTES", "4567")
	t.Setenv("ERROR_REPORT_SPOOL_MAX_BYTES", "8901")
	t.Setenv("ERROR_REPORT_RETENTION", "2h")
	t.Setenv("ERROR_REPORT_COLLECTOR_TIMEOUT", "4s")
	t.Setenv("ERROR_REPORT_MAX_COLLECTOR_DOCS", "5")
	t.Setenv("ERROR_REPORT_MAX_DOCUMENT_BYTES", "6000")
	t.Setenv("ERROR_REPORT_MAX_VALUE_DEPTH", "6")
	t.Setenv("ERROR_REPORT_MAX_VALUE_ITEMS", "77")
	t.Setenv("ERROR_REPORT_MAX_STRING_BYTES", "888")
	t.Setenv("ERROR_REPORT_EVENT_LIMIT", "9")
	t.Setenv("ERROR_REPORT_RESPONSE_MAX_BYTES", "1234")
	t.Setenv("ERROR_REPORT_STORED_ERROR_MAX_BYTES", "321")
	t.Setenv("ERROR_REPORT_COLLECTOR_CONCURRENCY", "3")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.ErrorReportFlushInterval != 11*time.Second ||
		cfg.ErrorReportMaxBatchSize != 4 || cfg.ErrorReportMaxBatchBytes != 12000 ||
		cfg.ErrorReportMaxQueueSize != 44 || cfg.ErrorReportHTTPTimeout != 12*time.Second ||
		cfg.ErrorReportRetryInitial != 2*time.Second || cfg.ErrorReportRetryMax != time.Minute ||
		cfg.ErrorReportMaxAttempts != 7 || cfg.ErrorReportDBBusyTimeout != 750*time.Millisecond ||
		cfg.ErrorReportArtifactBytes != 4567 ||
		cfg.ErrorReportSpoolBytes != 8901 || cfg.ErrorReportRetention != 2*time.Hour ||
		cfg.ErrorReportCollectTimeout != 4*time.Second || cfg.ErrorReportCollectorDocs != 5 ||
		cfg.ErrorReportDocumentBytes != 6000 || cfg.ErrorReportValueDepth != 6 ||
		cfg.ErrorReportValueItems != 77 || cfg.ErrorReportStringBytes != 888 ||
		cfg.ErrorReportEventLimit != 9 || cfg.ErrorReportResponseBytes != 1234 ||
		cfg.ErrorReportStoredErrBytes != 321 || cfg.ErrorReportCollectorJobs != 3 {
		t.Fatalf("unexpected durable error report config: %#v", cfg)
	}
	if cfg.ErrorReportDBPath != filepath.Join(persistenceDir, "error-reports.db") ||
		cfg.ErrorReportSpoolDir != filepath.Join(persistenceDir, "diagnostic-incidents") {
		t.Fatalf("reporter paths did not derive from PERSISTENCE_DB_PATH: db=%q spool=%q",
			cfg.ErrorReportDBPath, cfg.ErrorReportSpoolDir)
	}
}

func TestValidateRejectsUnsafeErrorReportEventLimits(t *testing.T) {
	cfg := validConfig()
	cfg.ErrorReportEventLimit = -1
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "ERROR_REPORT_EVENT_LIMIT") {
		t.Fatalf("error=%v", err)
	}
}

func TestValidateRejectsUnsafeErrorReportBounds(t *testing.T) {
	tests := []struct {
		name string
		env  string
		set  func(*Config)
	}{
		{"response bytes", "ERROR_REPORT_RESPONSE_MAX_BYTES", func(cfg *Config) { cfg.ErrorReportResponseBytes = 0 }},
		{"stored error bytes", "ERROR_REPORT_STORED_ERROR_MAX_BYTES", func(cfg *Config) { cfg.ErrorReportStoredErrBytes = 0 }},
		{"collector concurrency", "ERROR_REPORT_COLLECTOR_CONCURRENCY", func(cfg *Config) { cfg.ErrorReportCollectorJobs = 0 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := validConfig()
			test.set(cfg)
			if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), test.env) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestAdditionalFeaturesDefault(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.AdditionalFeatures != DefaultAdditionalFeatures {
		t.Fatalf("AdditionalFeatures=%q, want default %q", cfg.AdditionalFeatures, DefaultAdditionalFeatures)
	}
}

func TestAdditionalFeaturesOverride(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("ADDITIONAL_FEATURES", `{"custom/feature:1":{}}`)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.AdditionalFeatures != `{"custom/feature:1":{}}` {
		t.Fatalf("AdditionalFeatures=%q, want custom override", cfg.AdditionalFeatures)
	}
}

func TestLoadDevcontainerCacheCredentials(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("DEVCONTAINER_CACHE_ENABLED", "true")
	t.Setenv("DEVCONTAINER_CACHE_REGISTRY", "registry.cloudflare.com")
	t.Setenv("DEVCONTAINER_CACHE_USERNAME", "cache-user")
	t.Setenv("DEVCONTAINER_CACHE_PASSWORD", "cache-password")
	t.Setenv("DEVCONTAINER_CACHE_REF", "registry.cloudflare.com/acct/octo-repo:devcontainer-cache")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if !cfg.DevcontainerCacheEnabled {
		t.Fatal("DevcontainerCacheEnabled = false, want true")
	}
	if cfg.DevcontainerCacheRegistry != "registry.cloudflare.com" {
		t.Fatalf("DevcontainerCacheRegistry = %q", cfg.DevcontainerCacheRegistry)
	}
	if cfg.DevcontainerCacheUsername != "cache-user" {
		t.Fatalf("DevcontainerCacheUsername = %q", cfg.DevcontainerCacheUsername)
	}
	if cfg.DevcontainerCachePassword != "cache-password" {
		t.Fatalf("DevcontainerCachePassword = %q", cfg.DevcontainerCachePassword)
	}
	if cfg.DevcontainerCacheRef != "registry.cloudflare.com/acct/octo-repo:devcontainer-cache" {
		t.Fatalf("DevcontainerCacheRef = %q", cfg.DevcontainerCacheRef)
	}
}

func TestLoadDefaultsContainerUserEmpty(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.ContainerUser != "" {
		t.Fatalf("ContainerUser=%q, want empty string", cfg.ContainerUser)
	}
}

func TestBootstrapTimeoutDefault(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.BootstrapTimeout != 30*time.Minute {
		t.Fatalf("BootstrapTimeout=%v, want %v", cfg.BootstrapTimeout, 30*time.Minute)
	}
}

func TestBootstrapTimeoutOverride(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("BOOTSTRAP_TIMEOUT", "20m")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.BootstrapTimeout != 20*time.Minute {
		t.Fatalf("BootstrapTimeout=%v, want %v", cfg.BootstrapTimeout, 20*time.Minute)
	}
}

func TestSessionSnapshotOperationTimeoutDefault(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.SessionSnapshotOperationTimeout != 15*time.Minute {
		t.Fatalf("SessionSnapshotOperationTimeout=%v, want %v", cfg.SessionSnapshotOperationTimeout, 15*time.Minute)
	}
}

func TestSessionSnapshotOperationTimeoutOverride(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("SESSION_SNAPSHOT_OPERATION_TIMEOUT", "7m")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.SessionSnapshotOperationTimeout != 7*time.Minute {
		t.Fatalf("SessionSnapshotOperationTimeout=%v, want %v", cfg.SessionSnapshotOperationTimeout, 7*time.Minute)
	}
}

func legacyOperationalTimeoutChecks(cfg *Config) []struct {
	name      string
	got, want time.Duration
} {
	return []struct {
		name      string
		got, want time.Duration
	}{
		{"GracefulShutdownTimeout", cfg.GracefulShutdownTimeout, 30 * time.Second},
		{"SystemProvisioningTimeout", cfg.SystemProvisioningTimeout, 15 * time.Minute},
		{"CFIPFetchTimeout", cfg.CFIPFetchTimeout, 10 * time.Second},
		{"BootLogHTTPTimeout", cfg.BootLogHTTPTimeout, 10 * time.Second},
		{"MCPShortCommandTimeout", cfg.MCPShortCommandTimeout, 10 * time.Second},
		{"MCPDiffCommandTimeout", cfg.MCPDiffCommandTimeout, 30 * time.Second},
		{"MCPBuildPrepareTimeout", cfg.MCPBuildPrepareTimeout, 30 * time.Second},
		{"JWKSFetchTimeout", cfg.JWKSFetchTimeout, 10 * time.Second},
		{"ACPCredentialSyncTimeout", cfg.ACPCredentialSyncTimeout, 10 * time.Second},
		{"ACPActivityReportTimeout", cfg.ACPActivityReportTimeout, 10 * time.Second},
		{"DevcontainerCachePushTimeout", cfg.DevcontainerCachePushTimeout, 10 * time.Minute},
		{"DeployPreflightCommandTimeout", cfg.DeployPreflightCommandTimeout, 15 * time.Second},
		{"LogStreamPingWriteTimeout", cfg.LogStreamPingWriteTimeout, 10 * time.Second},
		{"WorkspaceReadyCallbackTimeout", cfg.WorkspaceReadyCallbackTimeout, 30 * time.Second},
	}
}

func TestOperationalTimeoutDefaults(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}

	checks := legacyOperationalTimeoutChecks(cfg)
	for _, check := range checks {
		if check.got != check.want {
			t.Fatalf("%s=%v, want %v", check.name, check.got, check.want)
		}
	}
}

func TestOperationalTimeoutOverrides(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("GRACEFUL_SHUTDOWN_TIMEOUT", "45s")
	t.Setenv("SYSTEM_PROVISIONING_TIMEOUT", "17m")
	t.Setenv("CF_IP_FETCH_TIMEOUT", "11s")
	t.Setenv("BOOT_LOG_HTTP_TIMEOUT", "12s")
	t.Setenv("MCP_SHORT_COMMAND_TIMEOUT", "13s")
	t.Setenv("MCP_DIFF_COMMAND_TIMEOUT", "35s")
	t.Setenv("MCP_BUILD_PREPARE_TIMEOUT", "40s")
	t.Setenv("JWKS_FETCH_TIMEOUT", "14s")
	t.Setenv("ACP_CREDENTIAL_SYNC_TIMEOUT", "16s")
	t.Setenv("ACP_ACTIVITY_REPORT_TIMEOUT", "17s")
	t.Setenv("WORKSPACE_READY_CALLBACK_TIMEOUT", "33s")
	t.Setenv("DEVCONTAINER_CACHE_PUSH_TIMEOUT", "11m")
	t.Setenv("DEPLOY_PREFLIGHT_COMMAND_TIMEOUT", "18s")
	t.Setenv("LOG_STREAM_PING_WRITE_TIMEOUT", "19s")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}

	checks := []struct {
		name string
		got  time.Duration
		want time.Duration
	}{
		{"GracefulShutdownTimeout", cfg.GracefulShutdownTimeout, 45 * time.Second},
		{"SystemProvisioningTimeout", cfg.SystemProvisioningTimeout, 17 * time.Minute},
		{"CFIPFetchTimeout", cfg.CFIPFetchTimeout, 11 * time.Second},
		{"BootLogHTTPTimeout", cfg.BootLogHTTPTimeout, 12 * time.Second},
		{"MCPShortCommandTimeout", cfg.MCPShortCommandTimeout, 13 * time.Second},
		{"MCPDiffCommandTimeout", cfg.MCPDiffCommandTimeout, 35 * time.Second},
		{"MCPBuildPrepareTimeout", cfg.MCPBuildPrepareTimeout, 40 * time.Second},
		{"JWKSFetchTimeout", cfg.JWKSFetchTimeout, 14 * time.Second},
		{"ACPCredentialSyncTimeout", cfg.ACPCredentialSyncTimeout, 16 * time.Second},
		{"ACPActivityReportTimeout", cfg.ACPActivityReportTimeout, 17 * time.Second},
		{"WorkspaceReadyCallbackTimeout", cfg.WorkspaceReadyCallbackTimeout, 33 * time.Second},
		{"DevcontainerCachePushTimeout", cfg.DevcontainerCachePushTimeout, 11 * time.Minute},
		{"DeployPreflightCommandTimeout", cfg.DeployPreflightCommandTimeout, 18 * time.Second},
		{"LogStreamPingWriteTimeout", cfg.LogStreamPingWriteTimeout, 19 * time.Second},
	}
	for _, check := range checks {
		if check.got != check.want {
			t.Fatalf("%s=%v, want %v", check.name, check.got, check.want)
		}
	}
}

func TestInvalidOperationalTimeoutParseFallsBackAndRedactsValue(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	canary := "sk-test-secret-timeout-canary"
	envKeys := []string{
		"GRACEFUL_SHUTDOWN_TIMEOUT", "SYSTEM_PROVISIONING_TIMEOUT", "CF_IP_FETCH_TIMEOUT",
		"BOOT_LOG_HTTP_TIMEOUT", "MCP_SHORT_COMMAND_TIMEOUT", "MCP_DIFF_COMMAND_TIMEOUT",
		"MCP_BUILD_PREPARE_TIMEOUT", "JWKS_FETCH_TIMEOUT", "ACP_CREDENTIAL_SYNC_TIMEOUT",
		"ACP_ACTIVITY_REPORT_TIMEOUT", "DEVCONTAINER_CACHE_PUSH_TIMEOUT",
		"DEPLOY_PREFLIGHT_COMMAND_TIMEOUT", "LOG_STREAM_PING_WRITE_TIMEOUT",
		"WORKSPACE_READY_CALLBACK_TIMEOUT",
	}
	for _, key := range envKeys {
		t.Setenv(key, canary)
	}

	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	checks := legacyOperationalTimeoutChecks(cfg)
	for _, check := range checks {
		if check.got != check.want {
			t.Errorf("%s=%v, want fallback %v", check.name, check.got, check.want)
		}
	}
	if strings.Contains(logs.String(), canary) {
		t.Fatalf("parse warning leaked env value: %s", logs.String())
	}
	for _, key := range envKeys {
		if !strings.Contains(logs.String(), key) {
			t.Errorf("parse warning omitted env key %s: %s", key, logs.String())
		}
	}
}

func TestGitCredentialTimeoutDefault(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.GitCredentialTimeout != DefaultGitCredentialTimeout {
		t.Fatalf("GitCredentialTimeout=%v, want %v", cfg.GitCredentialTimeout, DefaultGitCredentialTimeout)
	}
}

func TestGitCredentialTimeoutOverride(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("GIT_CREDENTIAL_TIMEOUT", "1750ms")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.GitCredentialTimeout != 1750*time.Millisecond {
		t.Fatalf("GitCredentialTimeout=%v, want %v", cfg.GitCredentialTimeout, 1750*time.Millisecond)
	}
}

func TestDeployRuntimeTimeoutDefault(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("NODE_ID", "node-123")
	t.Setenv("NODE_ROLE", RoleDeployment)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.DeployRuntimeTimeout != 15*time.Minute {
		t.Fatalf("DeployRuntimeTimeout=%v, want %v", cfg.DeployRuntimeTimeout, 15*time.Minute)
	}
}

func TestDeployRuntimeTimeoutOverride(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("NODE_ID", "node-123")
	t.Setenv("NODE_ROLE", RoleDeployment)
	t.Setenv("DEPLOY_RUNTIME_TIMEOUT", "7m")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.DeployRuntimeTimeout != 7*time.Minute {
		t.Fatalf("DeployRuntimeTimeout=%v, want %v", cfg.DeployRuntimeTimeout, 7*time.Minute)
	}
}

func TestPTYOrphanGracePeriodDefaultDisabled(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.PTYOrphanGracePeriod != 0 {
		t.Fatalf("PTYOrphanGracePeriod=%v, want 0", cfg.PTYOrphanGracePeriod)
	}
}

func TestPTYOrphanGracePeriodOverride(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("PTY_ORPHAN_GRACE_PERIOD", "300")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.PTYOrphanGracePeriod != 5*time.Minute {
		t.Fatalf("PTYOrphanGracePeriod=%v, want %v", cfg.PTYOrphanGracePeriod, 5*time.Minute)
	}
}

func TestPTYCloseGracePeriodOverride(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("PTY_CLOSE_GRACE_PERIOD", "750ms")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.PTYCloseGracePeriod != 750*time.Millisecond {
		t.Fatalf("PTYCloseGracePeriod=%v, want %v", cfg.PTYCloseGracePeriod, 750*time.Millisecond)
	}
}

func TestDeriveBaseDomain(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		url  string
		want string
	}{
		{name: "api subdomain https", url: "https://api.example.com", want: "example.com"},
		{name: "api subdomain with path", url: "https://api.example.com/foo/bar", want: "example.com"},
		{name: "api subdomain with port", url: "https://api.example.com:8080", want: "example.com"},
		{name: "no api prefix", url: "https://example.com", want: "example.com"},
		{name: "http scheme", url: "http://api.localhost", want: "localhost"},
		{name: "bare host", url: "api.example.com", want: "example.com"},
		{name: "nested subdomain", url: "https://api.staging.example.com", want: "staging.example.com"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := DeriveBaseDomain(tc.url); got != tc.want {
				t.Fatalf("DeriveBaseDomain(%q) = %q, want %q", tc.url, got, tc.want)
			}
		})
	}
}

func TestBuildSAMEnvFallback(t *testing.T) {
	t.Parallel()

	cfg := &Config{
		ControlPlaneURL: "https://api.example.com",
		WorkspaceID:     "ws-123",
		NodeID:          "node-456",
		Repository:      "octo/repo",
		Branch:          "main",
		ProjectID:       "proj-789",
		ChatSessionID:   "session-abc",
		TaskID:          "task-def",
	}

	fallback := cfg.BuildSAMEnvFallback()

	want := map[string]string{
		"SAM_API_URL":         "https://api.example.com",
		"SAM_BASE_DOMAIN":     "example.com",
		"SAM_BRANCH":          "main",
		"SAM_NODE_ID":         "node-456",
		"SAM_PROJECT_ID":      "proj-789",
		"SAM_CHAT_SESSION_ID": "session-abc",
		"SAM_TASK_ID":         "task-def",
		"SAM_REPOSITORY":      "octo/repo",
		"SAM_WORKSPACE_ID":    "ws-123",
		"SAM_WORKSPACE_URL":   "https://ws-ws-123.example.com",
	}

	got := make(map[string]string)
	for _, entry := range fallback {
		parts := splitFirst(entry, "=")
		if len(parts) == 2 {
			got[parts[0]] = parts[1]
		}
	}

	for key, wantVal := range want {
		if gotVal, ok := got[key]; !ok {
			t.Errorf("fallback missing key %s", key)
		} else if gotVal != wantVal {
			t.Errorf("fallback[%s] = %q, want %q", key, gotVal, wantVal)
		}
	}
}

func TestBuildSAMEnvFallbackOmitsEmptyValues(t *testing.T) {
	t.Parallel()

	cfg := &Config{
		ControlPlaneURL: "https://api.example.com",
		WorkspaceID:     "ws-123",
		// ProjectID, ChatSessionID, TaskID left empty
	}

	fallback := cfg.BuildSAMEnvFallback()

	for _, entry := range fallback {
		parts := splitFirst(entry, "=")
		if len(parts) == 2 {
			switch parts[0] {
			case "SAM_PROJECT_ID", "SAM_CHAT_SESSION_ID", "SAM_TASK_ID":
				t.Errorf("fallback should not contain %s when empty", parts[0])
			}
		}
	}
}

func TestTLSEnabledWhenBothPathsSet(t *testing.T) {
	// Create temp files so os.Stat succeeds during validation
	dir := t.TempDir()
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")
	if err := os.WriteFile(certPath, []byte("cert"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, []byte("key"), 0600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("TLS_CERT_PATH", certPath)
	t.Setenv("TLS_KEY_PATH", keyPath)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if !cfg.TLSEnabled {
		t.Fatal("TLSEnabled should be true when both paths are set")
	}
	if cfg.TLSCertPath != certPath {
		t.Fatalf("TLSCertPath=%q, want %q", cfg.TLSCertPath, certPath)
	}
	if cfg.TLSKeyPath != keyPath {
		t.Fatalf("TLSKeyPath=%q, want %q", cfg.TLSKeyPath, keyPath)
	}
}

func TestTLSFailsWhenFilesDoNotExist(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("TLS_CERT_PATH", "/nonexistent/cert.pem")
	t.Setenv("TLS_KEY_PATH", "/nonexistent/key.pem")

	_, err := Load()
	if err == nil {
		t.Fatal("Load should return error when TLS files do not exist")
	}
	if !strings.Contains(err.Error(), "TLS_CERT_PATH") {
		t.Fatalf("expected TLS_CERT_PATH error, got: %v", err)
	}
}

func TestTLSDisabledByDefault(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.TLSEnabled {
		t.Fatal("TLSEnabled should be false when no TLS paths are set")
	}
}

func TestTLSPartialConfigIsAnError(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("TLS_CERT_PATH", "/etc/sam/tls/origin-ca.pem")
	// TLS_KEY_PATH not set — partial config should error

	_, err := Load()
	if err == nil {
		t.Fatal("Load should return error when only one TLS path is set")
	}
	if !strings.Contains(err.Error(), "TLS misconfiguration") {
		t.Fatalf("expected TLS misconfiguration error, got: %v", err)
	}
}

func TestTLSPartialConfigKeyOnlyIsAnError(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("TLS_KEY_PATH", "/etc/sam/tls/origin-ca-key.pem")
	// TLS_CERT_PATH not set — partial config should error

	_, err := Load()
	if err == nil {
		t.Fatal("Load should return error when only key path is set")
	}
	if !strings.Contains(err.Error(), "TLS misconfiguration") {
		t.Fatalf("expected TLS misconfiguration error, got: %v", err)
	}
}

func TestVMAgentPortDefault(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.Port != 8080 {
		t.Fatalf("Port=%d, want 8080", cfg.Port)
	}
}

func TestVMAgentPortOverride(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("VM_AGENT_PORT", "8443")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.Port != 8443 {
		t.Fatalf("Port=%d, want 8443", cfg.Port)
	}
}

func TestACPPhaseTimeoutsDefault(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	// Per-phase defaults are 0 (use fallback InitTimeoutMs)
	if cfg.ACPInitializeTimeoutMs != 0 {
		t.Fatalf("ACPInitializeTimeoutMs=%d, want 0", cfg.ACPInitializeTimeoutMs)
	}
	if cfg.ACPNewSessionTimeoutMs != 0 {
		t.Fatalf("ACPNewSessionTimeoutMs=%d, want 0", cfg.ACPNewSessionTimeoutMs)
	}
	if cfg.ACPLoadSessionTimeoutMs != 0 {
		t.Fatalf("ACPLoadSessionTimeoutMs=%d, want 0", cfg.ACPLoadSessionTimeoutMs)
	}
	// Fallback still defaults to 30s
	if cfg.ACPInitTimeoutMs != 30000 {
		t.Fatalf("ACPInitTimeoutMs=%d, want 30000", cfg.ACPInitTimeoutMs)
	}
	if cfg.ACPStderrBufferBytes != 4096 {
		t.Fatalf("ACPStderrBufferBytes=%d, want 4096", cfg.ACPStderrBufferBytes)
	}
}

func TestACPPhaseTimeoutsOverride(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("ACP_INITIALIZE_TIMEOUT_MS", "45000")
	t.Setenv("ACP_NEW_SESSION_TIMEOUT_MS", "60000")
	t.Setenv("ACP_LOAD_SESSION_TIMEOUT_MS", "20000")
	t.Setenv("ACP_STDERR_BUFFER_BYTES", "8192")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.ACPInitializeTimeoutMs != 45000 {
		t.Fatalf("ACPInitializeTimeoutMs=%d, want 45000", cfg.ACPInitializeTimeoutMs)
	}
	if cfg.ACPNewSessionTimeoutMs != 60000 {
		t.Fatalf("ACPNewSessionTimeoutMs=%d, want 60000", cfg.ACPNewSessionTimeoutMs)
	}
	if cfg.ACPLoadSessionTimeoutMs != 20000 {
		t.Fatalf("ACPLoadSessionTimeoutMs=%d, want 20000", cfg.ACPLoadSessionTimeoutMs)
	}
	if cfg.ACPStderrBufferBytes != 8192 {
		t.Fatalf("ACPStderrBufferBytes=%d, want 8192", cfg.ACPStderrBufferBytes)
	}
}

// splitFirst splits s on the first occurrence of sep.
func splitFirst(s, sep string) []string {
	idx := len(sep)
	for i := 0; i <= len(s)-len(sep); i++ {
		if s[i:i+len(sep)] == sep {
			return []string{s[:i], s[i+idx:]}
		}
	}
	return []string{s}
}

// --- Validate() tests ---

// validConfig returns a Config with all required fields set to valid values.
func validConfig() *Config {
	return &Config{
		Port:                          8080,
		ControlPlaneURL:               "https://api.example.com",
		NodeID:                        "node-1",
		SessionMaxCount:               100,
		DefaultRows:                   24,
		DefaultCols:                   80,
		WSReadBufferSize:              1024,
		WSWriteBufferSize:             1024,
		TerminalWSMaxMessageBytes:     DefaultTerminalWSMaxMessageBytes,
		TerminalWSReadTimeout:         DefaultTerminalWSReadTimeout,
		TerminalWSPingInterval:        DefaultTerminalWSPingInterval,
		TerminalWSMessageRate:         DefaultTerminalWSMessageRate,
		TerminalWSMessageBurst:        DefaultTerminalWSMessageBurst,
		TerminalSessionIDMaxLength:    DefaultTerminalSessionIDMaxLength,
		GitCredentialTimeout:          DefaultGitCredentialTimeout,
		GracefulShutdownTimeout:       DefaultGracefulShutdownTimeout,
		BootstrapMaxWait:              5 * time.Minute,
		BootstrapTimeout:              30 * time.Minute,
		SystemProvisioningTimeout:     DefaultSystemProvisioningTimeout,
		CFIPFetchTimeout:              DefaultCFIPFetchTimeout,
		BootLogHTTPTimeout:            DefaultBootLogHTTPTimeout,
		HTTPReadTimeout:               15 * time.Second,
		HTTPWriteTimeout:              15 * time.Second,
		HTTPIdleTimeout:               60 * time.Second,
		HTTPCallbackTimeout:           30 * time.Second,
		MCPShortCommandTimeout:        DefaultMCPShortCommandTimeout,
		MCPDiffCommandTimeout:         DefaultMCPDiffCommandTimeout,
		MCPBuildPrepareTimeout:        DefaultMCPBuildPrepareTimeout,
		JWKSFetchTimeout:              DefaultJWKSFetchTimeout,
		ACPCredentialSyncTimeout:      DefaultACPCredentialSyncTimeout,
		ACPActivityReportTimeout:      DefaultACPActivityReportTimeout,
		WorkspaceReadyCallbackTimeout: DefaultWorkspaceReadyCallbackTimeout,
		ErrorReportResponseBytes:      DefaultErrorReportResponseMaxBytes,
		ErrorReportStoredErrBytes:     DefaultErrorReportStoredErrorBytes,
		ErrorReportCollectorJobs:      DefaultErrorReportCollectorWorkers,
		DevcontainerCachePushTimeout:  DefaultDevcontainerCachePushTimeout,
		DeployPreflightCommandTimeout: DefaultDeployPreflightCommandTimeout,
		LogStreamPingWriteTimeout:     DefaultLogStreamPingWriteTimeout,
	}
}

func TestValidateGitCredentialTimeout(t *testing.T) {
	t.Parallel()
	cfg := validConfig()
	cfg.GitCredentialTimeout = 0
	err := cfg.Validate()
	if err == nil {
		t.Fatal("Validate() should return error for GitCredentialTimeout = 0")
	}
	if !strings.Contains(err.Error(), "GIT_CREDENTIAL_TIMEOUT") {
		t.Fatalf("expected GIT_CREDENTIAL_TIMEOUT error, got: %v", err)
	}
}

func TestValidateOperationalTimeouts(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		mutate  func(*Config)
		wantKey string
	}{
		{"graceful shutdown", func(cfg *Config) { cfg.GracefulShutdownTimeout = 0 }, "GRACEFUL_SHUTDOWN_TIMEOUT"},
		{"system provisioning", func(cfg *Config) { cfg.SystemProvisioningTimeout = -time.Second }, "SYSTEM_PROVISIONING_TIMEOUT"},
		{"cf ip fetch", func(cfg *Config) { cfg.CFIPFetchTimeout = 0 }, "CF_IP_FETCH_TIMEOUT"},
		{"boot log http", func(cfg *Config) { cfg.BootLogHTTPTimeout = 0 }, "BOOT_LOG_HTTP_TIMEOUT"},
		{"mcp short", func(cfg *Config) { cfg.MCPShortCommandTimeout = 0 }, "MCP_SHORT_COMMAND_TIMEOUT"},
		{"mcp diff", func(cfg *Config) { cfg.MCPDiffCommandTimeout = -time.Second }, "MCP_DIFF_COMMAND_TIMEOUT"},
		{"mcp build prepare", func(cfg *Config) { cfg.MCPBuildPrepareTimeout = 0 }, "MCP_BUILD_PREPARE_TIMEOUT"},
		{"jwks fetch", func(cfg *Config) { cfg.JWKSFetchTimeout = 0 }, "JWKS_FETCH_TIMEOUT"},
		{"credential sync", func(cfg *Config) { cfg.ACPCredentialSyncTimeout = 0 }, "ACP_CREDENTIAL_SYNC_TIMEOUT"},
		{"activity report", func(cfg *Config) { cfg.ACPActivityReportTimeout = 0 }, "ACP_ACTIVITY_REPORT_TIMEOUT"},
		{"cache push", func(cfg *Config) { cfg.DevcontainerCachePushTimeout = 0 }, "DEVCONTAINER_CACHE_PUSH_TIMEOUT"},
		{"deploy preflight", func(cfg *Config) { cfg.DeployPreflightCommandTimeout = 0 }, "DEPLOY_PREFLIGHT_COMMAND_TIMEOUT"},
		{"log stream ping write", func(cfg *Config) { cfg.LogStreamPingWriteTimeout = 0 }, "LOG_STREAM_PING_WRITE_TIMEOUT"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := validConfig()
			tc.mutate(cfg)
			err := cfg.Validate()
			if err == nil {
				t.Fatal("expected validation error")
			}
			if !strings.Contains(err.Error(), tc.wantKey) {
				t.Fatalf("expected %s error, got: %v", tc.wantKey, err)
			}
		})
	}
}

func TestValidateValidConfig(t *testing.T) {
	t.Parallel()
	cfg := validConfig()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() returned error for valid config: %v", err)
	}
}

func TestValidateValidPortBoundary(t *testing.T) {
	t.Parallel()
	cfg := validConfig()
	cfg.Port = 65535
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() returned error for port 65535: %v", err)
	}
}

func TestValidateInvalidPort(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		port int
	}{
		{"zero", 0},
		{"negative", -1},
		{"first invalid above range", 65536},
		{"too high", 70000},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := validConfig()
			cfg.Port = tc.port
			err := cfg.Validate()
			if err == nil {
				t.Fatal("Validate() should return error for invalid port")
			}
			if !strings.Contains(err.Error(), "VM_AGENT_PORT") {
				t.Fatalf("expected VM_AGENT_PORT error, got: %v", err)
			}
		})
	}
}

func TestValidateRejectsRemoteHTTPControlPlaneURL(t *testing.T) {
	t.Parallel()
	cfg := validConfig()
	cfg.ControlPlaneURL = "http://api.example.com"
	err := cfg.Validate()
	if err == nil {
		t.Fatal("expected remote HTTP control plane URL to be rejected")
	}
	if !strings.Contains(err.Error(), "CONTROL_PLANE_URL") || !strings.Contains(err.Error(), "https") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidateAllowsLocalHTTPControlPlaneURL(t *testing.T) {
	t.Parallel()

	for _, controlPlaneURL := range []string{"http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"} {
		controlPlaneURL := controlPlaneURL
		t.Run(controlPlaneURL, func(t *testing.T) {
			t.Parallel()
			cfg := validConfig()
			cfg.ControlPlaneURL = controlPlaneURL
			if err := cfg.Validate(); err != nil {
				t.Fatalf("Validate() returned error: %v", err)
			}
		})
	}
}

func TestValidateRejectsRemoteHTTPJWKSAndIssuerURLs(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		mutate func(*Config)
		want   string
	}{
		{
			name: "jwks endpoint",
			mutate: func(cfg *Config) {
				cfg.JWKSEndpoint = "http://api.example.com/.well-known/jwks.json"
			},
			want: "JWKS_ENDPOINT",
		},
		{
			name: "url issuer",
			mutate: func(cfg *Config) {
				cfg.JWTIssuer = "http://api.example.com"
			},
			want: "JWT_ISSUER",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			cfg := validConfig()
			tc.mutate(cfg)
			err := cfg.Validate()
			if err == nil {
				t.Fatal("expected validation error")
			}
			if !strings.Contains(err.Error(), tc.want) || !strings.Contains(err.Error(), "https") {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestValidateAllowsLocalHTTPJWKSAndPlainIssuer(t *testing.T) {
	t.Parallel()
	cfg := validConfig()
	cfg.ControlPlaneURL = "http://localhost:8787"
	cfg.JWKSEndpoint = "http://127.0.0.1:8787/.well-known/jwks.json"
	cfg.JWTIssuer = "test-issuer"
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() returned error: %v", err)
	}
}

func TestValidateInvalidControlPlaneURL(t *testing.T) {
	t.Parallel()
	cfg := validConfig()
	cfg.ControlPlaneURL = "ftp://bad-scheme.com"
	err := cfg.Validate()
	if err == nil {
		t.Fatal("Validate() should return error for non-http(s) URL")
	}
	if !strings.Contains(err.Error(), "CONTROL_PLANE_URL") {
		t.Fatalf("expected CONTROL_PLANE_URL error, got: %v", err)
	}
}

func TestValidateTLSPathsMissing(t *testing.T) {
	t.Parallel()
	cfg := validConfig()
	cfg.TLSEnabled = true
	cfg.TLSCertPath = "/nonexistent/cert.pem"
	cfg.TLSKeyPath = "/nonexistent/key.pem"
	err := cfg.Validate()
	if err == nil {
		t.Fatal("Validate() should return error for missing TLS files")
	}
	if !strings.Contains(err.Error(), "TLS_CERT_PATH") {
		t.Fatalf("expected TLS_CERT_PATH error, got: %v", err)
	}
}

func TestValidateTLSPathsExist(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")
	os.WriteFile(certPath, []byte("cert"), 0644)
	os.WriteFile(keyPath, []byte("key"), 0600)

	cfg := validConfig()
	cfg.TLSEnabled = true
	cfg.TLSCertPath = certPath
	cfg.TLSKeyPath = keyPath
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() returned error for valid TLS config: %v", err)
	}
}

func TestValidateTerminalWSSettings(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		mutate  func(*Config)
		wantKey string
	}{
		{"max message bytes", func(cfg *Config) { cfg.TerminalWSMaxMessageBytes = 0 }, "TERMINAL_WS_MAX_MESSAGE_BYTES"},
		{"read timeout", func(cfg *Config) { cfg.TerminalWSReadTimeout = 0 }, "TERMINAL_WS_READ_TIMEOUT"},
		{"ping interval", func(cfg *Config) { cfg.TerminalWSPingInterval = 0 }, "TERMINAL_WS_PING_INTERVAL"},
		{"ping interval below read timeout", func(cfg *Config) { cfg.TerminalWSPingInterval = cfg.TerminalWSReadTimeout }, "TERMINAL_WS_PING_INTERVAL"},
		{"message rate", func(cfg *Config) { cfg.TerminalWSMessageRate = 0 }, "TERMINAL_WS_MESSAGE_RATE"},
		{"message burst", func(cfg *Config) { cfg.TerminalWSMessageBurst = 0 }, "TERMINAL_WS_MESSAGE_BURST"},
		{"session ID max length", func(cfg *Config) { cfg.TerminalSessionIDMaxLength = 0 }, "TERMINAL_SESSION_ID_MAX_LENGTH"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := validConfig()
			tc.mutate(cfg)
			err := cfg.Validate()
			if err == nil {
				t.Fatal("Validate() should return error for invalid terminal WS setting")
			}
			if !strings.Contains(err.Error(), tc.wantKey) {
				t.Fatalf("expected %s error, got: %v", tc.wantKey, err)
			}
		})
	}
}

func TestValidateSessionMaxCount(t *testing.T) {
	t.Parallel()
	cfg := validConfig()
	cfg.SessionMaxCount = 0
	err := cfg.Validate()
	if err == nil {
		t.Fatal("Validate() should return error for SessionMaxCount = 0")
	}
	if !strings.Contains(err.Error(), "SESSION_MAX_COUNT") {
		t.Fatalf("expected SESSION_MAX_COUNT error, got: %v", err)
	}
}

func TestValidateMultipleErrors(t *testing.T) {
	t.Parallel()
	cfg := validConfig()
	cfg.Port = -1
	cfg.SessionMaxCount = 0
	cfg.DefaultRows = 0
	err := cfg.Validate()
	if err == nil {
		t.Fatal("Validate() should return error for multiple invalid fields")
	}
	errStr := err.Error()
	if !strings.Contains(errStr, "VM_AGENT_PORT") {
		t.Errorf("expected VM_AGENT_PORT in error, got: %v", err)
	}
	if !strings.Contains(errStr, "SESSION_MAX_COUNT") {
		t.Errorf("expected SESSION_MAX_COUNT in error, got: %v", err)
	}
	if !strings.Contains(errStr, "DEFAULT_ROWS") {
		t.Errorf("expected DEFAULT_ROWS in error, got: %v", err)
	}
}

func TestValidateDefaultCols(t *testing.T) {
	t.Parallel()
	cfg := validConfig()
	cfg.DefaultCols = 0
	err := cfg.Validate()
	if err == nil {
		t.Fatal("Validate() should return error for DefaultCols = 0")
	}
	if !strings.Contains(err.Error(), "DEFAULT_COLS") {
		t.Fatalf("expected DEFAULT_COLS error, got: %v", err)
	}
}

func TestValidateWSBufferSizes(t *testing.T) {
	t.Parallel()
	cfg := validConfig()
	cfg.WSReadBufferSize = 0
	err := cfg.Validate()
	if err == nil {
		t.Fatal("Validate() should return error for WSReadBufferSize = 0")
	}
	if !strings.Contains(err.Error(), "WS_READ_BUFFER_SIZE") {
		t.Fatalf("expected WS_READ_BUFFER_SIZE error, got: %v", err)
	}

	cfg2 := validConfig()
	cfg2.WSWriteBufferSize = 0
	err2 := cfg2.Validate()
	if err2 == nil {
		t.Fatal("Validate() should return error for WSWriteBufferSize = 0")
	}
	if !strings.Contains(err2.Error(), "WS_WRITE_BUFFER_SIZE") {
		t.Fatalf("expected WS_WRITE_BUFFER_SIZE error, got: %v", err2)
	}
}

func TestValidateEmptyControlPlaneURL(t *testing.T) {
	t.Parallel()
	cfg := validConfig()
	cfg.ControlPlaneURL = ""
	err := cfg.Validate()
	if err == nil {
		t.Fatal("Validate() should return error for empty ControlPlaneURL")
	}
	if !strings.Contains(err.Error(), "CONTROL_PLANE_URL") {
		t.Fatalf("expected CONTROL_PLANE_URL error, got: %v", err)
	}
}

// --- GenerateRandomPassword tests ---

func TestGenerateRandomPasswordLength(t *testing.T) {
	t.Parallel()
	pw := GenerateRandomPassword(16)
	// 16 bytes = 32 hex chars
	if len(pw) != 32 {
		t.Fatalf("GenerateRandomPassword(16) length = %d, want 32", len(pw))
	}
}

func TestGenerateRandomPasswordUniqueness(t *testing.T) {
	t.Parallel()
	a := GenerateRandomPassword(16)
	b := GenerateRandomPassword(16)
	if a == b {
		t.Fatal("two calls to GenerateRandomPassword should not return the same value")
	}
}

func TestGenerateRandomPasswordValidHex(t *testing.T) {
	t.Parallel()
	pw := GenerateRandomPassword(16)
	for _, c := range pw {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Fatalf("GenerateRandomPassword contains non-hex char: %c", c)
		}
	}
}

// --- getEnvOrGenerate tests ---

func TestGetEnvOrGenerateUsesEnvVar(t *testing.T) {
	t.Setenv("TEST_NEKO_PW", "my-secure-password")
	got := getEnvOrGenerate("TEST_NEKO_PW", 16)
	if got != "my-secure-password" {
		t.Fatalf("getEnvOrGenerate returned %q, want %q", got, "my-secure-password")
	}
}

func TestGetEnvOrGenerateDefaultsToRandom(t *testing.T) {
	// Use empty string via t.Setenv to safely unset for test duration
	t.Setenv("TEST_NEKO_PW_UNSET", "")
	got := getEnvOrGenerate("TEST_NEKO_PW_UNSET_NEVER_EXISTS", 16)
	if len(got) != 32 {
		t.Fatalf("getEnvOrGenerate returned %q (len %d), want 32-char hex", got, len(got))
	}
}

func TestGetEnvOrGenerateWeakPassword(t *testing.T) {
	t.Setenv("TEST_WEAK_PW", "short")
	got := getEnvOrGenerate("TEST_WEAK_PW", 16)
	if got != "short" {
		t.Fatalf("getEnvOrGenerate returned %q, want %q", got, "short")
	}
	// Warning is logged but we verify the value is still returned
}

// --- Env parse warning tests ---

func TestGetEnvIntWarnsOnBadValue(t *testing.T) {
	t.Setenv("TEST_BAD_INT", "not-a-number")
	got := getEnvInt("TEST_BAD_INT", 42)
	if got != 42 {
		t.Fatalf("getEnvInt returned %d, want default 42", got)
	}
	// We can't easily assert on slog output without a custom handler,
	// but we verify the function returns the default on bad input.
}

func TestGetEnvBoolWarnsOnBadValue(t *testing.T) {
	t.Setenv("TEST_BAD_BOOL", "maybe")
	got := getEnvBool("TEST_BAD_BOOL", true)
	if got != true {
		t.Fatalf("getEnvBool returned %v, want default true", got)
	}
}

func TestGetEnvDurationWarnsOnBadValue(t *testing.T) {
	t.Setenv("TEST_BAD_DUR", "five-seconds")
	got := getEnvDuration("TEST_BAD_DUR", 5*time.Second)
	if got != 5*time.Second {
		t.Fatalf("getEnvDuration returned %v, want default 5s", got)
	}
}

func TestLoadACPPromptRetryConfig(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("NODE_ID", "node-123")
	t.Setenv("ACP_PROMPT_RETRY_MAX_RETRIES", "4")
	t.Setenv("ACP_PROMPT_RETRY_INITIAL_BACKOFF", "3s")
	t.Setenv("ACP_PROMPT_RETRY_MAX_BACKOFF", "45s")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if cfg.ACPPromptRetryMaxRetries != 4 {
		t.Fatalf("ACPPromptRetryMaxRetries = %d, want 4", cfg.ACPPromptRetryMaxRetries)
	}
	if cfg.ACPPromptRetryInitial != 3*time.Second {
		t.Fatalf("ACPPromptRetryInitial = %v, want 3s", cfg.ACPPromptRetryInitial)
	}
	if cfg.ACPPromptRetryMax != 45*time.Second {
		t.Fatalf("ACPPromptRetryMax = %v, want 45s", cfg.ACPPromptRetryMax)
	}
}

func TestLoadACPTaskPromptTimeoutDefaultAndOverride(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("NODE_ID", "node-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() default error = %v", err)
	}
	if cfg.ACPTaskPromptTimeout != 8*time.Hour {
		t.Fatalf("ACPTaskPromptTimeout default = %v, want 8h", cfg.ACPTaskPromptTimeout)
	}

	t.Setenv("ACP_TASK_PROMPT_TIMEOUT", "3h")
	cfg, err = Load()
	if err != nil {
		t.Fatalf("Load() override error = %v", err)
	}
	if cfg.ACPTaskPromptTimeout != 3*time.Hour {
		t.Fatalf("ACPTaskPromptTimeout override = %v, want 3h", cfg.ACPTaskPromptTimeout)
	}
}

func TestLoadACPCheckpointRolloverDefaultsAndOverrides(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("NODE_ID", "node-123")
	t.Setenv("ACP_CHECKPOINT_PREEMPT_GRACE", "11s")
	t.Setenv("ACP_CHECKPOINT_PREEMPT_MAX_GRACE", "45s")
	t.Setenv("ACP_CHECKPOINT_ROLLOVER_TIMEOUT", "90s")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ACPCheckpointPreemptGrace != 11*time.Second ||
		cfg.ACPCheckpointPreemptMaxGrace != 45*time.Second ||
		cfg.ACPCheckpointRolloverTimeout != 90*time.Second {
		t.Fatalf("checkpoint config = grace %v max %v timeout %v",
			cfg.ACPCheckpointPreemptGrace, cfg.ACPCheckpointPreemptMaxGrace,
			cfg.ACPCheckpointRolloverTimeout)
	}
	if DefaultACPCheckpointPreemptGrace != 30*time.Second ||
		DefaultACPCheckpointPreemptMaxGrace != 2*time.Minute ||
		DefaultACPCheckpointRolloverTimeout != 2*time.Minute {
		t.Fatal("named checkpoint defaults changed unexpectedly")
	}
}

func TestLoadRejectsInvalidACPCheckpointRolloverBounds(t *testing.T) {
	for _, tc := range []struct {
		name, grace, maxGrace, timeout string
	}{
		{name: "negative grace", grace: "-1s", maxGrace: "2m", timeout: "2m"},
		{name: "grace above max", grace: "3m", maxGrace: "2m", timeout: "2m"},
		{name: "zero max", grace: "0s", maxGrace: "0s", timeout: "2m"},
		{name: "zero timeout", grace: "0s", maxGrace: "2m", timeout: "0s"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
			t.Setenv("NODE_ID", "node-123")
			t.Setenv("ACP_CHECKPOINT_PREEMPT_GRACE", tc.grace)
			t.Setenv("ACP_CHECKPOINT_PREEMPT_MAX_GRACE", tc.maxGrace)
			t.Setenv("ACP_CHECKPOINT_ROLLOVER_TIMEOUT", tc.timeout)
			if _, err := Load(); err == nil {
				t.Fatal("Load() accepted invalid checkpoint bounds")
			}
		})
	}
}

func TestLoadDeployArtifactAndApplyTimeouts(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("NODE_ID", "node-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() default error = %v", err)
	}
	if cfg.DeployArtifactDialTimeout != DefaultDeployArtifactDialTimeout {
		t.Fatalf("DeployArtifactDialTimeout = %v, want %v", cfg.DeployArtifactDialTimeout, DefaultDeployArtifactDialTimeout)
	}
	if cfg.DeployArtifactTLSHandshakeTimeout != DefaultDeployArtifactTLSHandshakeTimeout {
		t.Fatalf("DeployArtifactTLSHandshakeTimeout = %v, want %v", cfg.DeployArtifactTLSHandshakeTimeout, DefaultDeployArtifactTLSHandshakeTimeout)
	}
	if cfg.DeployArtifactResponseHeaderTimeout != DefaultDeployArtifactResponseHeaderTimeout {
		t.Fatalf("DeployArtifactResponseHeaderTimeout = %v, want %v", cfg.DeployArtifactResponseHeaderTimeout, DefaultDeployArtifactResponseHeaderTimeout)
	}
	if cfg.DeployArtifactIdleTimeout != DefaultDeployArtifactIdleTimeout {
		t.Fatalf("DeployArtifactIdleTimeout = %v, want %v", cfg.DeployArtifactIdleTimeout, DefaultDeployArtifactIdleTimeout)
	}
	if cfg.DeployApplyIdleTimeout != DefaultDeployApplyIdleTimeout {
		t.Fatalf("DeployApplyIdleTimeout = %v, want %v", cfg.DeployApplyIdleTimeout, DefaultDeployApplyIdleTimeout)
	}
	if cfg.DeployBuildPublishTimeout != DefaultDeployBuildPublishTimeout {
		t.Fatalf("DeployBuildPublishTimeout = %v, want %v", cfg.DeployBuildPublishTimeout, DefaultDeployBuildPublishTimeout)
	}

	t.Setenv("DEPLOY_ARTIFACT_DIAL_TIMEOUT", "7s")
	t.Setenv("DEPLOY_ARTIFACT_TLS_HANDSHAKE_TIMEOUT", "8s")
	t.Setenv("DEPLOY_ARTIFACT_RESPONSE_HEADER_TIMEOUT", "9s")
	t.Setenv("DEPLOY_ARTIFACT_IDLE_TIMEOUT", "10s")
	t.Setenv("DEPLOY_APPLY_IDLE_TIMEOUT", "11s")
	t.Setenv("DEPLOY_BUILD_PUBLISH_TIMEOUT", "12s")

	cfg, err = Load()
	if err != nil {
		t.Fatalf("Load() override error = %v", err)
	}
	if cfg.DeployArtifactDialTimeout != 7*time.Second {
		t.Fatalf("DeployArtifactDialTimeout override = %v, want 7s", cfg.DeployArtifactDialTimeout)
	}
	if cfg.DeployArtifactTLSHandshakeTimeout != 8*time.Second {
		t.Fatalf("DeployArtifactTLSHandshakeTimeout override = %v, want 8s", cfg.DeployArtifactTLSHandshakeTimeout)
	}
	if cfg.DeployArtifactResponseHeaderTimeout != 9*time.Second {
		t.Fatalf("DeployArtifactResponseHeaderTimeout override = %v, want 9s", cfg.DeployArtifactResponseHeaderTimeout)
	}
	if cfg.DeployArtifactIdleTimeout != 10*time.Second {
		t.Fatalf("DeployArtifactIdleTimeout override = %v, want 10s", cfg.DeployArtifactIdleTimeout)
	}
	if cfg.DeployApplyIdleTimeout != 11*time.Second {
		t.Fatalf("DeployApplyIdleTimeout override = %v, want 11s", cfg.DeployApplyIdleTimeout)
	}
	if cfg.DeployBuildPublishTimeout != 12*time.Second {
		t.Fatalf("DeployBuildPublishTimeout override = %v, want 12s", cfg.DeployBuildPublishTimeout)
	}
}

// --- NewControlPlaneClient tests ---

func TestNewControlPlaneClientTimeout(t *testing.T) {
	t.Parallel()
	client := NewControlPlaneClient(15 * time.Second)
	if client.Timeout != 15*time.Second {
		t.Fatalf("client.Timeout = %v, want 15s", client.Timeout)
	}
}

func TestNewControlPlaneClientDefaultTimeout(t *testing.T) {
	t.Parallel()
	client := NewControlPlaneClient(0)
	if client.Timeout != 30*time.Second {
		t.Fatalf("client.Timeout = %v, want 30s (default)", client.Timeout)
	}
}

func TestNewControlPlaneClientNegativeTimeout(t *testing.T) {
	t.Parallel()
	client := NewControlPlaneClient(-5 * time.Second)
	if client.Timeout != 30*time.Second {
		t.Fatalf("client.Timeout = %v, want 30s (default)", client.Timeout)
	}
}

// TestNewControlPlaneClientUsesSharedTransport verifies that every client
// returned from NewControlPlaneClient points at the same package-shared
// *http.Transport, so CloseIdleControlPlaneConnections can flush all of them
// in a single call.
//
// Not t.Parallel — we inspect the shared transport.
func TestNewControlPlaneClientUsesSharedTransport(t *testing.T) {
	a := NewControlPlaneClient(10 * time.Second)
	b := NewControlPlaneClient(20 * time.Second)

	if a.Transport == nil {
		t.Fatalf("client.Transport is nil — expected shared *http.Transport")
	}
	if a.Transport != b.Transport {
		t.Fatalf("clients returned different Transports (%p vs %p); expected shared transport", a.Transport, b.Transport)
	}
	if a.Transport != controlPlaneTransport {
		t.Fatalf("client.Transport (%p) is not the package-shared transport (%p)", a.Transport, controlPlaneTransport)
	}
}

// TestControlPlaneTransportTuning locks in the tuned transport fields so a
// regression can't silently revert to the default transport's 90s
// IdleConnTimeout (which caused pooled dead sockets to extend boot outages).
func TestControlPlaneTransportTuning(t *testing.T) {
	tr := controlPlaneTransport

	if tr.MaxIdleConns != 10 {
		t.Errorf("MaxIdleConns = %d, want 10", tr.MaxIdleConns)
	}
	if tr.MaxIdleConnsPerHost != 2 {
		t.Errorf("MaxIdleConnsPerHost = %d, want 2", tr.MaxIdleConnsPerHost)
	}
	if tr.IdleConnTimeout != 30*time.Second {
		t.Errorf("IdleConnTimeout = %v, want 30s", tr.IdleConnTimeout)
	}
	if tr.TLSHandshakeTimeout != 10*time.Second {
		t.Errorf("TLSHandshakeTimeout = %v, want 10s", tr.TLSHandshakeTimeout)
	}
	if tr.ResponseHeaderTimeout != 10*time.Second {
		t.Errorf("ResponseHeaderTimeout = %v, want 10s", tr.ResponseHeaderTimeout)
	}
	if tr.ExpectContinueTimeout != 1*time.Second {
		t.Errorf("ExpectContinueTimeout = %v, want 1s", tr.ExpectContinueTimeout)
	}
	if !tr.ForceAttemptHTTP2 {
		t.Errorf("ForceAttemptHTTP2 = false, want true")
	}
	if tr.DialContext == nil {
		t.Errorf("DialContext is nil, want a dialer with 5s timeout")
	}
}

// TestCloseIdleControlPlaneConnectionsFlushesPool verifies that calling
// CloseIdleControlPlaneConnections actually closes pooled keep-alive sockets.
// We observe this by counting distinct TCP connections the test server sees:
// without a flush, keep-alive reuses the same socket; after a flush, a new
// socket is dialed.
//
// Not t.Parallel — we're exercising the shared transport.
func TestCloseIdleControlPlaneConnectionsFlushesPool(t *testing.T) {
	var connCount int64
	// NewUnstartedServer + explicit Start so ConnState is wired before any
	// client can connect — avoids a data race between our goroutine writing
	// srv.Config.ConnState and the server goroutine reading it on accept.
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	srv.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			atomic.AddInt64(&connCount, 1)
		}
	}
	srv.Start()
	t.Cleanup(srv.Close)

	client := NewControlPlaneClient(5 * time.Second)

	// Request 1 — opens a fresh TCP connection and returns it to the pool.
	resp1, err := client.Get(srv.URL)
	if err != nil {
		t.Fatalf("request 1: %v", err)
	}
	resp1.Body.Close()

	// Request 2 — should reuse the pooled connection.
	resp2, err := client.Get(srv.URL)
	if err != nil {
		t.Fatalf("request 2: %v", err)
	}
	resp2.Body.Close()

	beforeFlush := atomic.LoadInt64(&connCount)
	if beforeFlush != 1 {
		t.Fatalf("expected 1 connection before flush (keep-alive reuse), got %d", beforeFlush)
	}

	// Flush the pool — pooled socket should be closed.
	CloseIdleControlPlaneConnections()

	// Request 3 — must dial a fresh TCP connection.
	resp3, err := client.Get(srv.URL)
	if err != nil {
		t.Fatalf("request 3: %v", err)
	}
	resp3.Body.Close()

	afterFlush := atomic.LoadInt64(&connCount)
	if afterFlush != 2 {
		t.Fatalf("expected 2 total connections after flush (pool was purged), got %d", afterFlush)
	}
}

func TestDevcontainerBuildTimeoutDefault(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.DevcontainerBuildTimeout != 15*time.Minute {
		t.Fatalf("DevcontainerBuildTimeout=%v, want %v", cfg.DevcontainerBuildTimeout, 15*time.Minute)
	}
}

func TestDevcontainerBuildTimeoutOverride(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("DEVCONTAINER_BUILD_TIMEOUT", "25m")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.DevcontainerBuildTimeout != 25*time.Minute {
		t.Fatalf("DevcontainerBuildTimeout=%v, want %v", cfg.DevcontainerBuildTimeout, 25*time.Minute)
	}
}

func TestProviderDefault(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.Provider != "" {
		t.Fatalf("Provider=%q, want empty string", cfg.Provider)
	}
}

func TestProviderOverride(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("PROVIDER", "hetzner")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.Provider != "hetzner" {
		t.Fatalf("Provider=%q, want %q", cfg.Provider, "hetzner")
	}
}

func TestStandaloneRole(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("NODE_ROLE", RoleStandalone)
	t.Setenv("NODE_ID", "node-123")
	t.Setenv("WORKSPACE_ID", "ws-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if !cfg.IsStandaloneMode() {
		t.Fatal("expected standalone mode")
	}
	if cfg.IsDeploymentMode() {
		t.Fatal("standalone mode must not be deployment mode")
	}
}

func TestStandaloneCloneFilterDefault(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.StandaloneCloneFilter != DefaultStandaloneCloneFilter {
		t.Fatalf("StandaloneCloneFilter=%q, want %q", cfg.StandaloneCloneFilter, DefaultStandaloneCloneFilter)
	}
}

func TestStandaloneCloneFilterOverride(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("STANDALONE_CLONE_FILTER", "blob:limit=1m")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.StandaloneCloneFilter != "blob:limit=1m" {
		t.Fatalf("StandaloneCloneFilter=%q, want %q", cfg.StandaloneCloneFilter, "blob:limit=1m")
	}
}

func TestStandaloneCloneFilterDisabled(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("STANDALONE_CLONE_FILTER", "off")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.StandaloneCloneFilter != "" {
		t.Fatalf("StandaloneCloneFilter=%q, want empty (disabled)", cfg.StandaloneCloneFilter)
	}
}

func TestResolveStandaloneCloneFilter(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{name: "default value passes through", raw: DefaultStandaloneCloneFilter, want: "blob:none"},
		{name: "custom filter passes through", raw: "tree:0", want: "tree:0"},
		{name: "whitespace trimmed", raw: "  blob:none  ", want: "blob:none"},
		{name: "off disables", raw: "off", want: ""},
		{name: "none disables", raw: "none", want: ""},
		{name: "false disables", raw: "false", want: ""},
		{name: "case-insensitive disable", raw: "OFF", want: ""},
		{name: "blank disables", raw: "   ", want: ""},
		{name: "empty disables", raw: "", want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ResolveStandaloneCloneFilter(tc.raw); got != tc.want {
				t.Fatalf("ResolveStandaloneCloneFilter(%q)=%q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}
