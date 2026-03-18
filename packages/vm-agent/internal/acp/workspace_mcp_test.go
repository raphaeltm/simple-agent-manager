package acp

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestGenerateWorkspaceMcpJson_Basic(t *testing.T) {
	result := generateWorkspaceMcpJson(
		"/usr/local/lib/workspace-mcp/index.js",
		"token-abc",
		"https://api.example.com",
		nil,
	)

	var config workspaceMcpJsonConfig
	if err := json.Unmarshal([]byte(result), &config); err != nil {
		t.Fatalf("Failed to parse generated JSON: %v", err)
	}

	entry, ok := config.McpServers["workspace-mcp"]
	if !ok {
		t.Fatal("Expected 'workspace-mcp' key in mcpServers")
	}
	if entry.Command != "node" {
		t.Errorf("Expected command 'node', got %q", entry.Command)
	}
	if len(entry.Args) != 1 || entry.Args[0] != "/usr/local/lib/workspace-mcp/index.js" {
		t.Errorf("Unexpected args: %v", entry.Args)
	}
	if entry.Env["SAM_MCP_TOKEN"] != "token-abc" {
		t.Errorf("Expected SAM_MCP_TOKEN='token-abc', got %q", entry.Env["SAM_MCP_TOKEN"])
	}
	if entry.Env["SAM_API_URL"] != "https://api.example.com" {
		t.Errorf("Expected SAM_API_URL='https://api.example.com', got %q", entry.Env["SAM_API_URL"])
	}
}

func TestGenerateWorkspaceMcpJson_FallbackFromMcpServers(t *testing.T) {
	// When mcpToken and apiURL are empty, fall back to existing MCP server entries.
	servers := []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "fallback-token"},
	}

	result := generateWorkspaceMcpJson(
		"/usr/local/lib/workspace-mcp/index.js",
		"", // no direct token
		"", // no direct API URL
		servers,
	)

	var config workspaceMcpJsonConfig
	if err := json.Unmarshal([]byte(result), &config); err != nil {
		t.Fatalf("Failed to parse: %v", err)
	}

	entry := config.McpServers["workspace-mcp"]
	if entry.Env["SAM_MCP_TOKEN"] != "fallback-token" {
		t.Errorf("Expected fallback token, got %q", entry.Env["SAM_MCP_TOKEN"])
	}
	if entry.Env["SAM_API_URL"] != "https://api.example.com/mcp" {
		t.Errorf("Expected fallback API URL, got %q", entry.Env["SAM_API_URL"])
	}
}

func TestGenerateWorkspaceMcpJson_DirectTokenTakesPrecedence(t *testing.T) {
	servers := []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "server-token"},
	}

	result := generateWorkspaceMcpJson(
		"/path/to/index.js",
		"direct-token",
		"https://api.direct.com",
		servers,
	)

	var config workspaceMcpJsonConfig
	if err := json.Unmarshal([]byte(result), &config); err != nil {
		t.Fatalf("Failed to parse: %v", err)
	}

	entry := config.McpServers["workspace-mcp"]
	if entry.Env["SAM_MCP_TOKEN"] != "direct-token" {
		t.Errorf("Direct token should take precedence, got %q", entry.Env["SAM_MCP_TOKEN"])
	}
	if entry.Env["SAM_API_URL"] != "https://api.direct.com" {
		t.Errorf("Direct API URL should take precedence, got %q", entry.Env["SAM_API_URL"])
	}
}

func TestGenerateWorkspaceMcpJson_NoTokens(t *testing.T) {
	result := generateWorkspaceMcpJson("/path/to/index.js", "", "", nil)

	var config workspaceMcpJsonConfig
	if err := json.Unmarshal([]byte(result), &config); err != nil {
		t.Fatalf("Failed to parse: %v", err)
	}

	entry := config.McpServers["workspace-mcp"]
	if len(entry.Env) != 0 {
		t.Errorf("Expected empty env when no tokens, got %v", entry.Env)
	}
}

func TestGenerateWorkspaceMcpJson_ValidJSON(t *testing.T) {
	result := generateWorkspaceMcpJson(
		"/usr/local/lib/workspace-mcp/index.js",
		"token-with-special-chars!@#$%",
		"https://api.example.com",
		nil,
	)

	// Verify it's valid JSON
	if !json.Valid([]byte(result)) {
		t.Error("Generated output is not valid JSON")
	}

	// Verify token survives JSON round-trip
	var config workspaceMcpJsonConfig
	if err := json.Unmarshal([]byte(result), &config); err != nil {
		t.Fatalf("Failed to parse: %v", err)
	}
	if config.McpServers["workspace-mcp"].Env["SAM_MCP_TOKEN"] != "token-with-special-chars!@#$%" {
		t.Error("Token with special characters did not survive JSON round-trip")
	}
}

func TestGenerateWorkspaceMcpJson_NoTokenLeakInArgs(t *testing.T) {
	result := generateWorkspaceMcpJson(
		"/path/to/index.js",
		"secret-token-123",
		"https://api.example.com",
		nil,
	)

	var config workspaceMcpJsonConfig
	if err := json.Unmarshal([]byte(result), &config); err != nil {
		t.Fatalf("Failed to parse: %v", err)
	}

	entry := config.McpServers["workspace-mcp"]
	// Token should be in env, not in args
	for _, arg := range entry.Args {
		if strings.Contains(arg, "secret-token-123") {
			t.Error("Token leaked into args — should only be in env")
		}
	}
	if !strings.Contains(entry.Command, "node") {
		t.Error("Command should be 'node'")
	}
}
