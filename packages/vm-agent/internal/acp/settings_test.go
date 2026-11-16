package acp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestBuildCodexACPManagedConfigEnv(t *testing.T) {
	type projectTrust struct {
		TrustLevel string `json:"trust_level"`
	}
	type managedConfig struct {
		SandboxMode     string                  `json:"sandbox_mode"`
		ApprovalPolicy  string                  `json:"approval_policy"`
		Model           *string                 `json:"model"`
		BypassHookTrust *bool                   `json:"bypass_hook_trust"`
		Projects        map[string]projectTrust `json:"projects"`
	}
	for _, tc := range []struct {
		name         string
		settings     *agentSettingsPayload
		workDir      string
		wantModel    string
		wantProjects map[string]projectTrust
	}{
		{name: "nil settings, no work dir"},
		{name: "empty model", settings: &agentSettingsPayload{}},
		{name: "GPT-6.1 Sol", settings: &agentSettingsPayload{Model: "gpt-6.1-sol"}, wantModel: "gpt-6.1-sol"},
		{name: "JSON special characters", settings: &agentSettingsPayload{Model: `custom\"model\\variant`}, wantModel: `custom\"model\\variant`},
		{
			name:         "VM devcontainer work dir is trusted",
			workDir:      "/workspaces/simple-agent-manager",
			wantProjects: map[string]projectTrust{"/workspaces/simple-agent-manager": {TrustLevel: "trusted"}},
		},
		{
			name:         "work dir is cleaned",
			workDir:      " /workspaces/repo/ ",
			wantProjects: map[string]projectTrust{"/workspaces/repo": {TrustLevel: "trusted"}},
		},
		{name: "relative work dir is not trusted", workDir: "repo"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			envVar, err := buildCodexACPManagedConfigEnv(tc.settings, tc.workDir)
			if err != nil {
				t.Fatalf("buildCodexACPManagedConfigEnv failed: %v", err)
			}
			const prefix = "CODEX_CONFIG="
			if !strings.HasPrefix(envVar, prefix) {
				t.Fatalf("managed config env = %q, want %q prefix", envVar, prefix)
			}
			var config managedConfig
			if err := json.Unmarshal([]byte(strings.TrimPrefix(envVar, prefix)), &config); err != nil {
				t.Fatalf("managed config is not valid JSON: %v", err)
			}
			if config.SandboxMode != "danger-full-access" || config.ApprovalPolicy != "never" {
				t.Fatalf("sandbox/approval = %q/%q, want danger-full-access/never", config.SandboxMode, config.ApprovalPolicy)
			}
			// Repository hooks run in every Codex session (idea 01M7J0TXAHGRY8CWA7Y7SJZAK0).
			if config.BypassHookTrust == nil || !*config.BypassHookTrust {
				t.Fatalf("bypass_hook_trust = %v, want true", config.BypassHookTrust)
			}
			switch {
			case tc.wantModel == "" && config.Model != nil:
				t.Fatalf("empty model should be omitted, got %q", *config.Model)
			case tc.wantModel != "" && (config.Model == nil || *config.Model != tc.wantModel):
				t.Fatalf("model = %v, want %q", config.Model, tc.wantModel)
			}
			if len(tc.wantProjects) == 0 && config.Projects != nil {
				t.Fatalf("projects should be omitted, got %#v", config.Projects)
			}
			if len(tc.wantProjects) > 0 {
				if len(config.Projects) != len(tc.wantProjects) {
					t.Fatalf("projects = %#v, want %#v", config.Projects, tc.wantProjects)
				}
				for dir, want := range tc.wantProjects {
					if config.Projects[dir] != want {
						t.Fatalf("projects[%q] = %#v, want %#v", dir, config.Projects[dir], want)
					}
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
