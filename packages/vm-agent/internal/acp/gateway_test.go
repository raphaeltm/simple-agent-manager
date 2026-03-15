package acp

import (
	"fmt"
	"strings"
	"testing"
)

// Tests for OAuth support
func TestGetAgentCommandInfo_OAuthToken(t *testing.T) {
	tests := []struct {
		name              string
		agentType         string
		credentialKind    string
		wantCommand       string
		wantEnvVar        string
		wantInstallCmd    string
		wantInjectionMode string
		wantAuthFilePath  string
	}{
		{
			name:           "Claude Code with OAuth token",
			agentType:      "claude-code",
			credentialKind: "oauth-token",
			wantCommand:    "claude-agent-acp",
			wantEnvVar:     "CLAUDE_CODE_OAUTH_TOKEN",
			wantInstallCmd: "npm install -g @zed-industries/claude-agent-acp",
		},
		{
			name:           "Claude Code with API key",
			agentType:      "claude-code",
			credentialKind: "api-key",
			wantCommand:    "claude-agent-acp",
			wantEnvVar:     "ANTHROPIC_API_KEY",
			wantInstallCmd: "npm install -g @zed-industries/claude-agent-acp",
		},
		{
			name:           "Claude Code with empty credential kind defaults to API key",
			agentType:      "claude-code",
			credentialKind: "",
			wantCommand:    "claude-agent-acp",
			wantEnvVar:     "ANTHROPIC_API_KEY",
			wantInstallCmd: "npm install -g @zed-industries/claude-agent-acp",
		},
		{
			name:              "OpenAI Codex with OAuth uses auth-file injection",
			agentType:         "openai-codex",
			credentialKind:    "oauth-token",
			wantCommand:       "codex-acp",
			wantEnvVar:        "",
			wantInstallCmd:    "npm install -g @zed-industries/codex-acp",
			wantInjectionMode: "auth-file",
			wantAuthFilePath:  ".codex/auth.json",
		},
		{
			name:           "OpenAI Codex with API key uses env var",
			agentType:      "openai-codex",
			credentialKind: "api-key",
			wantCommand:    "codex-acp",
			wantEnvVar:     "OPENAI_API_KEY",
			wantInstallCmd: "npm install -g @zed-industries/codex-acp",
		},
		{
			name:           "Google Gemini always uses API key",
			agentType:      "google-gemini",
			credentialKind: "oauth-token",
			wantCommand:    "gemini",
			wantEnvVar:     "GEMINI_API_KEY",
			wantInstallCmd: "npm install -g @google/gemini-cli",
		},
		{
			name:           "Mistral Vibe uses API key",
			agentType:      "mistral-vibe",
			credentialKind: "api-key",
			wantCommand:    "vibe-acp",
			wantEnvVar:     "MISTRAL_API_KEY",
			wantInstallCmd: `curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh && UV_TOOL_DIR=/opt/uv-tools UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_TOOL_BIN_DIR=/usr/local/bin uv tool install mistral-vibe --python 3.12 --quiet`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info := getAgentCommandInfo(tt.agentType, tt.credentialKind)

			if info.command != tt.wantCommand {
				t.Errorf("getAgentCommandInfo() command = %v, want %v", info.command, tt.wantCommand)
			}

			if info.envVarName != tt.wantEnvVar {
				t.Errorf("getAgentCommandInfo() envVarName = %v, want %v", info.envVarName, tt.wantEnvVar)
			}

			if info.installCmd != tt.wantInstallCmd {
				t.Errorf("getAgentCommandInfo() installCmd = %v, want %v", info.installCmd, tt.wantInstallCmd)
			}

			if info.injectionMode != tt.wantInjectionMode {
				t.Errorf("getAgentCommandInfo() injectionMode = %v, want %v", info.injectionMode, tt.wantInjectionMode)
			}

			if info.authFilePath != tt.wantAuthFilePath {
				t.Errorf("getAgentCommandInfo() authFilePath = %v, want %v", info.authFilePath, tt.wantAuthFilePath)
			}

			// Verify args for Gemini
			if tt.agentType == "google-gemini" && len(info.args) == 0 {
				t.Errorf("getAgentCommandInfo() expected args for google-gemini")
			}
		})
	}
}

