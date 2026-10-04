package config

import (
	"testing"
	"time"
)

func loadRenewalConfig(t *testing.T, env map[string]string) *Config {
	t.Helper()
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	for _, key := range []string{
		"WORKSPACE_CALLBACK_TOKEN_REFRESH_RATIO",
		"WORKSPACE_CALLBACK_TOKEN_RENEWAL_TIMEOUT",
		"WORKSPACE_CALLBACK_TOKEN_RENEWAL_RETRY_INITIAL",
		"WORKSPACE_CALLBACK_TOKEN_RENEWAL_RETRY_MAX",
	} {
		t.Setenv(key, env[key])
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	return cfg
}

func TestWorkspaceCallbackTokenRenewalDefaults(t *testing.T) {
	cfg := loadRenewalConfig(t, nil)

	if cfg.WorkspaceCallbackTokenRefreshRatio != DefaultWorkspaceCallbackTokenRefreshRatio ||
		cfg.WorkspaceCallbackTokenRenewalTimeout != DefaultWorkspaceCallbackTokenRenewalTimeout ||
		cfg.WorkspaceCallbackTokenRenewalRetryInitial != DefaultWorkspaceCallbackTokenRenewalRetryInitial ||
		cfg.WorkspaceCallbackTokenRenewalRetryMax != DefaultWorkspaceCallbackTokenRenewalRetryMax {
		t.Fatalf("unexpected defaults: ratio=%v timeout=%v initial=%v max=%v",
			cfg.WorkspaceCallbackTokenRefreshRatio, cfg.WorkspaceCallbackTokenRenewalTimeout,
			cfg.WorkspaceCallbackTokenRenewalRetryInitial, cfg.WorkspaceCallbackTokenRenewalRetryMax)
	}
}

func TestWorkspaceCallbackTokenRefreshRatioIsClamped(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  float64
	}{
		{"0.7", 0.7},
		{"0.95", MaxWorkspaceCallbackTokenRefreshRatio},
		{"0.01", MinWorkspaceCallbackTokenRefreshRatio},
		// Same handling as the control plane's CALLBACK_TOKEN_REFRESH_THRESHOLD_RATIO.
		{"0", MinWorkspaceCallbackTokenRefreshRatio},
		{"-1", MinWorkspaceCallbackTokenRefreshRatio},
		{"not-a-number", DefaultWorkspaceCallbackTokenRefreshRatio},
		{"NaN", DefaultWorkspaceCallbackTokenRefreshRatio},
		{"Inf", DefaultWorkspaceCallbackTokenRefreshRatio},
	} {
		t.Run(tc.value, func(t *testing.T) {
			cfg := loadRenewalConfig(t, map[string]string{"WORKSPACE_CALLBACK_TOKEN_REFRESH_RATIO": tc.value})
			if cfg.WorkspaceCallbackTokenRefreshRatio != tc.want {
				t.Fatalf("ratio %q loaded as %v, want %v", tc.value, cfg.WorkspaceCallbackTokenRefreshRatio, tc.want)
			}
		})
	}
}

func TestWorkspaceCallbackTokenRenewalDurationsRejectNonPositiveValues(t *testing.T) {
	cfg := loadRenewalConfig(t, map[string]string{
		"WORKSPACE_CALLBACK_TOKEN_RENEWAL_TIMEOUT":       "0s",
		"WORKSPACE_CALLBACK_TOKEN_RENEWAL_RETRY_INITIAL": "-5m",
		"WORKSPACE_CALLBACK_TOKEN_RENEWAL_RETRY_MAX":     "2h",
	})
	if cfg.WorkspaceCallbackTokenRenewalTimeout != DefaultWorkspaceCallbackTokenRenewalTimeout {
		t.Fatalf("timeout = %v, want default", cfg.WorkspaceCallbackTokenRenewalTimeout)
	}
	if cfg.WorkspaceCallbackTokenRenewalRetryInitial != DefaultWorkspaceCallbackTokenRenewalRetryInitial {
		t.Fatalf("retry initial = %v, want default", cfg.WorkspaceCallbackTokenRenewalRetryInitial)
	}
	if cfg.WorkspaceCallbackTokenRenewalRetryMax != 2*time.Hour {
		t.Fatalf("retry max = %v, want override", cfg.WorkspaceCallbackTokenRenewalRetryMax)
	}
}
