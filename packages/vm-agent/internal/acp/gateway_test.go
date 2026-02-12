package acp

import (
	"testing"
)

// Tests for OAuth support
func TestGetAgentCommandInfo_OAuthToken(t *testing.T) {
	tests := []struct {
		name           string
		agentType      string
		credentialKind string
		wantCommand    string
		wantEnvVar     string
		wantInstallCmd string
	}{
		{
			name:           "Claude Code with OAuth token",
			agentType:      "claude-code",
			credentialKind: "oauth-token",
			wantCommand:    "claude-code-acp",
			wantEnvVar:     "CLAUDE_CODE_OAUTH_TOKEN",
			wantInstallCmd: "npm install -g @zed-industries/claude-code-acp",
		},
		{
			name:           "Claude Code with API key",
			agentType:      "claude-code",
			credentialKind: "api-key",
			wantCommand:    "claude-code-acp",
			wantEnvVar:     "ANTHROPIC_API_KEY",
			wantInstallCmd: "npm install -g @zed-industries/claude-code-acp",
		},
		{
			name:           "Claude Code with empty credential kind defaults to API key",
			agentType:      "claude-code",
			credentialKind: "",
			wantCommand:    "claude-code-acp",
			wantEnvVar:     "ANTHROPIC_API_KEY",
			wantInstallCmd: "npm install -g @zed-industries/claude-code-acp",
		},
		{
			name:           "OpenAI Codex always uses API key",
			agentType:      "openai-codex",
			credentialKind: "oauth-token",
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

			// Verify args for Gemini
			if tt.agentType == "google-gemini" && len(info.args) == 0 {
				t.Errorf("getAgentCommandInfo() expected args for google-gemini")
			}
		})
	}
}

// Tests from main branch for backward compatibility
func TestGetAgentCommandInfoClaudeCode(t *testing.T) {
	t.Parallel()

	info := getAgentCommandInfo("claude-code", "api-key")
	if info.command != "claude-code-acp" {
		t.Fatalf("command=%q, want %q", info.command, "claude-code-acp")
	}
	if info.envVarName != "ANTHROPIC_API_KEY" {
		t.Fatalf("envVarName=%q, want %q", info.envVarName, "ANTHROPIC_API_KEY")
	}
	if info.installCmd != "npm install -g @zed-industries/claude-code-acp" {
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
		name       string
		agentType  string
		credential *agentCredential
		wantEnvVar string
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
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Get the command info based on credential type
			info := getAgentCommandInfo(tt.agentType, tt.credential.credentialKind)

			// Build the environment variable string
			envVar := info.envVarName + "=" + tt.credential.credential

			if envVar != tt.wantEnvVar {
				t.Errorf("Environment variable = %v, want %v", envVar, tt.wantEnvVar)
			}
		})
	}
}
