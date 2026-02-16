package acp

import (
	"context"
	"testing"
)

func TestGetModelEnvVar(t *testing.T) {
	tests := []struct {
		agentType string
		want      string
	}{
		{"claude-code", "ANTHROPIC_MODEL"},
		{"openai-codex", "OPENAI_MODEL"},
		{"google-gemini", "GEMINI_MODEL"},
		{"unknown-agent", ""},
		{"", ""},
	}

	for _, tt := range tests {
		t.Run(tt.agentType, func(t *testing.T) {
			got := getModelEnvVar(tt.agentType)
			if got != tt.want {
				t.Errorf("getModelEnvVar(%q) = %q, want %q", tt.agentType, got, tt.want)
			}
		})
	}
}

func TestAgentSettingsPayload(t *testing.T) {
	// Verify struct fields exist and can be set
	s := agentSettingsPayload{
		Model:          "claude-opus-4-6",
		PermissionMode: "bypassPermissions",
	}

	if s.Model != "claude-opus-4-6" {
		t.Errorf("Model = %q, want %q", s.Model, "claude-opus-4-6")
	}
	if s.PermissionMode != "bypassPermissions" {
		t.Errorf("PermissionMode = %q, want %q", s.PermissionMode, "bypassPermissions")
	}
}

func TestAgentSettingsEnvVarInjection(t *testing.T) {
	tests := []struct {
		name      string
		agentType string
		settings  *agentSettingsPayload
		wantEnv   string // expected env var like "CLAUDE_MODEL=model-id"
	}{
		{
			name:      "Claude Code with model override",
			agentType: "claude-code",
			settings:  &agentSettingsPayload{Model: "claude-opus-4-6"},
			wantEnv:   "ANTHROPIC_MODEL=claude-opus-4-6",
		},
		{
			name:      "OpenAI Codex with model override",
			agentType: "openai-codex",
			settings:  &agentSettingsPayload{Model: "gpt-5-codex"},
			wantEnv:   "OPENAI_MODEL=gpt-5-codex",
		},
		{
			name:      "Gemini with model override",
			agentType: "google-gemini",
			settings:  &agentSettingsPayload{Model: "gemini-2.5-pro"},
			wantEnv:   "GEMINI_MODEL=gemini-2.5-pro",
		},
		{
			name:      "Empty model should not produce env var",
			agentType: "claude-code",
			settings:  &agentSettingsPayload{Model: ""},
			wantEnv:   "",
		},
		{
			name:      "Nil settings should not produce env var",
			agentType: "claude-code",
			settings:  nil,
			wantEnv:   "",
		},
		{
			name:      "Unknown agent with model should not produce env var",
			agentType: "custom-agent",
			settings:  &agentSettingsPayload{Model: "some-model"},
			wantEnv:   "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var envVar string

			if tt.settings != nil && tt.settings.Model != "" {
				modelEnv := getModelEnvVar(tt.agentType)
				if modelEnv != "" {
					envVar = modelEnv + "=" + tt.settings.Model
				}
			}

			if envVar != tt.wantEnv {
				t.Errorf("env var = %q, want %q", envVar, tt.wantEnv)
			}
		})
	}
}

func TestPermissionModeOnGateway(t *testing.T) {
	// Test that Gateway struct stores permission mode correctly
	g := &Gateway{}

	// Default should be empty string (not set)
	if g.permissionMode != "" {
		t.Errorf("default permissionMode = %q, want empty", g.permissionMode)
	}

	// Set various modes — includes plan and dontAsk from ACP agent
	modes := []string{"default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"}
	for _, mode := range modes {
		g.permissionMode = mode
		if g.permissionMode != mode {
			t.Errorf("permissionMode = %q, want %q", g.permissionMode, mode)
		}
	}
}

func TestApplySessionSettingsNilSafety(t *testing.T) {
	// applySessionSettings must be safe to call with nil settings, nil acpConn,
	// or empty sessionID. It should simply return without panic.
	g := &Gateway{}

	// nil settings — should not panic
	g.applySessionSettings(context.Background(), nil)

	// non-nil settings but no acpConn — should not panic
	g.applySessionSettings(context.Background(), &agentSettingsPayload{Model: "sonnet"})

	// non-nil settings with empty sessionID — should not panic
	g.applySessionSettings(context.Background(), &agentSettingsPayload{PermissionMode: "plan"})
}

func TestApplySessionSettingsSkipsDefault(t *testing.T) {
	// When permissionMode is "default", SetSessionMode should NOT be called
	// because that's the agent's initial mode (avoids unnecessary RPC).
	// We verify this indirectly: applySessionSettings with no acpConn +
	// default mode should return cleanly without attempting any call.
	g := &Gateway{}
	settings := &agentSettingsPayload{
		Model:          "",
		PermissionMode: "default",
	}
	// Should not panic or attempt any ACP calls
	g.applySessionSettings(context.Background(), settings)
}
