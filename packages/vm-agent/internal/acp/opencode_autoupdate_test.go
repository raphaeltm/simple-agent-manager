package acp

import (
	"context"
	"testing"
)

// SAM ships its own OpenCode build (ACP live steering). A user-supplied value or
// OpenCode's default must never let its updater swap in an upstream binary.
func TestOpenCodeStartupDisablesSelfUpdate(t *testing.T) {
	host := NewSessionHost(SessionHostConfig{})
	t.Cleanup(host.Stop)
	startup := &agentStartup{envVars: []string{"OPENCODE_DISABLE_AUTOUPDATE=0", "KEEP=1"}}

	host.writeOpenCodeStartupConfig(context.Background(), nil, startup)

	count := 0
	for _, env := range startup.envVars {
		if env == "OPENCODE_DISABLE_AUTOUPDATE=0" {
			t.Fatal("a caller value re-enabled the OpenCode updater")
		}
		if env == "OPENCODE_DISABLE_AUTOUPDATE=1" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("OPENCODE_DISABLE_AUTOUPDATE=1 appears %d times in %v", count, startup.envVars)
	}
	if !containsEnv(startup.envVars, "KEEP=1") {
		t.Fatal("unrelated environment was dropped")
	}
}

func containsEnv(envVars []string, want string) bool {
	for _, env := range envVars {
		if env == want {
			return true
		}
	}
	return false
}
