package config

import (
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
}

func TestACPPhaseTimeoutsOverride(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	t.Setenv("ACP_INITIALIZE_TIMEOUT_MS", "45000")
	t.Setenv("ACP_NEW_SESSION_TIMEOUT_MS", "60000")
	t.Setenv("ACP_LOAD_SESSION_TIMEOUT_MS", "20000")

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
		Port:            8080,
		ControlPlaneURL: "https://api.example.com",
		NodeID:          "node-1",
		SessionMaxCount: 100,
		DefaultRows:     24,
		DefaultCols:     80,
		WSReadBufferSize:  1024,
		WSWriteBufferSize: 1024,
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
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	srv.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			atomic.AddInt64(&connCount, 1)
		}
	}
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
