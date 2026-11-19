package config

import (
	"testing"
	"time"
)

func loadMcpTokenRotationConfig(t *testing.T, env map[string]string) *Config {
	t.Helper()
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
	for _, key := range []string{
		"MCP_TOKEN_ROTATION_TIMEOUT",
		"MCP_TOKEN_ROTATION_MAX_ATTEMPTS",
		"MCP_TOKEN_ROTATION_RETRY_DELAY",
		"MCP_TOKEN_ROTATION_BUDGET",
	} {
		t.Setenv(key, env[key])
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	return cfg
}

func TestMcpTokenRotationDefaults(t *testing.T) {
	cfg := loadMcpTokenRotationConfig(t, nil)
	if cfg.McpTokenRotationTimeout != DefaultMcpTokenRotationTimeout ||
		cfg.McpTokenRotationMaxAttempts != DefaultMcpTokenRotationMaxAttempts ||
		cfg.McpTokenRotationRetryDelay != DefaultMcpTokenRotationRetryDelay ||
		cfg.McpTokenRotationBudget != DefaultMcpTokenRotationBudget {
		t.Fatalf("unexpected defaults: timeout=%v attempts=%d delay=%v budget=%v",
			cfg.McpTokenRotationTimeout, cfg.McpTokenRotationMaxAttempts,
			cfg.McpTokenRotationRetryDelay, cfg.McpTokenRotationBudget)
	}
}

func TestMcpTokenRotationOverridesAndRejectsInvalidValues(t *testing.T) {
	cfg := loadMcpTokenRotationConfig(t, map[string]string{
		"MCP_TOKEN_ROTATION_TIMEOUT":      "3s",
		"MCP_TOKEN_ROTATION_MAX_ATTEMPTS": "0",
		"MCP_TOKEN_ROTATION_RETRY_DELAY":  "-1s",
		"MCP_TOKEN_ROTATION_BUDGET":       "2m",
	})
	if cfg.McpTokenRotationTimeout != 3*time.Second || cfg.McpTokenRotationBudget != 2*time.Minute {
		t.Fatalf("overrides not applied: timeout=%v budget=%v", cfg.McpTokenRotationTimeout, cfg.McpTokenRotationBudget)
	}
	if cfg.McpTokenRotationMaxAttempts != DefaultMcpTokenRotationMaxAttempts ||
		cfg.McpTokenRotationRetryDelay != DefaultMcpTokenRotationRetryDelay {
		t.Fatalf("invalid values not defaulted: attempts=%d delay=%v",
			cfg.McpTokenRotationMaxAttempts, cfg.McpTokenRotationRetryDelay)
	}
}
