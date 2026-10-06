package acp

import (
	"context"
	"strings"
	"testing"
)

// TestAgentEnvLeavesPATHToTheRuntime pins that SAM never replaces PATH for an
// agent, on either runtime. The Instant image orders PATH so the managed gh shim
// comes first and globally installed npm tools
// (NPM_CONFIG_PREFIX=/var/lib/vm-agent/agents/npm) resolve; a devcontainer owns
// its own PATH. A replacement PATH silently drops those directories from every
// agent shell.
func TestAgentEnvLeavesPATHToTheRuntime(t *testing.T) {
	t.Parallel()

	t.Run("instant standalone agent inherits the image PATH", func(t *testing.T) {
		t.Parallel()
		const imagePATH = "PATH=/var/lib/vm-agent/agents/bin:/var/lib/vm-agent/agents/npm/bin:/usr/local/bin:/usr/bin:/bin"
		host := NewSessionHost(SessionHostConfig{
			GatewayConfig: GatewayConfig{
				SessionID:        "test-session",
				WorkspaceID:      "test-workspace",
				ContainerWorkDir: t.TempDir(),
				ProcessLauncher:  LocalLauncher{},
				SAMEnvFallback:   []string{"SAM_WORKSPACE_ID=test-workspace"},
				GitTokenFetcher: func(context.Context) (string, error) {
					return "session-token", nil
				},
			},
		})
		defer host.Stop()

		startup, err := host.prepareAgentStartup(context.Background(), "claude-code", &agentCredential{
			credential:     "agent-key",
			credentialKind: "api-key",
		}, nil)
		if err != nil {
			t.Fatalf("prepareAgentStartup returned error: %v", err)
		}
		processEnv := mergeProcessEnv([]string{imagePATH, "HOME=/home/node"}, startup.envVars)

		if got := envEntriesWithKey(processEnv, "PATH"); len(got) != 1 || got[0] != imagePATH {
			t.Fatalf("agent PATH = %v, want the image PATH unchanged", got)
		}
		if !hasEnvEntry(processEnv, "GH_TOKEN=session-token") {
			t.Fatalf("agent env was not assembled (no session GH_TOKEN): %v", processEnv)
		}
	})

	t.Run("vm devcontainer agent sets no PATH", func(t *testing.T) {
		t.Parallel()
		host := &SessionHost{config: SessionHostConfig{GatewayConfig: GatewayConfig{
			WorkspaceID:    "test-workspace",
			SAMEnvFallback: []string{"SAM_WORKSPACE_ID=test-workspace"},
		}}}

		envVars := host.resolveAgentEnvVars(context.Background(), "missing-container")

		if got := envEntriesWithKey(envVars, "PATH"); len(got) != 0 {
			t.Fatalf("devcontainer agent env sets PATH: %v", got)
		}
		if !hasEnvEntry(envVars, "SAM_WORKSPACE_ID=test-workspace") {
			t.Fatalf("agent env was not assembled: %v", envVars)
		}
	})
}

func envEntriesWithKey(envVars []string, key string) []string {
	var entries []string
	for _, entry := range envVars {
		if strings.HasPrefix(entry, key+"=") {
			entries = append(entries, entry)
		}
	}
	return entries
}
