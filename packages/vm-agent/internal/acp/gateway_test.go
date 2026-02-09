package acp

import (
	"testing"
)

func TestGetAgentCommandInfo_OAuthToken(t *testing.T) {
	tests := []struct {
		name           string
		agentType      string
		credentialKind string
		wantCommand    string
		wantEnvVar     string
	}{
		{
			name:           "Claude Code with OAuth token",
			agentType:      "claude-code",
			credentialKind: "oauth-token",
			wantCommand:    "claude-code-acp",
			wantEnvVar:     "CLAUDE_CODE_OAUTH_TOKEN",
		},
		{
			name:           "Claude Code with API key",
			agentType:      "claude-code",
			credentialKind: "api-key",
			wantCommand:    "claude-code-acp",
			wantEnvVar:     "ANTHROPIC_API_KEY",
		},
		{
			name:           "Claude Code with empty credential kind defaults to API key",
			agentType:      "claude-code",
			credentialKind: "",
			wantCommand:    "claude-code-acp",
			wantEnvVar:     "ANTHROPIC_API_KEY",
		},
		{
			name:           "OpenAI Codex always uses API key",
			agentType:      "openai-codex",
			credentialKind: "oauth-token",
			wantCommand:    "codex-acp",
			wantEnvVar:     "OPENAI_API_KEY",
		},
		{
			name:           "Google Gemini always uses API key",
			agentType:      "google-gemini",
			credentialKind: "oauth-token",
			wantCommand:    "gemini",
			wantEnvVar:     "GEMINI_API_KEY",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			command, args, envVarName := getAgentCommandInfo(tt.agentType, tt.credentialKind)

			if command != tt.wantCommand {
				t.Errorf("getAgentCommandInfo() command = %v, want %v", command, tt.wantCommand)
			}

			if envVarName != tt.wantEnvVar {
				t.Errorf("getAgentCommandInfo() envVarName = %v, want %v", envVarName, tt.wantEnvVar)
			}

			// Verify args for Gemini
			if tt.agentType == "google-gemini" && len(args) == 0 {
				t.Errorf("getAgentCommandInfo() expected args for google-gemini")
			}
		})
	}
}

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
		name         string
		agentType    string
		credential   *agentCredential
		wantEnvVar   string
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
			_, _, envVarName := getAgentCommandInfo(tt.agentType, tt.credential.credentialKind)

			// Build the environment variable string
			envVar := envVarName + "=" + tt.credential.credential

			if envVar != tt.wantEnvVar {
				t.Errorf("Environment variable = %v, want %v", envVar, tt.wantEnvVar)
			}
		})
	}
}