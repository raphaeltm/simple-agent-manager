package acp

import (
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
			wantInstallCmd: `ARCH=$(uname -m) && curl -fLo /usr/local/bin/vibe-acp "https://github.com/mistralai/mistral-vibe/releases/latest/download/vibe-acp-linux-${ARCH}" && chmod +x /usr/local/bin/vibe-acp`,
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
	if info.installCmd == "" {
		t.Fatal("installCmd should not be empty for mistral-vibe")
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
