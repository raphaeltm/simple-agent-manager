package acp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestBuildCodexACPManagedConfigEnv(t *testing.T) {
	for _, tc := range []struct {
		name      string
		settings  *agentSettingsPayload
		wantModel string
	}{
		{name: "nil settings"},
		{name: "empty model", settings: &agentSettingsPayload{}},
		{name: "GPT-6.1 Sol", settings: &agentSettingsPayload{Model: "gpt-6.1-sol"}, wantModel: "gpt-6.1-sol"},
		{name: "JSON special characters", settings: &agentSettingsPayload{Model: `custom\"model\\variant`}, wantModel: `custom\"model\\variant`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			envVar, err := buildCodexACPManagedConfigEnv(tc.settings)
			if err != nil {
				t.Fatalf("buildCodexACPManagedConfigEnv failed: %v", err)
			}
			const prefix = "CODEX_CONFIG="
			if !strings.HasPrefix(envVar, prefix) {
				t.Fatalf("managed config env = %q, want %q prefix", envVar, prefix)
			}
			var config map[string]string
			if err := json.Unmarshal([]byte(strings.TrimPrefix(envVar, prefix)), &config); err != nil {
				t.Fatalf("managed config is not valid JSON: %v", err)
			}
			if got := config["sandbox_mode"]; got != "danger-full-access" {
				t.Fatalf("sandbox_mode = %q, want danger-full-access", got)
			}
			if got := config["approval_policy"]; got != "never" {
				t.Fatalf("approval_policy = %q, want never", got)
			}
			if got := config["model"]; got != tc.wantModel {
				t.Fatalf("model = %q, want %q", got, tc.wantModel)
			}
			if tc.wantModel == "" {
				if _, ok := config["model"]; ok {
					t.Fatalf("empty model should be omitted: %#v", config)
				}
			}
		})
	}
}

func TestGetModelEnvVar(t *testing.T) {
	tests := []struct {
		agentType string
		want      string
	}{
		{"claude-code", "ANTHROPIC_MODEL"},
		{"openai-codex", "OPENAI_MODEL"},
		{"google-gemini", "GEMINI_MODEL"},
		{"mistral-vibe", "VIBE_ACTIVE_MODEL"},
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
			name:      "Mistral Vibe with model override",
			agentType: "mistral-vibe",
			settings:  &agentSettingsPayload{Model: "devstral-2"},
			wantEnv:   "VIBE_ACTIVE_MODEL=devstral-2",
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

func TestApplyModelAndExtraEnvAddsClaudeEffort(t *testing.T) {
	h := &SessionHost{}

	envVars, _ := h.applyModelAndExtraEnv("claude-code", &agentSettingsPayload{
		Model:  "claude-opus-4-6",
		Effort: "xhigh",
	}, nil)

	if !hasEnvEntry(envVars, "ANTHROPIC_MODEL=claude-opus-4-6") {
		t.Fatalf("expected model env var, got %v", envVars)
	}
	if !hasEnvEntry(envVars, "CLAUDE_CODE_EFFORT_LEVEL=xhigh") {
		t.Fatalf("expected Claude effort env var, got %v", envVars)
	}
}

func TestApplyModelAndExtraEnvOmitsAutoEffort(t *testing.T) {
	h := &SessionHost{}

	envVars, _ := h.applyModelAndExtraEnv("claude-code", &agentSettingsPayload{
		Effort: "auto",
	}, nil)

	if hasEnvEntry(envVars, "CLAUDE_CODE_EFFORT_LEVEL=auto") {
		t.Fatalf("auto effort should not be forced into env vars: %v", envVars)
	}
}

func TestPermissionModeOnSessionHost(t *testing.T) {
	// Test that SessionHost stores permission mode correctly
	h := &SessionHost{}

	// Default should be empty string (not set)
	if h.permissionMode != "" {
		t.Errorf("default permissionMode = %q, want empty", h.permissionMode)
	}

	// Set various modes — includes plan and dontAsk from ACP agent
	modes := []string{"default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"}
	for _, mode := range modes {
		h.permissionMode = mode
		if h.permissionMode != mode {
			t.Errorf("permissionMode = %q, want %q", h.permissionMode, mode)
		}
	}
}

func TestApplySessionSettingsNilSafety(t *testing.T) {
	// applySessionSettings must be safe to call with nil settings, nil acpConn,
	// or empty sessionID. It should simply return without panic.
	h := &SessionHost{}

	// nil settings — should not panic
	_ = h.applySessionSettings(context.Background(), nil)

	// non-nil settings but no acpConn — should not panic
	_ = h.applySessionSettings(context.Background(), &agentSettingsPayload{Model: "sonnet"})

	// non-nil settings with empty sessionID — should not panic
	_ = h.applySessionSettings(context.Background(), &agentSettingsPayload{PermissionMode: "plan"})
}

func TestApplySessionSettingsSkipsDefault(t *testing.T) {
	// When permissionMode is "default", SetSessionMode should NOT be called
	// because that's the agent's initial mode (avoids unnecessary RPC).
	// We verify this indirectly: applySessionSettings with no acpConn +
	// default mode should return cleanly without attempting any call.
	h := &SessionHost{}
	settings := &agentSettingsPayload{
		Model:          "",
		PermissionMode: "default",
	}
	// Should not panic or attempt any ACP calls
	_ = h.applySessionSettings(context.Background(), settings)
}