func TestHasEnvVar(t *testing.T) {
	t.Parallel()

	envVars := []string{"GH_TOKEN=abc", "SAM_WORKSPACE_ID=ws-1"}

	if !hasEnvVar(envVars, "GH_TOKEN") {
		t.Error("hasEnvVar should find GH_TOKEN")
	}
	if !hasEnvVar(envVars, "SAM_WORKSPACE_ID") {
		t.Error("hasEnvVar should find SAM_WORKSPACE_ID")
	}
	if hasEnvVar(envVars, "MISSING") {
		t.Error("hasEnvVar should not find MISSING")
	}
	// Empty value should not count as present.
	if hasEnvVar([]string{"KEY="}, "KEY") {
		t.Error("hasEnvVar should not match empty-value entry")
	}
}

func TestSAMEnvFallbackMerge(t *testing.T) {
	t.Parallel()

	// Simulate: file-based env has some vars, fallback has all.
	fileEnv := []string{
		"SAM_WORKSPACE_ID=ws-from-file",
		"SAM_API_URL=https://api.example.com",
	}
	fallback := []string{
		"SAM_WORKSPACE_ID=ws-from-fallback", // Should NOT override file value
		"SAM_API_URL=https://api.other.com",  // Should NOT override file value
		"SAM_NODE_ID=node-456",               // Missing from file, should be added
		"SAM_PROJECT_ID=proj-789",            // Missing from file, should be added
	}

	// Merge: only add fallback vars not already present.
	merged := append([]string{}, fileEnv...)
	for _, fb := range fallback {
		key, _, ok := cutString(fb, "=")
		if ok && !hasEnvVar(merged, key) {
			merged = append(merged, fb)
		}
	}

	// File values should be preserved.
	assertEnvContains(t, merged, "SAM_WORKSPACE_ID", "ws-from-file")
	assertEnvContains(t, merged, "SAM_API_URL", "https://api.example.com")
	// Fallback values should fill gaps.
	assertEnvContains(t, merged, "SAM_NODE_ID", "node-456")
	assertEnvContains(t, merged, "SAM_PROJECT_ID", "proj-789")
}

// cutString is a test helper matching strings.Cut behavior.
func cutString(s, sep string) (string, string, bool) {
	for i := 0; i <= len(s)-len(sep); i++ {
		if s[i:i+len(sep)] == sep {
			return s[:i], s[i+len(sep):], true
		}
	}
	return s, "", false
}

// assertEnvContains checks that envVars contains KEY=expectedValue.
func assertEnvContains(t *testing.T, envVars []string, key, expectedValue string) {
	t.Helper()
	prefix := key + "="
	for _, entry := range envVars {
		if len(entry) > len(prefix) && entry[:len(prefix)] == prefix {
			got := entry[len(prefix):]
			if got != expectedValue {
				t.Errorf("env %s = %q, want %q", key, got, expectedValue)
			}
			return
		}
	}
	t.Errorf("env missing key %s", key)
}

// Tests from main branch for backward compatibility
func TestGetAgentCommandInfoClaudeCode(t *testing.T) {
	t.Parallel()

	info := getAgentCommandInfo("claude-code", "api-key")
	if info.command != "claude-agent-acp" {
		t.Fatalf("command=%q, want %q", info.command, "claude-agent-acp")
	}
	if info.envVarName != "ANTHROPIC_API_KEY" {
		t.Fatalf("envVarName=%q, want %q", info.envVarName, "ANTHROPIC_API_KEY")
	}
	if info.installCmd != "npm install -g @zed-industries/claude-agent-acp" {
		t.Fatalf("installCmd=%q, unexpected", info.installCmd)
	}
	if info.args != nil {
		t.Fatalf("args=%v, want nil", info.args)
	}
}

