package config

import (
	"testing"
	"time"
)

func TestBuildContextAdmissionLimitConfiguration(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  int
	}{
		{"", DEFAULT_BUILD_CONTEXT_MAX_ACTIVE_PER_WORKSPACE},
		{"2", 2},
		{"invalid", DEFAULT_BUILD_CONTEXT_MAX_ACTIVE_PER_WORKSPACE},
	} {
		t.Run(tc.value, func(t *testing.T) {
			t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
			t.Setenv("NODE_ID", "node-123")
			t.Setenv("BUILD_CONTEXT_MAX_ACTIVE_PER_WORKSPACE", tc.value)
			cfg, err := Load()
			if err != nil {
				t.Fatal(err)
			}
			if cfg.BuildContextMaxActivePerWorkspace != tc.want {
				t.Fatalf("limit=%d want=%d", cfg.BuildContextMaxActivePerWorkspace, tc.want)
			}
		})
	}
}

func TestBuildContextCallbackRetryConfiguration(t *testing.T) {
	for _, override := range []bool{false, true} {
		t.Run(map[bool]string{false: "defaults", true: "override"}[override], func(t *testing.T) {
			t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
			t.Setenv("NODE_ID", "node-123")
			t.Setenv("BUILD_CONTEXT_CALLBACK_MAX_ATTEMPTS", "")
			t.Setenv("BUILD_CONTEXT_CALLBACK_RETRY_DELAY", "")
			attempts, delay := DefaultBuildContextCallbackMaxAttempts, DefaultBuildContextCallbackRetryDelay
			if override {
				t.Setenv("BUILD_CONTEXT_CALLBACK_MAX_ATTEMPTS", "4")
				t.Setenv("BUILD_CONTEXT_CALLBACK_RETRY_DELAY", "2ms")
				attempts, delay = 4, 2*time.Millisecond
			}
			cfg, err := Load()
			if err != nil {
				t.Fatal(err)
			}
			if cfg.BuildContextCallbackMaxAttempts != attempts || cfg.BuildContextCallbackRetryDelay != delay {
				t.Fatalf("retry config attempts=%d delay=%v", cfg.BuildContextCallbackMaxAttempts, cfg.BuildContextCallbackRetryDelay)
			}
		})
	}
}
