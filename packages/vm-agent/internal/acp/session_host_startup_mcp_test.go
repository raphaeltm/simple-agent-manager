package acp

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Codex startup used to abort when ANY injected MCP server had a blank token. That was safe
// while sam-mcp was the only server SAM ever injected, but a user's bring-your-own connection
// may legitimately have no bearer token — several providers issue pre-signed URLs carrying the
// credential in the URL itself. Under the old rule, adding one such connection would have
// broken every Codex session for that user.
//
// The precondition is now scoped to the reserved sam-mcp entry. The two tests below are a
// pair: the first proves the relaxation works, the second is the discriminating control
// proving the fail-closed behaviour for SAM's own endpoint was NOT lost along with it.

func newCodexStartupHost(t *testing.T, servers []McpServerEntry) (*SessionHost, *agentStartup, string) {
	t.Helper()
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)
	t.Setenv("CODEX_HOME", "")

	h := &SessionHost{
		config: SessionHostConfig{
			GatewayConfig: GatewayConfig{
				McpServers:  servers,
				WorkspaceID: "ws-test",
			},
		},
	}
	return h, &agentStartup{containerID: "", envVars: []string{}}, tmpDir
}

func TestCodexStartupAllowsTokenlessUserConnection(t *testing.T) {
	h, startup, tmpDir := newCodexStartupHost(t, []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "sam-token", Name: SamMcpServerName},
		{URL: "https://presigned.example/mcp?key=abc", Token: "", Name: "composio"},
	})

	if err := h.writeAgentStartupConfig(context.Background(), "openai-codex", nil, startup); err != nil {
		t.Fatalf("Codex startup must not fail because a user connection has no token: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(tmpDir, ".codex", "config.toml"))
	if err != nil {
		t.Fatalf("config.toml not written: %v", err)
	}
	config := string(data)

	// Both servers must reach the config, and SAM's own bearer wiring must be intact.
	if !strings.Contains(config, "[mcp_servers.sam-mcp]") {
		t.Errorf("missing sam-mcp section:\n%s", config)
	}
	if !strings.Contains(config, "[mcp_servers.composio]") {
		t.Errorf("missing composio section:\n%s", config)
	}
	if !strings.Contains(config, `bearer_token_env_var = "SAM_MCP_TOKEN"`) {
		t.Errorf("missing sam-mcp bearer env reference:\n%s", config)
	}
	// The tokenless server must not reference an env var that will never be set.
	if strings.Contains(config, "SAM_MCP_COMPOSIO_TOKEN") {
		t.Errorf("tokenless server must not emit a bearer env reference:\n%s", config)
	}
	assertEnvContains(t, startup.envVars, "SAM_MCP_TOKEN", "sam-token")
}

// Discriminating control. Without this, deleting the precondition entirely would still leave
// the test above green — the suite would pass with SAM's own MCP auth silently broken.
func TestCodexStartupStillFailsWhenSamMcpHasNoToken(t *testing.T) {
	h, startup, _ := newCodexStartupHost(t, []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "", Name: SamMcpServerName},
		{URL: "https://presigned.example/mcp", Token: "", Name: "composio"},
	})

	err := h.writeAgentStartupConfig(context.Background(), "openai-codex", nil, startup)
	if err == nil {
		t.Fatal("Codex startup must fail closed when SAM's own MCP endpoint has no bearer token")
	}
	if !strings.Contains(err.Error(), "bearer token") {
		t.Errorf("error should name the missing bearer token, got: %v", err)
	}
}

// Unnamed entries (an old control plane) resolve to sam-mcp positionally, so the fail-closed
// rule must still apply to them — otherwise the relaxation would silently disable the check
// for every pre-naming payload.
func TestCodexStartupFailsWhenUnnamedSoleServerHasNoToken(t *testing.T) {
	h, startup, _ := newCodexStartupHost(t, []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: ""},
	})

	if err := h.writeAgentStartupConfig(context.Background(), "openai-codex", nil, startup); err == nil {
		t.Fatal("an unnamed sole server resolves to sam-mcp and must still require a token")
	}
}

// URL validity checks are NOT scoped to sam-mcp — a malformed URL from any server would
// corrupt config.toml, so those still apply to every entry.
func TestCodexStartupRejectsMalformedUserConnection(t *testing.T) {
	cases := map[string][]McpServerEntry{
		"blank url": {
			{URL: "https://api.example.com/mcp", Token: "sam-token", Name: SamMcpServerName},
			{URL: "   ", Token: "", Name: "broken"},
		},
		"crlf in url": {
			{URL: "https://api.example.com/mcp", Token: "sam-token", Name: SamMcpServerName},
			{URL: "https://evil.example/mcp\n[mcp_servers.injected]", Token: "", Name: "broken"},
		},
		"crlf in token": {
			{URL: "https://api.example.com/mcp", Token: "sam-token", Name: SamMcpServerName},
			{URL: "https://evil.example/mcp", Token: "tok\nen", Name: "broken"},
		},
	}

	for name, servers := range cases {
		t.Run(name, func(t *testing.T) {
			h, startup, _ := newCodexStartupHost(t, servers)
			if err := h.writeAgentStartupConfig(context.Background(), "openai-codex", nil, startup); err == nil {
				t.Error("expected Codex startup to reject the malformed server")
			}
		})
	}
}