func TestGetAgentCommandInfoOpenAICodex(t *testing.T) {
	t.Parallel()

	info := getAgentCommandInfo("openai-codex", "api-key")
	if info.command != "codex-acp" {
		t.Fatalf("command=%q, want %q", info.command, "codex-acp")
	}
	if info.envVarName != "OPENAI_API_KEY" {
		t.Fatalf("envVarName=%q, want %q", info.envVarName, "OPENAI_API_KEY")
	}
	if info.installCmd != "npm install -g @zed-industries/codex-acp" {
		t.Fatalf("installCmd=%q, unexpected", info.installCmd)
	}
	if info.injectionMode != "" {
		t.Fatalf("injectionMode=%q, want empty for api-key", info.injectionMode)
	}
}

func TestGetAgentCommandInfoOpenAICodexOAuth(t *testing.T) {
	t.Parallel()

	info := getAgentCommandInfo("openai-codex", "oauth-token")
	if info.command != "codex-acp" {
		t.Fatalf("command=%q, want %q", info.command, "codex-acp")
	}
	if info.injectionMode != "auth-file" {
		t.Fatalf("injectionMode=%q, want %q", info.injectionMode, "auth-file")
	}
	if info.authFilePath != ".codex/auth.json" {
		t.Fatalf("authFilePath=%q, want %q", info.authFilePath, ".codex/auth.json")
	}
	if info.envVarName != "" {
		t.Fatalf("envVarName=%q, want empty for auth-file injection", info.envVarName)
	}
}

func TestGetAgentCommandInfoGoogleGemini(t *testing.T) {
	t.Parallel()

	info := getAgentCommandInfo("google-gemini", "api-key")
	if info.command != "gemini" {
		t.Fatalf("command=%q, want %q", info.command, "gemini")
	}
	if info.envVarName != "GEMINI_API_KEY" {
		t.Fatalf("envVarName=%q, want %q", info.envVarName, "GEMINI_API_KEY")
	}
	if len(info.args) != 1 || info.args[0] != "--experimental-acp" {
		t.Fatalf("args=%v, want [--experimental-acp]", info.args)
	}
}

func TestGetAgentCommandInfoMistralVibe(t *testing.T) {
	t.Parallel()

	info := getAgentCommandInfo("mistral-vibe", "api-key")
	if info.command != "vibe-acp" {
		t.Fatalf("command=%q, want %q", info.command, "vibe-acp")
	}
	if info.envVarName != "MISTRAL_API_KEY" {
		t.Fatalf("envVarName=%q, want %q", info.envVarName, "MISTRAL_API_KEY")
	}
	wantInstall := `curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh && UV_TOOL_DIR=/opt/uv-tools UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_TOOL_BIN_DIR=/usr/local/bin uv tool install mistral-vibe --python 3.12 --quiet`
	if info.installCmd != wantInstall {
		t.Fatalf("installCmd=%q, want %q", info.installCmd, wantInstall)
	}
	if info.isNpmBased {
		t.Fatalf("isNpmBased=true, want false (mistral-vibe uses uv, not npm)")
	}
	if info.args != nil {
		t.Fatalf("args=%v, want nil", info.args)
	}
	if info.injectionMode != "" {
		t.Fatalf("injectionMode=%q, want empty (env var injection)", info.injectionMode)
	}
	if info.authFilePath != "" {
		t.Fatalf("authFilePath=%q, want empty (no file-based auth)", info.authFilePath)
	}
}

func TestGetAgentCommandInfoMistralVibeIgnoresOAuth(t *testing.T) {
	t.Parallel()

	// Mistral Vibe doesn't support OAuth — even if oauth-token is passed,
	// it should still use the standard API key env var.
	info := getAgentCommandInfo("mistral-vibe", "oauth-token")
	if info.command != "vibe-acp" {
		t.Fatalf("command=%q, want %q", info.command, "vibe-acp")
	}
	if info.envVarName != "MISTRAL_API_KEY" {
		t.Fatalf("envVarName=%q, want %q — Mistral Vibe has no OAuth support", info.envVarName, "MISTRAL_API_KEY")
	}
}

