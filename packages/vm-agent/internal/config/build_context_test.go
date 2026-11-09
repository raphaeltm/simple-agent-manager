package config

import "testing"

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
