package acp

import (
	"context"
	"testing"
)

// A rebuild keeps live SessionHosts, so the server hands them the rotated
// sam-mcp token through SetMcpServers. The next agent start must write the new
// token, not the one the host was created with: the control plane has revoked it.
func TestSessionHostAgentStartUsesReplacedMcpServers(t *testing.T) {
	h, startup, _ := newCodexStartupHost(t, []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "revoked-sam-token", Name: SamMcpServerName},
		{URL: "https://user.example/mcp", Token: "user-token", Name: "composio"},
	})

	replacement := []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "rotated-sam-token", Name: SamMcpServerName},
		{URL: "https://user.example/mcp", Token: "user-token", Name: "composio"},
	}
	h.SetMcpServers(replacement)
	replacement[0].Token = "mutated-by-caller" // the host keeps its own copy

	if err := h.writeAgentStartupConfig(context.Background(), "openai-codex", nil, startup); err != nil {
		t.Fatalf("Codex startup: %v", err)
	}
	assertEnvContains(t, startup.envVars, "SAM_MCP_TOKEN", "rotated-sam-token")

	acpServers := buildAcpMcpServers(h.mcpServers(), "claude-code")
	if len(acpServers) != 2 || acpServers[0].Http == nil {
		t.Fatalf("ACP session servers = %#v", acpServers)
	}
	foundBearer := false
	for _, header := range acpServers[0].Http.Headers {
		if header.Name == "Authorization" {
			foundBearer = header.Value == "Bearer rotated-sam-token"
		}
	}
	if !foundBearer {
		t.Fatalf("NewSession/LoadSession sam-mcp headers = %#v, want the rotated bearer", acpServers[0].Http.Headers)
	}
	if !h.UsesMcpServerToken(SamMcpServerName, "rotated-sam-token") || h.UsesMcpServerToken(SamMcpServerName, "revoked-sam-token") {
		t.Fatal("UsesMcpServerToken disagrees with the token the next start uses")
	}
}

// Liveness control: without a replacement the host still starts with the list
// it was created with.
func TestSessionHostAgentStartUsesCreatedMcpServersWithoutReplacement(t *testing.T) {
	h, startup, _ := newCodexStartupHost(t, []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "created-sam-token", Name: SamMcpServerName},
	})
	if err := h.writeAgentStartupConfig(context.Background(), "openai-codex", nil, startup); err != nil {
		t.Fatalf("Codex startup: %v", err)
	}
	assertEnvContains(t, startup.envVars, "SAM_MCP_TOKEN", "created-sam-token")
}