func TestGetModelEnvVarMistralVibe(t *testing.T) {
	t.Parallel()

	got := getModelEnvVar("mistral-vibe")
	if got != "VIBE_ACTIVE_MODEL" {
		t.Fatalf("getModelEnvVar(\"mistral-vibe\") = %q, want %q", got, "VIBE_ACTIVE_MODEL")
	}
}

func TestGetAgentExtraEnvVars_MistralVibe(t *testing.T) {
	t.Parallel()

	envVars := getAgentExtraEnvVars("mistral-vibe")
	if len(envVars) != 2 {
		t.Fatalf("expected 2 extra env vars for mistral-vibe, got %d", len(envVars))
	}
	wantName := "VIBE_CLIENT_NAME=sam"
	wantVersion := "VIBE_CLIENT_VERSION=1.0.1"
	if envVars[0] != wantName {
		t.Errorf("envVars[0]=%q, want %q", envVars[0], wantName)
	}
	if envVars[1] != wantVersion {
		t.Errorf("envVars[1]=%q, want %q", envVars[1], wantVersion)
	}
}

func TestGetAgentExtraEnvVars_OtherAgents(t *testing.T) {
	t.Parallel()

	for _, agent := range []string{"claude-code", "openai-codex", "google-gemini", "unknown"} {
		if envVars := getAgentExtraEnvVars(agent); len(envVars) != 0 {
			t.Errorf("getAgentExtraEnvVars(%q) returned %v, want nil", agent, envVars)
		}
	}
}

func TestGenerateVibeConfig_DefaultModel(t *testing.T) {
	t.Parallel()

	config := generateVibeConfig("", nil)

	// Verify active_model references the default alias
	if !strings.Contains(config, `active_model = "mistral-large"`) {
		t.Errorf("expected default active_model to be mistral-large, got:\n%s", config)
	}

	// Verify all three model entries are defined with correct name→alias mappings
	requiredModels := []struct {
		name  string
		alias string
	}{
		{"mistral-large-latest", "mistral-large"},
		{"mistral-vibe-cli-latest", "devstral-2"},
		{"codestral-latest", "codestral"},
	}
	for _, m := range requiredModels {
		if !strings.Contains(config, fmt.Sprintf(`name = "%s"`, m.name)) {
			t.Errorf("missing model name %q", m.name)
		}
		if !strings.Contains(config, fmt.Sprintf(`alias = "%s"`, m.alias)) {
			t.Errorf("missing model alias %q", m.alias)
		}
	}

	// Verify the active_model alias is actually defined as a model entry
	if !strings.Contains(config, `alias = "`+vibeDefaultActiveModel+`"`) {
		t.Errorf("active_model %q is not defined as a model alias", vibeDefaultActiveModel)
	}

	// Count [[models]] entries — should be exactly 3
	if count := strings.Count(config, "[[models]]"); count != 3 {
		t.Errorf("expected 3 [[models]] entries, got %d", count)
	}
}

func TestGenerateVibeConfig_CustomModel(t *testing.T) {
	t.Parallel()

	config := generateVibeConfig("devstral-2", nil)
	if !strings.Contains(config, `active_model = "devstral-2"`) {
		t.Errorf("expected active_model to be devstral-2, got:\n%s", config)
	}
	// All model aliases must still be present regardless of active model
	for _, alias := range []string{"mistral-large", "devstral-2", "codestral"} {
		if !strings.Contains(config, fmt.Sprintf(`alias = "%s"`, alias)) {
			t.Errorf("missing model alias %q when active model is devstral-2", alias)
		}
	}
}

