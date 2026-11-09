package config

import (
	"strings"
	"testing"
	"time"
)

func TestLoadEvictionParkBudget(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "test-workspace")
	t.Setenv(EnvDefaultEvictionDockerStopTimeoutSeconds, "8")
	t.Setenv(EnvEvictionFinalSnapshotTimeoutSeconds, "60")
	t.Setenv("HTTP_CALLBACK_TIMEOUT", "10s")
	// docker stop: 12s command deadline + 8s WaitDelay; capture:60s; record:10s.
	for _, tc := range []struct {
		name, raw string
		wantError bool
	}{
		{"short", "30s", true}, {"exact budget", "90s", true},
		{"negative", "-1s", true}, {"custom sufficient", "91s", false},
		{"default", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("EVICTION_PARK_TIMEOUT", tc.raw)
			cfg, err := Load()
			if tc.wantError {
				if err == nil || !strings.Contains(err.Error(), "EVICTION_PARK_TIMEOUT") {
					t.Fatalf("Load() error=%v, want parking budget rejection", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tc.raw == "91s" && cfg.ACPEvictionParkTimeout != 91*time.Second {
				t.Fatalf("park=%s", cfg.ACPEvictionParkTimeout)
			}
		})
	}
}

func TestValidateEvictionParkBudget(t *testing.T) {
	cfg := validConfig()
	cfg.ACPEvictionParkTimeout = 30 * time.Second
	cfg.SnapshotHelper.FinalSnapshotTimeout = time.Minute
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "EVICTION_PARK_TIMEOUT") {
		t.Fatalf("Validate()=%v, want parking budget rejection", err)
	}
	cfg.ACPEvictionParkTimeout = 0 // Unset direct configurations use the documented default.
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	cfg.SnapshotHelper.FinalSnapshotTimeout = DefaultACPEvictionParkTimeout
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "EVICTION_PARK_TIMEOUT") {
		t.Fatalf("Validate()=%v, want rejection when capture exceeds default park", err)
	}
}

func TestEvictionParkBudgetCannotOverflow(t *testing.T) {
	cfg := validConfig()
	cfg.ACPEvictionParkTimeout = time.Duration(1<<63 - 1)
	cfg.EvictionDockerStopTimeout = time.Duration(1 << 62)
	if err := cfg.validateEvictionParkTimeout(); err == nil {
		t.Fatal("overflowing stop budget accepted")
	}
	cfg.EvictionDockerStopTimeout = time.Second
	cfg.SnapshotHelper.FinalSnapshotTimeout = time.Duration(1<<63 - 1)
	if err := cfg.validateEvictionParkTimeout(); err == nil {
		t.Fatal("overflowing final capture budget accepted")
	}
}