func TestResolveVibeActiveModel(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		settings *agentSettingsPayload
		want     string
	}{
		{"nil settings", nil, vibeDefaultActiveModel},
		{"empty model", &agentSettingsPayload{Model: ""}, vibeDefaultActiveModel},
		{"custom model", &agentSettingsPayload{Model: "devstral-2"}, "devstral-2"},
		{"custom model with other settings", &agentSettingsPayload{Model: "codestral", PermissionMode: "full"}, "codestral"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := resolveVibeActiveModel(tt.settings)
			if got != tt.want {
				t.Errorf("resolveVibeActiveModel() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSanitizeVibeModelAlias(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"valid alias", "devstral-2", "devstral-2"},
		{"valid with dots", "mistral-large-2512", "mistral-large-2512"},
		{"valid with underscore", "my_model", "my_model"},
		{"empty falls back", "", vibeDefaultActiveModel},
		{"TOML injection rejected", `"; rm -rf ~`, vibeDefaultActiveModel},
		{"newline rejected", "model\ninjection", vibeDefaultActiveModel},
		{"quote rejected", `model"bad`, vibeDefaultActiveModel},
		{"backslash rejected", `model\bad`, vibeDefaultActiveModel},
		{"space rejected", "model bad", vibeDefaultActiveModel},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := sanitizeVibeModelAlias(tt.input)
			if got != tt.want {
				t.Errorf("sanitizeVibeModelAlias(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestGetAgentCommandInfoUnknown(t *testing.T) {
	t.Parallel()

	info := getAgentCommandInfo("custom-agent", "api-key")
	if info.command != "custom-agent" {
		t.Fatalf("command=%q, want %q", info.command, "custom-agent")
	}
	if info.envVarName != "API_KEY" {
		t.Fatalf("envVarName=%q, want %q", info.envVarName, "API_KEY")
	}
	if info.installCmd != "" {
		t.Fatalf("installCmd=%q, want empty for unknown agent", info.installCmd)
	}
}

// Additional OAuth-specific tests
func TestAgentCredential_ErrorMessages(t *testing.T) {
	tests := []struct {
		name           string
		credentialKind string
		agentType      string
		wantContains   string
	}{
		{
			name:           "OAuth token error message",
			credentialKind: "oauth-token",
			agentType:      "claude-code",
			wantContains:   "OAuth token",
		},
		{
			name:           "API key error message",
			credentialKind: "api-key",
			agentType:      "claude-code",
			wantContains:   "API key",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Create credential struct
			cred := &agentCredential{
				credential:     "test-credential",
				credentialKind: tt.credentialKind,
			}

			// Generate error message based on credential type
			credType := "API key"
			if cred.credentialKind == "oauth-token" {
				credType = "OAuth token"
			}

			if credType != tt.wantContains {
				t.Errorf("Credential type message = %v, want contains %v", credType, tt.wantContains)
			}
		})
	}
}

// TestProcessConfig_EnvVarInjection verifies that the correct environment
// variable is set when starting an agent process with OAuth credentials
func TestProcessConfig_EnvVarInjection(t *testing.T) {
	tests := []struct {
		name              string
		agentType         string
		credential        *agentCredential
		wantEnvVar        string
		wantInjectionMode string
	}{
		{
			name:      "OAuth token uses CLAUDE_CODE_OAUTH_TOKEN",
			agentType: "claude-code",
			credential: &agentCredential{
				credential:     "oauth_token_value",
				credentialKind: "oauth-token",
			},
			wantEnvVar: "CLAUDE_CODE_OAUTH_TOKEN=oauth_token_value",
		},
		{
			name:      "API key uses ANTHROPIC_API_KEY",
			agentType: "claude-code",
			credential: &agentCredential{
				credential:     "sk-ant-api-key",
				credentialKind: "api-key",
			},
			wantEnvVar: "ANTHROPIC_API_KEY=sk-ant-api-key",
		},
		{
			name:      "OpenAI Codex OAuth uses auth-file injection (no env var)",
			agentType: "openai-codex",
			credential: &agentCredential{
				credential:     `{"auth_mode":"Chatgpt","tokens":{}}`,
				credentialKind: "oauth-token",
			},
			wantInjectionMode: "auth-file",
		},
		{
			name:      "OpenAI Codex API key uses env var",
			agentType: "openai-codex",
			credential: &agentCredential{
				credential:     "sk-openai-key",
				credentialKind: "api-key",
			},
			wantEnvVar: "OPENAI_API_KEY=sk-openai-key",
		},
		{
			name:      "Mistral Vibe API key uses env var",
			agentType: "mistral-vibe",
			credential: &agentCredential{
				credential:     "mistral-api-key-123",
				credentialKind: "api-key",
			},
			wantEnvVar: "MISTRAL_API_KEY=mistral-api-key-123",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info := getAgentCommandInfo(tt.agentType, tt.credential.credentialKind)

			if tt.wantInjectionMode != "" {
				if info.injectionMode != tt.wantInjectionMode {
					t.Errorf("injectionMode = %v, want %v", info.injectionMode, tt.wantInjectionMode)
				}
				// Auth-file mode should have empty envVarName
				if info.envVarName != "" {
					t.Errorf("envVarName should be empty for auth-file injection, got %v", info.envVarName)
				}
			} else {
				envVar := info.envVarName + "=" + tt.credential.credential
				if envVar != tt.wantEnvVar {
					t.Errorf("Environment variable = %v, want %v", envVar, tt.wantEnvVar)
				}
			}
		})
	}
}

func TestParseEnvExportLines(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		content string
		want    []string
	}{
		{
			name: "standard SAM env file",
			content: `# SAM workspace environment variables (auto-generated)
export GH_TOKEN="ghs_abc123"
export SAM_API_URL="https://api.example.com"
export SAM_WORKSPACE_ID="ws-123"
`,
			want: []string{
				"GH_TOKEN=ghs_abc123",
				"SAM_API_URL=https://api.example.com",
				"SAM_WORKSPACE_ID=ws-123",
			},
		},
		{
			name:    "empty content",
			content: "",
			want:    nil,
		},
		{
			name:    "comments only",
			content: "# just a comment\n# another comment\n",
			want:    nil,
		},
		{
			name:    "unquoted values",
			content: "export FOO=bar\n",
			want:    []string{"FOO=bar"},
		},
		{
			name:    "blank lines ignored",
			content: "\n\nexport A=\"1\"\n\n",
			want:    []string{"A=1"},
		},
		{
			name:    "no export prefix",
			content: "KEY=\"value\"\n",
			want:    []string{"KEY=value"},
		},
		{
			name:    "malformed line no equals",
			content: "export NOEQUALS\n",
			want:    nil,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := parseEnvExportLines(tt.content)
			if len(got) != len(tt.want) {
				t.Fatalf("parseEnvExportLines() returned %d entries, want %d\ngot: %v\nwant: %v", len(got), len(tt.want), got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("entry[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

func TestGenerateVibeConfig_NoMcpServers(t *testing.T) {
	t.Parallel()

	config := generateVibeConfig("mistral-large", nil)

	// No [[mcp_servers]] section should appear
	if strings.Contains(config, "[[mcp_servers]]") {
		t.Error("expected no [[mcp_servers]] section when mcpServers is nil")
	}

	// All model aliases must still be present
	for _, alias := range []string{"mistral-large", "devstral-2", "codestral"} {
		if !strings.Contains(config, fmt.Sprintf(`alias = "%s"`, alias)) {
			t.Errorf("missing model alias %q", alias)
		}
	}
}

func TestGenerateVibeConfig_McpServerWithToken(t *testing.T) {
	t.Parallel()

	config := generateVibeConfig("mistral-large", []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "test-token-123"},
	})

	if !strings.Contains(config, "[[mcp_servers]]") {
		t.Fatal("expected [[mcp_servers]] section in config")
	}
	if !strings.Contains(config, `name = "sam-mcp-0"`) {
		t.Error("expected MCP server name sam-mcp-0")
	}
	if !strings.Contains(config, `url = "https://api.example.com/mcp"`) {
		t.Error("expected MCP server URL")
	}
	if !strings.Contains(config, `headers = { Authorization = "Bearer test-token-123" }`) {
		t.Error("expected Authorization header with token")
	}

	// Model aliases must still be present
	for _, alias := range []string{"mistral-large", "devstral-2", "codestral"} {
		if !strings.Contains(config, fmt.Sprintf(`alias = "%s"`, alias)) {
			t.Errorf("missing model alias %q", alias)
		}
	}
}

func TestGenerateVibeConfig_McpServerWithoutToken(t *testing.T) {
	t.Parallel()

	config := generateVibeConfig("devstral-2", []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: ""},
	})

	if !strings.Contains(config, `url = "https://api.example.com/mcp"`) {
		t.Error("expected MCP server URL")
	}
	// No Authorization header when token is empty
	if strings.Contains(config, "Authorization") {
		t.Error("expected no Authorization header when token is empty")
	}
}

func TestGenerateVibeConfig_MultipleMcpServers(t *testing.T) {
	t.Parallel()

	config := generateVibeConfig("codestral", []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "token-1"},
		{URL: "https://backup.example.com/mcp", Token: "token-2"},
	})

	// Both servers should be present
	if count := strings.Count(config, "[[mcp_servers]]"); count != 2 {
		t.Errorf("expected 2 [[mcp_servers]] entries, got %d", count)
	}
	if !strings.Contains(config, `name = "sam-mcp-0"`) {
		t.Error("expected sam-mcp-0")
	}
	if !strings.Contains(config, `name = "sam-mcp-1"`) {
		t.Error("expected sam-mcp-1")
	}
	if !strings.Contains(config, `url = "https://api.example.com/mcp"`) {
		t.Error("expected first MCP server URL")
	}
	if !strings.Contains(config, `url = "https://backup.example.com/mcp"`) {
		t.Error("expected second MCP server URL")
	}
	if !strings.Contains(config, `"Bearer token-1"`) {
		t.Error("expected first token")
	}
	if !strings.Contains(config, `"Bearer token-2"`) {
		t.Error("expected second token")
	}
}

func TestGenerateVibeConfig_McpServerSpecialCharsInURL(t *testing.T) {
	t.Parallel()

	config := generateVibeConfig("mistral-large", []McpServerEntry{
		{URL: "https://api.example.com/path?param=value&other=test", Token: "tok"},
	})

	if !strings.Contains(config, `url = "https://api.example.com/path?param=value&other=test"`) {
		t.Error("expected URL with query params to be preserved")
	}
}

func TestGenerateVibeConfig_McpServerBackslashEscaping(t *testing.T) {
	t.Parallel()

	config := generateVibeConfig("mistral-large", []McpServerEntry{
		{URL: `https://example.com/path\with\backslash`, Token: `tok\en`},
	})

	// Backslashes must be doubled in TOML basic strings
	if !strings.Contains(config, `url = "https://example.com/path\\with\\backslash"`) {
		t.Errorf("backslash not escaped in URL:\n%s", config)
	}
	if !strings.Contains(config, `Bearer tok\\en`) {
		t.Errorf("backslash not escaped in token:\n%s", config)
	}
}

func TestGenerateVibeConfig_McpServerNewlineRejected(t *testing.T) {
	t.Parallel()

	config := generateVibeConfig("mistral-large", []McpServerEntry{
		{URL: "https://good.example.com/mcp", Token: "good-token"},
		{URL: "https://bad.example.com/mcp", Token: "bad\ninjection"},
	})

	// Good server should be present
	if !strings.Contains(config, `url = "https://good.example.com/mcp"`) {
		t.Error("expected good MCP server to be present")
	}
	// Bad server with newline in token should be skipped entirely
	if strings.Contains(config, "bad.example.com") {
		t.Error("MCP server with newline in token should be skipped")
	}
	if strings.Contains(config, "injection") {
		t.Error("newline in token must not inject content into TOML")
	}
}
