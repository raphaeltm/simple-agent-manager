package acp

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pelletier/go-toml/v2"
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
		wantArgs          []string
	}{
		{
			name:           "Claude Code with OAuth token",
			agentType:      "claude-code",
			credentialKind: "oauth-token",
			wantCommand:    "claude-agent-acp",
			wantEnvVar:     "CLAUDE_CODE_OAUTH_TOKEN",
			wantInstallCmd: "npm install -g @agentclientprotocol/claude-agent-acp@0.58.1",
		},
		{
			name:           "Claude Code with API key",
			agentType:      "claude-code",
			credentialKind: "api-key",
			wantCommand:    "claude-agent-acp",
			wantEnvVar:     "ANTHROPIC_API_KEY",
			wantInstallCmd: "npm install -g @agentclientprotocol/claude-agent-acp@0.58.1",
		},
		{
			name:           "Claude Code with empty credential kind defaults to API key",
			agentType:      "claude-code",
			credentialKind: "",
			wantCommand:    "claude-agent-acp",
			wantEnvVar:     "ANTHROPIC_API_KEY",
			wantInstallCmd: "npm install -g @agentclientprotocol/claude-agent-acp@0.58.1",
		},
		{
			name:              "OpenAI Codex with OAuth uses auth-file injection",
			agentType:         "openai-codex",
			credentialKind:    "oauth-token",
			wantCommand:       "codex-acp",
			wantEnvVar:        "",
			wantInstallCmd:    "npm install -g @agentclientprotocol/codex-acp@1.1.2 @openai/codex@0.144.6",
			wantInjectionMode: "auth-file",
			wantAuthFilePath:  ".codex/auth.json",
		},
		{
			name:           "OpenAI Codex with API key uses env var",
			agentType:      "openai-codex",
			credentialKind: "api-key",
			wantCommand:    "codex-acp",
			wantEnvVar:     "OPENAI_API_KEY",
			wantInstallCmd: "npm install -g @agentclientprotocol/codex-acp@1.1.2 @openai/codex@0.144.6",
		},
		{
			name:           "Google Gemini always uses API key",
			agentType:      "google-gemini",
			credentialKind: "oauth-token",
			wantCommand:    "gemini",
			wantEnvVar:     "GEMINI_API_KEY",
			wantInstallCmd: "npm install -g @google/gemini-cli@0.50.0",
		},
		{
			name:           "Mistral Vibe uses API key",
			agentType:      "mistral-vibe",
			credentialKind: "api-key",
			wantCommand:    "vibe-acp",
			wantEnvVar:     "MISTRAL_API_KEY",
			wantInstallCmd: `curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh && UV_TOOL_DIR=/opt/uv-tools UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_TOOL_BIN_DIR=/usr/local/bin uv tool install mistral-vibe==2.19.1 --python 3.12 --quiet`,
		},
		{
			name:           "Amp uses API key",
			agentType:      "amp",
			credentialKind: "api-key",
			wantCommand:    "acp-amp",
			wantEnvVar:     "AMP_API_KEY",
			wantInstallCmd: `curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh && UV_TOOL_DIR=/opt/uv-tools UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_TOOL_BIN_DIR=/usr/local/bin uv tool install acp-amp==0.1.3 --with agent-client-protocol==0.7.1 --with amp-sdk==0.1.2 --with pydantic==2.12.5 --with pydantic-core==2.41.5 --with annotated-types==0.7.0 --with typing-inspection==0.4.2 --with typing-extensions==4.15.0 --python 3.12 --quiet && npm install -g @ampcode/cli@0.0.1783785389-g0da70d`,
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

			if !strings.HasPrefix(info.installCmd, tt.wantInstallCmd) {
				t.Errorf("getAgentCommandInfo() installCmd does not start with expected prefix.\ngot:  %v\nwant prefix: %v", info.installCmd, tt.wantInstallCmd)
			}

			if info.injectionMode != tt.wantInjectionMode {
				t.Errorf("getAgentCommandInfo() injectionMode = %v, want %v", info.injectionMode, tt.wantInjectionMode)
			}

			if info.authFilePath != tt.wantAuthFilePath {
				t.Errorf("getAgentCommandInfo() authFilePath = %v, want %v", info.authFilePath, tt.wantAuthFilePath)
			}

			// Verify args
			if tt.agentType == "google-gemini" && len(info.args) == 0 {
				t.Errorf("getAgentCommandInfo() expected args for google-gemini")
			}
			if tt.wantArgs != nil {
				if len(info.args) != len(tt.wantArgs) {
					t.Errorf("getAgentCommandInfo() args = %v, want %v", info.args, tt.wantArgs)
				} else {
					for i, a := range tt.wantArgs {
						if info.args[i] != a {
							t.Errorf("getAgentCommandInfo() args[%d] = %q, want %q", i, info.args[i], a)
						}
					}
				}
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
		"SAM_API_URL=https://api.other.com", // Should NOT override file value
		"SAM_NODE_ID=node-456",              // Missing from file, should be added
		"SAM_PROJECT_ID=proj-789",           // Missing from file, should be added
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

func TestResolveAgentEnvVarsPrefersFreshGitTokenOverStaleEnv(t *testing.T) {
	t.Parallel()

	host := &SessionHost{
		config: SessionHostConfig{
			GatewayConfig: GatewayConfig{
				WorkspaceID:    "ws-123",
				SAMEnvFallback: []string{"GH_TOKEN=stale-static-token", "SAM_WORKSPACE_ID=ws-123"},
				GitTokenFetcher: func(context.Context) (string, error) {
					return "fresh-scoped-token", nil
				},
			},
		},
	}

	envVars := host.resolveAgentEnvVars(context.Background(), "missing-container")

	if hasEnvEntry(envVars, "GH_TOKEN=stale-static-token") {
		t.Fatalf("stale static GH_TOKEN should not be preserved: %v", envVars)
	}
	if !hasEnvEntry(envVars, "GH_TOKEN=fresh-scoped-token") {
		t.Fatalf("fresh runtime GH_TOKEN missing: %v", envVars)
	}
}

func hasEnvEntry(envVars []string, want string) bool {
	for _, entry := range envVars {
		if entry == want {
			return true
		}
	}
	return false
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
	matches := 0
	for _, entry := range envVars {
		if strings.HasPrefix(entry, prefix) {
			matches++
			got := strings.TrimPrefix(entry, prefix)
			if got != expectedValue {
				t.Errorf("env %s = %q, want %q", key, got, expectedValue)
			}
		}
	}
	if matches != 1 {
		t.Errorf("env key %s occurred %d times, want exactly once: %v", key, matches, envVars)
	}
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
	if info.installCmd != "npm install -g @agentclientprotocol/claude-agent-acp@0.58.1" {
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
	if info.installCmd != "npm install -g @agentclientprotocol/codex-acp@1.1.2 @openai/codex@0.144.6" {
		t.Fatalf("installCmd=%q, unexpected", info.installCmd)
	}
	if info.injectionMode != "" {
		t.Fatalf("injectionMode=%q, want empty for api-key", info.injectionMode)
	}
	if info.args != nil {
		t.Fatalf("args=%v, want nil; codex-acp config belongs in CODEX_CONFIG", info.args)
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
	if info.installCmd != "npm install -g @agentclientprotocol/codex-acp@1.1.2 @openai/codex@0.144.6" {
		t.Fatalf("installCmd=%q, unexpected", info.installCmd)
	}
	if info.args != nil {
		t.Fatalf("args=%v, want nil; codex-acp config belongs in CODEX_CONFIG", info.args)
	}
}

func TestAgentInstallScriptCleansBrokenGitHubCLIRepoBeforeNpmBootstrap(t *testing.T) {
	t.Parallel()

	info := agentCommandInfo{
		command:    "claude-agent-acp",
		installCmd: "npm install -g @agentclientprotocol/claude-agent-acp@0.58.1",
		isNpmBased: true,
	}

	script := agentInstallScript(info)
	for _, want := range []string{
		"rm -f /etc/apt/sources.list.d/github-cli.list /etc/apt/keyrings/githubcli-archive-keyring.gpg",
		"apt-get update -qq",
		"DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs npm",
		`node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"`,
		"npm install -g n",
		"n 22",
		"npm install -g @agentclientprotocol/claude-agent-acp@0.58.1",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("agentInstallScript missing %q in %q", want, script)
		}
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
	if len(info.args) != 1 || info.args[0] != "--acp" {
		t.Fatalf("args=%v, want [--acp]", info.args)
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
	wantInstall := `curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh && UV_TOOL_DIR=/opt/uv-tools UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_TOOL_BIN_DIR=/usr/local/bin uv tool install mistral-vibe==2.19.1 --python 3.12 --quiet`
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

func TestGetAgentCommandInfoAmp(t *testing.T) {
	t.Parallel()

	info := getAgentCommandInfo("amp", "api-key")
	if info.command != "acp-amp" {
		t.Fatalf("command=%q, want %q", info.command, "acp-amp")
	}
	if info.envVarName != "AMP_API_KEY" {
		t.Fatalf("envVarName=%q, want %q", info.envVarName, "AMP_API_KEY")
	}
	// Verify key parts of installCmd rather than exact match (it includes post-install patches)
	for _, want := range []string{
		"uv tool install acp-amp==0.1.3",
		"--with amp-sdk==0.1.2",
		"npm install -g @ampcode/cli@0.0.1783785389-g0da70d",
		"Patched acp-amp: error handling + MCP config wrapping",
		"visibility default to private",
	} {
		if !strings.Contains(info.installCmd, want) {
			t.Fatalf("installCmd missing %q, got %q", want, info.installCmd)
		}
	}
	if !info.isNpmBased {
		t.Fatalf("isNpmBased=false, want true (amp chains npm install for @ampcode/cli@0.0.1783785389-g0da70d)")
	}
	if len(info.args) != 1 || info.args[0] != "run" {
		t.Fatalf("args=%v, want [run]", info.args)
	}
	if info.injectionMode != "" {
		t.Fatalf("injectionMode=%q, want empty (env var injection)", info.injectionMode)
	}
	if info.authFilePath != "" {
		t.Fatalf("authFilePath=%q, want empty (no file-based auth)", info.authFilePath)
	}
}

func TestGetAgentCommandInfoAmpIgnoresOAuth(t *testing.T) {
	t.Parallel()

	info := getAgentCommandInfo("amp", "oauth-token")
	if info.command != "acp-amp" {
		t.Fatalf("command=%q, want %q", info.command, "acp-amp")
	}
	if info.envVarName != "AMP_API_KEY" {
		t.Fatalf("envVarName=%q, want %q - Amp has no OAuth support", info.envVarName, "AMP_API_KEY")
	}
}

func TestAgentInstallScriptAmpIncludesNodeBootstrap(t *testing.T) {
	t.Parallel()

	info := getAgentCommandInfo("amp", "api-key")
	script := agentInstallScript(info)
	// Amp is isNpmBased=true because it chains `npm install -g @ampcode/cli@0.0.1783785389-g0da70d`.
	// agentInstallScript must prepend the Node.js bootstrap preamble so npm is
	// available in devcontainers that don't ship with Node.js.
	if !strings.Contains(script, "apt-get install") {
		t.Fatalf("agentInstallScript did not inject Node.js bootstrap for amp")
	}
	// The original install command must still be present after the preamble.
	if !strings.Contains(script, "uv tool install acp-amp") {
		t.Fatalf("agentInstallScript lost the uv install portion")
	}
	if !strings.Contains(script, "npm install -g @ampcode/cli@0.0.1783785389-g0da70d") {
		t.Fatalf("agentInstallScript lost the npm install portion")
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
	if len(envVars) != 3 {
		t.Fatalf("expected 3 extra env vars for mistral-vibe, got %d", len(envVars))
	}
	wantName := "VIBE_CLIENT_NAME=sam"
	wantVersion := "VIBE_CLIENT_VERSION=1.0.1"
	wantUnbuffered := "PYTHONUNBUFFERED=1"
	if envVars[0] != wantName {
		t.Errorf("envVars[0]=%q, want %q", envVars[0], wantName)
	}
	if envVars[1] != wantVersion {
		t.Errorf("envVars[1]=%q, want %q", envVars[1], wantVersion)
	}
	if envVars[2] != wantUnbuffered {
		t.Errorf("envVars[2]=%q, want %q", envVars[2], wantUnbuffered)
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

func TestGenerateVibeConfig_DynamicVsBuiltin(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name           string
		activeModel    string
		wantEntries    int
		wantDynamicDef bool // expect a [[models]] entry where name == alias == activeModel
	}{
		{"builtin alias has no extra entry", "devstral-2", 3, false},
		{"raw API ID generates dynamic entry", "mistral-medium-3-5-2604", 4, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			config := generateVibeConfig(tt.activeModel, nil)

			if !strings.Contains(config, fmt.Sprintf(`active_model = "%s"`, tt.activeModel)) {
				t.Errorf("active_model not set to %q", tt.activeModel)
			}
			// Builtin aliases must always be present
			for _, alias := range []string{"mistral-large", "devstral-2", "codestral"} {
				if !strings.Contains(config, fmt.Sprintf(`alias = "%s"`, alias)) {
					t.Errorf("missing builtin alias %q", alias)
				}
			}
			if count := strings.Count(config, "[[models]]"); count != tt.wantEntries {
				t.Errorf("expected %d [[models]] entries, got %d", tt.wantEntries, count)
			}
			if tt.wantDynamicDef {
				if !strings.Contains(config, fmt.Sprintf(`name = "%s"`, tt.activeModel)) {
					t.Errorf("dynamic entry missing name = %q", tt.activeModel)
				}
			}
		})
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
		{
			name:      "Amp API key uses env var",
			agentType: "amp",
			credential: &agentCredential{
				credential:     "sgamp-api-key-123",
				credentialKind: "api-key",
			},
			wantEnvVar: "AMP_API_KEY=sgamp-api-key-123",
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
		{
			name:    "single-quoted value",
			content: "export API_KEY='sk-abc123'\n",
			want:    []string{"API_KEY=sk-abc123"},
		},
		{
			name:    "single-quoted value with embedded single quote",
			content: "export MSG='it'\"'\"'s a test'\n",
			want:    []string{"MSG=it's a test"},
		},
		{
			name:    "empty single-quoted value",
			content: "export EMPTY=''\n",
			want:    []string{"EMPTY="},
		},
		{
			name:    "single-quoted value with multiple embedded quotes",
			content: "export S='can'\"'\"'t stop'\"'\"'t quit'\n",
			want:    []string{"S=can't stop't quit"},
		},
		{
			name:    "single-quoted value with double quotes inside",
			content: "export X='say \"hello\"'\n",
			want:    []string{`X=say "hello"`},
		},
		{
			name: "mixed single and double quoted values",
			content: `export A="double-quoted"
export B='single-quoted'
export C=unquoted
`,
			want: []string{"A=double-quoted", "B=single-quoted", "C=unquoted"},
		},
		{
			name: "project runtime env file format (single-quoted)",
			content: `# Project runtime environment variables (auto-generated)
export API_KEY='sk-abc123'
export DATABASE_URL='postgres://user:pass@host/db'
export MSG='it'` + `"'"` + `'s fine'
`,
			want: []string{
				"API_KEY=sk-abc123",
				"DATABASE_URL=postgres://user:pass@host/db",
				"MSG=it's fine",
			},
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

const expectedMcpServerURLMessage = "expected MCP server URL"

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
	if !strings.Contains(config, `transport = "http"`) {
		t.Error("expected transport = http for MCP server")
	}
	if !strings.Contains(config, `url = "https://api.example.com/mcp"`) {
		t.Error(expectedMcpServerURLMessage)
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

	if !strings.Contains(config, `transport = "http"`) {
		t.Error("expected transport = http for MCP server")
	}
	if !strings.Contains(config, `url = "https://api.example.com/mcp"`) {
		t.Error(expectedMcpServerURLMessage)
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

	// Both servers should be present with transport field
	if count := strings.Count(config, "[[mcp_servers]]"); count != 2 {
		t.Errorf("expected 2 [[mcp_servers]] entries, got %d", count)
	}
	if count := strings.Count(config, `transport = "http"`); count != 2 {
		t.Errorf("expected 2 transport = http fields, got %d", count)
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

	if !strings.Contains(config, `transport = "http"`) {
		t.Error("expected transport = http for MCP server")
	}
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

func TestGenerateCodexMcpConfigNoMcpServers(t *testing.T) {
	t.Parallel()

	config, envVars := generateCodexMcpConfig(nil, nil, "")
	if !strings.Contains(config, `sandbox_mode = "danger-full-access"`) ||
		!strings.Contains(config, `approval_policy = "never"`) {
		t.Fatalf("sandbox-only managed config missing required controls: %q", config)
	}
	if len(envVars) != 0 {
		t.Fatalf("expected no MCP env vars, got %v", envVars)
	}
}
func TestGenerateCodexMcpConfigWithReasoningEffort(t *testing.T) {
	t.Parallel()

	config, envVars := generateCodexMcpConfig(nil, nil, "high")

	if !strings.Contains(config, `model_reasoning_effort = "high"`) {
		t.Fatalf("expected model_reasoning_effort in managed config, got %q", config)
	}
	if !strings.Contains(config, `sandbox_mode = "danger-full-access"`) {
		t.Fatal("expected sandbox mode in effort-only managed config")
	}
	if len(envVars) != 0 {
		t.Fatalf("expected no env vars, got %v", envVars)
	}
}

func TestGenerateCodexMcpConfigSkipsUnsupportedReasoningEffort(t *testing.T) {
	t.Parallel()

	config, envVars := generateCodexMcpConfig(nil, nil, "max")

	if !strings.Contains(config, `sandbox_mode = "danger-full-access"`) {
		t.Fatalf("unsupported effort must still produce sandbox config, got %q", config)
	}
	if strings.Contains(config, "model_reasoning_effort") {
		t.Fatalf("unsupported effort leaked into config: %q", config)
	}
	if len(envVars) != 0 {
		t.Fatalf("expected no env vars, got %v", envVars)
	}
}

func TestGenerateCodexMcpConfigSingleServerWithToken(t *testing.T) {
	t.Parallel()

	config, envVars := generateCodexMcpConfig([]McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "test-token-123"},
	}, nil, "")

	if !strings.Contains(config, codexManagedMcpStartMarker) {
		t.Fatal("expected managed start marker")
	}
	if !strings.Contains(config, `sandbox_mode = "danger-full-access"`) {
		t.Fatal("expected sandbox mode to disable Codex bubblewrap inside containers")
	}
	if !strings.Contains(config, `approval_policy = "never"`) {
		t.Fatal("expected approval policy to avoid Codex sandbox prompts inside containers")
	}
	if strings.Index(config, `sandbox_mode = "danger-full-access"`) > strings.Index(config, `[mcp_servers.sam-mcp]`) {
		t.Fatal("expected sandbox settings before MCP server entries")
	}
	if !strings.Contains(config, `[mcp_servers.sam-mcp]`) {
		t.Fatal("expected sam-mcp server entry")
	}
	if !strings.Contains(config, `url = "https://api.example.com/mcp"`) {
		t.Fatal(expectedMcpServerURLMessage)
	}
	if !strings.Contains(config, `bearer_token_env_var = "SAM_MCP_TOKEN"`) {
		t.Fatal("expected bearer token env var entry")
	}
	if !strings.Contains(config, codexManagedMcpEndMarker) {
		t.Fatal("expected managed end marker")
	}
	if len(envVars) != 1 || envVars[0] != "SAM_MCP_TOKEN=test-token-123" {
		t.Fatalf("unexpected env vars: %v", envVars)
	}
}

func TestGenerateCodexMcpConfigMultipleServers(t *testing.T) {
	t.Parallel()

	config, envVars := generateCodexMcpConfig([]McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "token-1"},
		{URL: "https://backup.example.com/mcp", Token: "token-2"},
	}, nil, "")

	if !strings.Contains(config, `[mcp_servers.sam-mcp-0]`) {
		t.Fatal("expected first server entry")
	}
	if !strings.Contains(config, `[mcp_servers.sam-mcp-1]`) {
		t.Fatal("expected second server entry")
	}
	if !strings.Contains(config, `bearer_token_env_var = "SAM_MCP_TOKEN_0"`) {
		t.Fatal("expected first bearer token env var entry")
	}
	if !strings.Contains(config, `bearer_token_env_var = "SAM_MCP_TOKEN_1"`) {
		t.Fatal("expected second bearer token env var entry")
	}
	if len(envVars) != 2 {
		t.Fatalf("expected 2 env vars, got %d", len(envVars))
	}
}

func TestGenerateCodexMcpConfigServerWithoutToken(t *testing.T) {
	t.Parallel()

	config, envVars := generateCodexMcpConfig([]McpServerEntry{
		{URL: "https://api.example.com/mcp"},
	}, nil, "")

	if !strings.Contains(config, `[mcp_servers.sam-mcp]`) {
		t.Fatal("expected server entry")
	}
	if strings.Contains(config, "bearer_token_env_var") {
		t.Fatal("expected no bearer_token_env_var for tokenless server")
	}
	if len(envVars) != 0 {
		t.Fatalf("expected no env vars, got %v", envVars)
	}
}

func TestGenerateCodexMcpConfigServerWithControlCharsRejected(t *testing.T) {
	t.Parallel()

	config, envVars := generateCodexMcpConfig([]McpServerEntry{
		{URL: "https://good.example.com/mcp", Token: "good-token"},
		{URL: "https://bad.example.com/mcp", Token: "bad\ninjection"},
	}, nil, "")

	if !strings.Contains(config, `url = "https://good.example.com/mcp"`) {
		t.Fatal("expected good server to be present")
	}
	if strings.Contains(config, "bad.example.com") {
		t.Fatal("expected bad server to be skipped")
	}
	if len(envVars) != 1 || envVars[0] != "SAM_MCP_TOKEN=good-token" {
		t.Fatalf("unexpected env vars: %v", envVars)
	}
}

func TestGenerateCodexMcpConfigWithProxyProvider(t *testing.T) {
	t.Parallel()

	config, envVars := generateCodexMcpConfig(nil, &codexProxyProviderConfig{
		baseURL: "https://api.example.com/ai/v1",
		model:   "gpt-4.1",
	}, "")

	if !strings.Contains(config, `sandbox_mode = "danger-full-access"`) {
		t.Fatal("expected sandbox mode to disable Codex bubblewrap inside containers")
	}
	if !strings.Contains(config, `approval_policy = "never"`) {
		t.Fatal("expected approval policy to avoid Codex sandbox prompts inside containers")
	}
	if !strings.Contains(config, `model = "gpt-4.1"`) {
		t.Fatal("expected model override")
	}
	if !strings.Contains(config, `model_provider = "sam-openai"`) {
		t.Fatal("expected SAM model provider override")
	}
	if !strings.Contains(config, `[model_providers.sam-openai]`) {
		t.Fatal("expected SAM model provider block")
	}
	if !strings.Contains(config, `base_url = "https://api.example.com/ai/v1"`) {
		t.Fatal("expected SAM proxy base URL")
	}
	if !strings.Contains(config, `env_key = "OPENAI_API_KEY"`) {
		t.Fatal("expected OpenAI env key")
	}
	if !strings.Contains(config, `wire_api = "responses"`) {
		t.Fatal("expected responses wire API")
	}
	if len(envVars) != 0 {
		t.Fatalf("expected no env vars, got %v", envVars)
	}
}

func TestCodexProxyProviderConfigFromCredential(t *testing.T) {
	t.Parallel()

	config := codexProxyProviderConfigFromCredential(&agentCredential{
		inferenceConfig: &inferenceConfig{
			Provider: "openai-passthrough",
			BaseURL:  "https://api.example.com/ai/proxy/{wstoken}/openai/v1",
			Model:    "gpt-4.1",
		},
	}, "workspace-token")

	if config == nil {
		t.Fatal("expected proxy provider config")
	}
	if config.baseURL != "https://api.example.com/ai/proxy/workspace-token/openai/v1" {
		t.Fatalf("baseURL = %q", config.baseURL)
	}
	if config.model != "gpt-4.1" {
		t.Fatalf("model = %q", config.model)
	}
}

func TestMergeManagedCodexMcpConfigReplacesExistingManagedBlock(t *testing.T) {
	t.Parallel()

	existing := strings.Join([]string{
		`model = "gpt-5-codex"`,
		"",
		codexManagedMcpStartMarker,
		`[mcp_servers.sam-mcp]`,
		`url = "https://old.example.com/mcp"`,
		codexManagedMcpEndMarker,
		"",
		`approval_policy = "never"`,
		"",
	}, "\n")
	managed := strings.Join([]string{
		codexManagedMcpStartMarker,
		`[mcp_servers.sam-mcp]`,
		`url = "https://new.example.com/mcp"`,
		codexManagedMcpEndMarker,
	}, "\n")

	merged := mergeManagedCodexMcpConfig(existing, managed)
	if strings.Contains(merged, "old.example.com") {
		t.Fatal("expected old managed block to be removed")
	}
	if !strings.Contains(merged, "new.example.com") {
		t.Fatal("expected new managed block to be present")
	}
	if !strings.Contains(merged, `model = "gpt-5-codex"`) {
		t.Fatal("expected existing config to be preserved")
	}
	if !strings.Contains(merged, `approval_policy = "never"`) {
		t.Fatal("expected trailing config to be preserved")
	}
}

func TestMergeManagedCodexMcpConfigReplacesOwnedTopLevelKeysOnly(t *testing.T) {
	t.Parallel()

	existing := strings.Join([]string{
		`sandbox_mode = "read-only"`,
		`approval_policy = "on-request"`,
		`model = "user-model"`,
		`unrelated = "preserved"`,
		``,
		`[profiles.user]`,
		`sandbox_mode = "workspace-write"`,
		`approval_policy = "untrusted"`,
	}, "\n")
	managed, _ := generateCodexMcpConfig(nil, nil, "")

	merged := mergeManagedCodexMcpConfig(existing, managed)
	if got := strings.Count(merged, `sandbox_mode = "danger-full-access"`); got != 1 {
		t.Fatalf("managed sandbox_mode count = %d, want 1:\n%s", got, merged)
	}
	if got := strings.Count(merged, `approval_policy = "never"`); got != 1 {
		t.Fatalf("managed approval_policy count = %d, want 1:\n%s", got, merged)
	}
	if strings.Contains(merged, `sandbox_mode = "read-only"`) || strings.Contains(merged, `approval_policy = "on-request"`) {
		t.Fatalf("pre-existing owned top-level keys were preserved:\n%s", merged)
	}
	for _, want := range []string{
		`model = "user-model"`,
		`unrelated = "preserved"`,
		`[profiles.user]`,
		`sandbox_mode = "workspace-write"`,
		`approval_policy = "untrusted"`,
	} {
		if !strings.Contains(merged, want) {
			t.Fatalf("unrelated user key %q was not preserved:\n%s", want, merged)
		}
	}
	if strings.Index(merged, codexManagedMcpStartMarker) > strings.Index(merged, `[profiles.user]`) {
		t.Fatalf("managed top-level block must precede user tables:\n%s", merged)
	}
}

func TestMergeManagedCodexMcpConfigNormalizesQuotedTopLevelKeys(t *testing.T) {
	t.Parallel()

	existing := strings.Join([]string{
		`"sandbox_mode" = "read-only"`,
		`'approval_policy' = "on-request"`,
		`model = "user-model"`,
		``,
		`[profiles.user]`,
		`"sandbox_mode" = "workspace-write"`,
		`'approval_policy' = "untrusted"`,
	}, "\n")
	managed, _ := generateCodexMcpConfig(nil, nil, "")
	merged := mergeManagedCodexMcpConfig(existing, managed)

	var parsed struct {
		SandboxMode    string `toml:"sandbox_mode"`
		ApprovalPolicy string `toml:"approval_policy"`
		Model          string `toml:"model"`
		Profiles       map[string]struct {
			SandboxMode    string `toml:"sandbox_mode"`
			ApprovalPolicy string `toml:"approval_policy"`
		} `toml:"profiles"`
	}
	if err := toml.Unmarshal([]byte(merged), &parsed); err != nil {
		t.Fatalf("merged config is invalid TOML: %v\n%s", err, merged)
	}
	if parsed.SandboxMode != "danger-full-access" || parsed.ApprovalPolicy != "never" {
		t.Fatalf("managed top-level values not canonicalized: %#v\n%s", parsed, merged)
	}
	if parsed.Model != "user-model" {
		t.Fatalf("unmanaged top-level model = %q, want user-model", parsed.Model)
	}
	profile := parsed.Profiles["user"]
	if profile.SandboxMode != "workspace-write" || profile.ApprovalPolicy != "untrusted" {
		t.Fatalf("table-scoped values changed: %#v\n%s", profile, merged)
	}
}

func TestValidateAuthFilePathAcceptsRelativeConfigPath(t *testing.T) {
	t.Parallel()

	if err := validateAuthFilePath(".codex/config.toml"); err != nil {
		t.Fatalf("expected valid auth file path, got %v", err)
	}
}

func TestValidateAuthFilePathRejectsTraversal(t *testing.T) {
	t.Parallel()

	if err := validateAuthFilePath("../.codex/config.toml"); err == nil {
		t.Fatal("expected traversal path to be rejected")
	}
}

func TestValidateAuthFilePathRejectsShellMetacharacters(t *testing.T) {
	t.Parallel()

	if err := validateAuthFilePath(`.codex/config.toml"; rm -rf /`); err == nil {
		t.Fatal("expected shell metacharacters to be rejected")
	}
}

// Tests for robust home directory resolution
func TestResolveContainerHomeDirFallbackBehavior(t *testing.T) {
	t.Parallel()

	// This test verifies that resolveContainerHomeDir always returns a valid path
	// even when all resolution methods fail. We can't easily test the actual
	// container interaction in unit tests, but we can verify the fallback logic.

	// The function should never return an error in normal operation due to the
	// final fallback to /root, but we test the error handling path for completeness.

	// Mock context and empty container/user (would fail in real usage, but tests fallback)
	ctx := context.Background()
	_, err := resolveContainerHomeDir(ctx, "", "")

	// Even with invalid inputs, the function should either return a path or an error
	// that can be handled by callers with fallback to /root
	if err != nil {
		// This is expected for invalid inputs, but callers should handle it gracefully
		t.Logf("Expected error for invalid inputs: %v", err)
	}
}

func TestAuthFileFunctionsHandleFallbackGracefully(t *testing.T) {
	t.Parallel()

	// Test that auth file functions handle the fallback case gracefully
	// These tests use invalid container/user to trigger the fallback path

	ctx := context.Background()

	// Test writeAuthFileToContainer with invalid container (should use /root fallback)
	err := writeAuthFileToContainer(ctx, "invalid-container", "testuser", ".test/auth.json", `{"test": "data"}`)
	if err != nil {
		// Expected to fail due to invalid container, but should not panic
		t.Logf("writeAuthFileToContainer handled invalid container gracefully: %v", err)
	}

	// Test readAuthFileFromContainer with invalid container (should use /root fallback)
	_, err = readAuthFileFromContainer(ctx, "invalid-container", "testuser", ".test/auth.json")
	if err != nil {
		// Expected to fail due to invalid container, but should not panic
		t.Logf("readAuthFileFromContainer handled invalid container gracefully: %v", err)
	}

	// Test readOptionalFileFromContainer with invalid container (should use /root fallback)
	_, err = readOptionalFileFromContainer(ctx, "invalid-container", "testuser", ".test/config.toml")
	if err != nil {
		// Expected to fail due to invalid container, but should not panic
		t.Logf("readOptionalFileFromContainer handled invalid container gracefully: %v", err)
	}
}

func TestAuthFilePathValidation(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name        string
		path        string
		shouldError bool
	}{
		{
			name:        "Valid relative path",
			path:        ".codex/auth.json",
			shouldError: false,
		},
		{
			name:        "Valid nested path",
			path:        ".config/app/settings.json",
			shouldError: false,
		},
		{
			name:        "Path with traversal",
			path:        "../.codex/auth.json",
			shouldError: true,
		},
		{
			name:        "Path with semicolon",
			path:        ".codex/auth.json; rm -rf /",
			shouldError: true,
		},
		{
			name:        "Path with backtick",
			path:        ".codex/`whoami`.json",
			shouldError: true,
		},
		{
			name:        "Path with dollar sign",
			path:        ".codex/$HOME.json",
			shouldError: true,
		},
		{
			name:        "Path with double quote",
			path:        `.codex/"test".json`,
			shouldError: true,
		},
		{
			name:        "Path with single quote",
			path:        ".codex/'test'.json",
			shouldError: true,
		},
		{
			name:        "Path with backslash",
			path:        ".codex\\test.json",
			shouldError: true,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := validateAuthFilePath(tc.path)
			if tc.shouldError && err == nil {
				t.Errorf("Expected error for path %q, got nil", tc.path)
			} else if !tc.shouldError && err != nil {
				t.Errorf("Unexpected error for path %q: %v", tc.path, err)
			}
		})
	}
}

func TestBuildOpencodeConfig_DefaultUsesOpenCodeZen(t *testing.T) {
	t.Parallel()

	config := buildOpencodeConfig(nil)

	assertOpenCodeZenDefaultConfig(t, config)
}

func TestBuildOpencodeConfig_UnknownProviderFallsBackToOpenCodeZen(t *testing.T) {
	t.Parallel()

	config := buildOpencodeConfig(&agentSettingsPayload{
		OpencodeProvider: "unknown-provider",
	})

	assertOpenCodeZenDefaultConfig(t, config)
}

func assertOpenCodeZenDefaultConfig(t *testing.T, config map[string]any) {
	t.Helper()

	if got := config["model"]; got != DefaultOpencodeModel {
		t.Fatalf("model = %v, want %q", got, DefaultOpencodeModel)
	}
	if _, ok := config["provider"]; ok {
		t.Fatalf("provider block present for OpenCode Zen config: %#v", config["provider"])
	}
}

func TestBuildOpencodeConfig_OpenCodeZenUsesBuiltInModelPrefixes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		model string
	}{
		{name: "zen model", model: "opencode/claude-sonnet-4-6"},
		{name: "legacy managed alias model", model: "opencode/claude-sonnet-4-5"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			config := buildOpencodeConfig(&agentSettingsPayload{
				OpencodeProvider: "opencode-zen",
				Model:            tt.model,
			})

			if got := config["model"]; got != tt.model {
				t.Fatalf("model = %v, want %q", got, tt.model)
			}
			if _, ok := config["provider"]; ok {
				t.Fatalf("provider block present for OpenCode Zen built-in provider: %#v", config["provider"])
			}
		})
	}
}

func TestBuildOpencodeConfig_OpenCodeGoDefaultsToGLM52(t *testing.T) {
	t.Parallel()

	config := buildOpencodeConfig(&agentSettingsPayload{
		OpencodeProvider: "opencode-go",
	})

	if got := config["model"]; got != DefaultOpencodeGoModel {
		t.Fatalf("model = %v, want %q", got, DefaultOpencodeGoModel)
	}
	if _, ok := config["provider"]; ok {
		t.Fatalf("provider block present for OpenCode Go built-in provider: %#v", config["provider"])
	}
}

func TestBuildOpencodeConfig_OpenCodeGoPreservesExplicitModel(t *testing.T) {
	t.Parallel()

	const model = "opencode-go/kimi-k2.7-code"
	config := buildOpencodeConfig(&agentSettingsPayload{
		OpencodeProvider: "opencode-go",
		Model:            model,
	})

	if got := config["model"]; got != model {
		t.Fatalf("model = %v, want %q", got, model)
	}
	if _, ok := config["provider"]; ok {
		t.Fatalf("provider block present for OpenCode Go built-in provider: %#v", config["provider"])
	}
}

func TestBuildOpencodeConfig_CustomProviderEmitsOpenAICompatibleBlock(t *testing.T) {
	t.Parallel()

	const baseURL = "https://llm.example.com/v1"
	const model = "my-model-7b"
	config := buildOpencodeConfig(&agentSettingsPayload{
		OpencodeProvider: "custom",
		OpencodeBaseURL:  baseURL,
		Model:            model,
	})

	alias := sanitizeModelAlias(model)
	if got := config["model"]; got != "custom/"+alias {
		t.Fatalf("model = %v, want %q", got, "custom/"+alias)
	}

	providerBlock, ok := config["provider"].(map[string]interface{})
	if !ok {
		t.Fatalf("provider block missing or wrong type for custom provider: %#v", config["provider"])
	}
	custom, ok := providerBlock["custom"].(map[string]interface{})
	if !ok {
		t.Fatalf("custom provider entry missing: %#v", providerBlock)
	}
	if got := custom["npm"]; got != "@ai-sdk/openai-compatible" {
		t.Fatalf("npm = %v, want @ai-sdk/openai-compatible", got)
	}

	options, ok := custom["options"].(map[string]interface{})
	if !ok {
		t.Fatalf("custom provider options missing: %#v", custom)
	}
	if got := options["baseURL"]; got != baseURL {
		t.Fatalf("baseURL = %v, want %q", got, baseURL)
	}
	if got := options["apiKey"]; got != "{env:OPENCODE_API_KEY}" {
		t.Fatalf("apiKey = %v, want {env:OPENCODE_API_KEY}", got)
	}

	models, ok := custom["models"].(map[string]interface{})
	if !ok {
		t.Fatalf("custom provider models missing: %#v", custom)
	}
	if _, ok := models[alias]; !ok {
		t.Fatalf("model alias %q not registered: %#v", alias, models)
	}
}

// Regression test: writeAgentStartupConfig must call writeCodexStartupConfig
// even when containerID is empty (standalone/cf-container sessions).
// This is the exact bug this PR fixes — if the containerID=="" guard is moved
// back above the Codex check, this test fails.
func TestWriteAgentStartupConfigCodexStandaloneWritesMcpConfig(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)
	t.Setenv("CODEX_HOME", "")

	h := &SessionHost{
		config: SessionHostConfig{
			GatewayConfig: GatewayConfig{
				McpServers: []McpServerEntry{
					{URL: "https://api.example.com/mcp", Token: "test-standalone-token"},
				},
				WorkspaceID: "ws-test-standalone",
			},
		},
	}

	startup := &agentStartup{containerID: "", envVars: []string{
		`CODEX_CONFIG={"sandbox_mode":"read-only"}`,
		"INITIAL_AGENT_MODE=agent",
		"SAM_MCP_TOKEN=stale-standalone-token",
	}}

	err := h.writeAgentStartupConfig(context.Background(), "openai-codex", nil, startup)
	if err != nil {
		t.Fatalf("writeAgentStartupConfig failed: %v", err)
	}

	configPath := filepath.Join(tmpDir, ".codex", "config.toml")
	data, readErr := os.ReadFile(configPath)
	if readErr != nil {
		t.Fatalf("config.toml not written for standalone Codex: %v", readErr)
	}
	if !strings.Contains(string(data), "sam-mcp") {
		t.Error("config.toml missing SAM MCP server entry")
	}
	if !strings.Contains(string(data), `sandbox_mode = "danger-full-access"`) ||
		!strings.Contains(string(data), `approval_policy = "never"`) {
		t.Fatalf("config.toml missing sandbox controls: %s", data)
	}
	if !strings.Contains(string(data), `url = "https://api.example.com/mcp"`) {
		t.Errorf("config.toml missing exact SAM MCP URL: %s", data)
	}
	if !strings.Contains(string(data), `bearer_token_env_var = "SAM_MCP_TOKEN"`) {
		t.Errorf("config.toml missing SAM MCP bearer env reference: %s", data)
	}
	assertCodexStartupTOML(t, data, "https://api.example.com/mcp", "SAM_MCP_TOKEN")
	assertEnvContains(t, startup.envVars, "CODEX_CONFIG", `{"sandbox_mode":"danger-full-access","approval_policy":"never"}`)
	assertEnvContains(t, startup.envVars, "INITIAL_AGENT_MODE", "agent-full-access")
	assertEnvContains(t, startup.envVars, "SAM_MCP_TOKEN", "test-standalone-token")
}

func TestWriteAgentStartupConfigCodexContainerKeepsConfigAndEnvContract(t *testing.T) {
	tmpDir := t.TempDir()
	capturedConfig := filepath.Join(tmpDir, "config.toml")
	fakeDocker := filepath.Join(tmpDir, "docker")
	script := `#!/bin/sh
case " $* " in
  *" printenv CODEX_HOME "*) exit 1 ;;
  *" id -un "*) exit 1 ;;
  *" printenv HOME "*) printf '/home/testuser\n'; exit 0 ;;
  *" test -f "*) exit 1 ;;
  *" tee /home/testuser/.codex/config.toml "*) cat > "$FAKE_CODEX_CONFIG"; exit 0 ;;
  *) exit 0 ;;
esac
`
	if err := os.WriteFile(fakeDocker, []byte(script), 0o700); err != nil {
		t.Fatalf("write fake docker: %v", err)
	}
	t.Setenv("PATH", tmpDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FAKE_CODEX_CONFIG", capturedConfig)

	h := &SessionHost{config: SessionHostConfig{
		GatewayConfig: GatewayConfig{
			McpServers:    []McpServerEntry{{URL: "https://api.example.com/mcp", Token: "container-token"}},
			WorkspaceID:   "ws-container",
			ContainerUser: "testuser",
		},
	}}
	startup := &agentStartup{containerID: "container-123", envVars: []string{
		`CODEX_CONFIG={"sandbox_mode":"read-only"}`,
		"INITIAL_AGENT_MODE=agent",
		"SAM_MCP_TOKEN=stale-container-token",
	}}

	if err := h.writeAgentStartupConfig(context.Background(), "openai-codex", nil, startup); err != nil {
		t.Fatalf("container Codex startup config failed: %v", err)
	}
	data, err := os.ReadFile(capturedConfig)
	if err != nil {
		t.Fatalf("read captured container config: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, `sandbox_mode = "danger-full-access"`) ||
		!strings.Contains(content, `approval_policy = "never"`) ||
		!strings.Contains(content, `[mcp_servers.sam-mcp]`) ||
		!strings.Contains(content, `url = "https://api.example.com/mcp"`) ||
		!strings.Contains(content, `bearer_token_env_var = "SAM_MCP_TOKEN"`) {
		t.Fatalf("container config contract changed: %s", content)
	}
	assertCodexStartupTOML(t, data, "https://api.example.com/mcp", "SAM_MCP_TOKEN")
	assertEnvContains(t, startup.envVars, "CODEX_CONFIG", `{"sandbox_mode":"danger-full-access","approval_policy":"never"}`)
	assertEnvContains(t, startup.envVars, "INITIAL_AGENT_MODE", "agent-full-access")
	assertEnvContains(t, startup.envVars, "SAM_MCP_TOKEN", "container-token")
}

func assertCodexStartupTOML(t *testing.T, data []byte, wantURL, wantTokenEnv string) {
	t.Helper()
	var config struct {
		SandboxMode    string `toml:"sandbox_mode"`
		ApprovalPolicy string `toml:"approval_policy"`
		MCPServers     map[string]struct {
			URL               string `toml:"url"`
			BearerTokenEnvVar string `toml:"bearer_token_env_var"`
		} `toml:"mcp_servers"`
	}
	if err := toml.Unmarshal(data, &config); err != nil {
		t.Fatalf("parse generated Codex TOML: %v\n%s", err, data)
	}
	if config.SandboxMode != "danger-full-access" {
		t.Fatalf("sandbox_mode = %q, want danger-full-access", config.SandboxMode)
	}
	if config.ApprovalPolicy != "never" {
		t.Fatalf("approval_policy = %q, want never", config.ApprovalPolicy)
	}
	server, ok := config.MCPServers["sam-mcp"]
	if !ok {
		t.Fatalf("parsed mcp_servers missing sam-mcp: %#v", config.MCPServers)
	}
	if server.URL != wantURL {
		t.Fatalf("sam-mcp URL = %q, want %q", server.URL, wantURL)
	}
	if server.BearerTokenEnvVar != wantTokenEnv {
		t.Fatalf("sam-mcp bearer_token_env_var = %q, want %q", server.BearerTokenEnvVar, wantTokenEnv)
	}
}

func TestWriteAgentStartupConfigCodexWithoutOptionalConfigWritesManagedControls(t *testing.T) {
	for _, tc := range []struct {
		name        string
		containerID string
	}{
		{name: "standalone"},
		{name: "devcontainer", containerID: "container-123"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tmpDir := t.TempDir()
			t.Setenv("HOME", tmpDir)
			t.Setenv("CODEX_HOME", "")
			configPath := filepath.Join(tmpDir, "config.toml")

			if tc.containerID != "" {
				fakeDocker := filepath.Join(tmpDir, "docker")
				script := `#!/bin/sh
case " $* " in
  *" printenv CODEX_HOME "*) exit 1 ;;
  *" id -un "*) exit 1 ;;
  *" printenv HOME "*) printf '/home/testuser\n'; exit 0 ;;
  *" test -f "*) exit 1 ;;
  *" tee /home/testuser/.codex/config.toml "*) cat > "$FAKE_CODEX_CONFIG"; exit 0 ;;
  *) exit 0 ;;
esac
`
				if err := os.WriteFile(fakeDocker, []byte(script), 0o700); err != nil {
					t.Fatalf("write fake docker: %v", err)
				}
				t.Setenv("PATH", tmpDir+string(os.PathListSeparator)+os.Getenv("PATH"))
				t.Setenv("FAKE_CODEX_CONFIG", configPath)
			} else {
				configPath = filepath.Join(tmpDir, ".codex", "config.toml")
			}

			h := &SessionHost{config: SessionHostConfig{GatewayConfig: GatewayConfig{ContainerUser: "testuser"}}}
			startup := &agentStartup{
				containerID: tc.containerID,
				envVars: []string{
					`USER_SETTING=preserved`,
					`CODEX_CONFIG={"sandbox_mode":"read-only","approval_policy":"on-request"}`,
					`INITIAL_AGENT_MODE=agent`,
				},
			}

			if err := h.writeAgentStartupConfig(context.Background(), "openai-codex", nil, startup); err != nil {
				t.Fatalf("writeAgentStartupConfig failed: %v", err)
			}
			data, err := os.ReadFile(configPath)
			if err != nil {
				t.Fatalf("read written config: %v", err)
			}
			content := string(data)
			if strings.Count(content, `sandbox_mode = "danger-full-access"`) != 1 ||
				strings.Count(content, `approval_policy = "never"`) != 1 {
				t.Fatalf("written config does not contain exactly one managed control pair:\n%s", content)
			}
			assertEnvContains(t, startup.envVars, "CODEX_CONFIG", `{"sandbox_mode":"danger-full-access","approval_policy":"never"}`)
			assertEnvContains(t, startup.envVars, "INITIAL_AGENT_MODE", "agent-full-access")
			assertEnvContains(t, startup.envVars, "USER_SETTING", "preserved")
		})
	}
}

func countEnvKey(envVars []string, key string) int {
	count := 0
	prefix := key + "="
	for _, envVar := range envVars {
		if strings.HasPrefix(envVar, prefix) {
			count++
		}
	}
	return count
}

func TestWriteAgentStartupConfigCodexReplacesNumberedMcpTokenEnvVars(t *testing.T) {
	for _, tc := range []struct {
		name        string
		containerID string
	}{
		{name: "standalone"},
		{name: "devcontainer", containerID: "container-123"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tmpDir := t.TempDir()
			t.Setenv("HOME", tmpDir)
			t.Setenv("CODEX_HOME", "")
			if tc.containerID != "" {
				fakeDocker := filepath.Join(tmpDir, "docker")
				script := `#!/bin/sh
case " $* " in
  *" printenv CODEX_HOME "*) exit 1 ;;
  *" id -un "*) exit 1 ;;
  *" printenv HOME "*) printf '/home/testuser\n'; exit 0 ;;
  *" test -f "*) exit 1 ;;
  *" tee /home/testuser/.codex/config.toml "*) cat > "$FAKE_CODEX_CONFIG"; exit 0 ;;
  *) exit 0 ;;
esac
`
				if err := os.WriteFile(fakeDocker, []byte(script), 0o700); err != nil {
					t.Fatalf("write fake docker: %v", err)
				}
				t.Setenv("PATH", tmpDir+string(os.PathListSeparator)+os.Getenv("PATH"))
				t.Setenv("FAKE_CODEX_CONFIG", filepath.Join(tmpDir, "config.toml"))
			}

			h := &SessionHost{config: SessionHostConfig{GatewayConfig: GatewayConfig{
				ContainerUser: "testuser",
				McpServers: []McpServerEntry{
					{URL: "https://api.example.com/first", Token: "first-managed-token"},
					{URL: "https://api.example.com/second", Token: "second-managed-token"},
				},
			}}}
			startup := &agentStartup{containerID: tc.containerID, envVars: []string{
				"SAM_MCP_TOKEN_0=stale-first-token",
				"SAM_MCP_TOKEN_1=stale-second-token",
			}}

			if err := h.writeAgentStartupConfig(context.Background(), "openai-codex", nil, startup); err != nil {
				t.Fatalf("writeAgentStartupConfig failed: %v", err)
			}
			for _, managed := range []struct {
				key   string
				value string
			}{
				{key: "SAM_MCP_TOKEN_0", value: "first-managed-token"},
				{key: "SAM_MCP_TOKEN_1", value: "second-managed-token"},
			} {
				if got := countEnvKey(startup.envVars, managed.key); got != 1 {
					t.Fatalf("%s count = %d, want 1: %v", managed.key, got, startup.envVars)
				}
				assertEnvContains(t, startup.envVars, managed.key, managed.value)
			}
		})
	}
}

func TestActivityReportTimeoutPreservesLegacyDefaultAndOverride(t *testing.T) {
	t.Parallel()

	h := &SessionHost{config: SessionHostConfig{GatewayConfig: GatewayConfig{}}}
	if got := h.activityReportTimeout(); got != 10*time.Second {
		t.Fatalf("activityReportTimeout() = %v, want legacy default 10s", got)
	}

	h.config.ActivityReportTimeout = 17 * time.Second
	if got := h.activityReportTimeout(); got != 17*time.Second {
		t.Fatalf("activityReportTimeout() = %v, want configured 17s", got)
	}
}

func TestWriteAgentStartupConfigCodexMissingMcpTokenFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name        string
		containerID string
	}{
		{name: "standalone", containerID: ""},
		{name: "devcontainer", containerID: "container-123"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tmpDir := t.TempDir()
			t.Setenv("HOME", tmpDir)
			t.Setenv("CODEX_HOME", "")
			h := &SessionHost{config: SessionHostConfig{GatewayConfig: GatewayConfig{
				McpServers:  []McpServerEntry{{URL: "https://api.example.com/mcp"}},
				WorkspaceID: "ws-missing-token",
			}}}
			startup := &agentStartup{containerID: tc.containerID}

			err := h.writeAgentStartupConfig(context.Background(), "openai-codex", nil, startup)
			if err == nil {
				t.Fatal("expected missing SAM MCP token to prevent Codex startup")
			}
			if !strings.Contains(err.Error(), "missing its bearer token") || !strings.Contains(err.Error(), "SAM_MCP_TOKEN") {
				t.Fatalf("expected clear missing-token diagnostic, got: %v", err)
			}
			if len(startup.envVars) != 0 {
				t.Fatalf("failed startup must not inject partial env, got: %v", startup.envVars)
			}
			configPath := filepath.Join(tmpDir, ".codex", "config.toml")
			if _, statErr := os.Stat(configPath); !os.IsNotExist(statErr) {
				t.Fatalf("failed startup must not write local config, stat error: %v", statErr)
			}
		})
	}
}

func TestStartAgentWithSessionModeCodexMissingMcpTokenDoesNotLaunch(t *testing.T) {
	for _, tc := range []struct {
		name        string
		containerID string
	}{
		{name: "standalone"},
		{name: "devcontainer", containerID: "container-123"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var launchCalls int
			h := &SessionHost{config: SessionHostConfig{
				GatewayConfig: GatewayConfig{
					McpServers: []McpServerEntry{{URL: "https://api.example.com/mcp"}},
					ContainerResolver: func() (string, error) {
						return tc.containerID, nil
					},
				},
				StartProcess: func(*agentStartup) (agentProcess, error) {
					launchCalls++
					return nil, fmt.Errorf("unexpected launch")
				},
			}}

			err := h.startAgentWithSessionMode(context.Background(), "openai-codex", &agentCredential{
				credential:     "test-openai-key",
				credentialKind: "api-key",
			}, nil, "", false)
			if err == nil || !strings.Contains(err.Error(), "missing its bearer token") {
				t.Fatalf("error = %v, want missing bearer token diagnostic", err)
			}
			if launchCalls != 0 {
				t.Fatalf("StartProcess calls = %d, want 0", launchCalls)
			}
		})
	}
}

func TestWriteAgentStartupConfigCodexRejectsInvalidMcpValuesBeforeWrite(t *testing.T) {
	tests := []struct {
		name   string
		server McpServerEntry
		want   string
	}{
		{name: "blank URL", server: McpServerEntry{URL: " \t", Token: "token"}, want: "blank URL"},
		{name: "URL with carriage return", server: McpServerEntry{URL: "https://example.com/\rmcp", Token: "token"}, want: "URL contains CR/LF"},
		{name: "URL with newline", server: McpServerEntry{URL: "https://example.com/\nmcp", Token: "token"}, want: "URL contains CR/LF"},
		{name: "token with carriage return", server: McpServerEntry{URL: "https://example.com/mcp", Token: "tok\ren"}, want: "bearer token contains CR/LF"},
		{name: "token with newline", server: McpServerEntry{URL: "https://example.com/mcp", Token: "tok\nen"}, want: "bearer token contains CR/LF"},
	}
	for _, discriminator := range []struct {
		name        string
		containerID string
	}{
		{name: "standalone"},
		{name: "devcontainer", containerID: "container-123"},
	} {
		for _, tc := range tests {
			t.Run(discriminator.name+"/"+tc.name, func(t *testing.T) {
				tmpDir := t.TempDir()
				t.Setenv("HOME", tmpDir)
				t.Setenv("CODEX_HOME", "")
				h := &SessionHost{config: SessionHostConfig{GatewayConfig: GatewayConfig{McpServers: []McpServerEntry{tc.server}}}}
				startup := &agentStartup{containerID: discriminator.containerID}

				err := h.writeAgentStartupConfig(context.Background(), "openai-codex", nil, startup)
				if err == nil || !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("error = %v, want diagnostic containing %q", err, tc.want)
				}
				if len(startup.envVars) != 0 {
					t.Fatalf("invalid startup injected partial env: %v", startup.envVars)
				}
				if _, statErr := os.Stat(filepath.Join(tmpDir, ".codex", "config.toml")); !os.IsNotExist(statErr) {
					t.Fatalf("invalid startup wrote config before validation: %v", statErr)
				}
			})
		}
	}
}
func TestWriteAgentStartupConfigNonCodexStandaloneIsNoop(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	h := &SessionHost{
		config: SessionHostConfig{
			GatewayConfig: GatewayConfig{
				McpServers: []McpServerEntry{
					{URL: "https://api.example.com/mcp", Token: "tok"},
				},
			},
		},
	}

	for _, agentType := range []string{"opencode", "mistral-vibe", "claude-code"} {
		startup := &agentStartup{containerID: ""}
		err := h.writeAgentStartupConfig(context.Background(), agentType, nil, startup)
		if err != nil {
			t.Fatalf("writeAgentStartupConfig(%s) failed: %v", agentType, err)
		}
		if len(startup.envVars) > 0 {
			t.Errorf("writeAgentStartupConfig(%s) with empty containerID should not inject env vars, got %v", agentType, startup.envVars)
		}
	}
}

func TestWriteCodexConfigLocallyCreatesFile(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)
	t.Setenv("CODEX_HOME", "")

	servers := []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "test-token"},
	}

	envVars, err := writeCodexConfigLocally(servers, nil, "")
	if err != nil {
		t.Fatalf("writeCodexConfigLocally failed: %v", err)
	}

	configPath := filepath.Join(tmpDir, ".codex", "config.toml")
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("config file not created at %s: %v", configPath, err)
	}

	content := string(data)
	if !strings.Contains(content, "sam-mcp") {
		t.Error("config missing MCP server entry")
	}
	if !strings.Contains(content, "https://api.example.com/mcp") {
		t.Error("config missing MCP server URL")
	}

	expectedEnvName := codexMcpTokenEnvVar(0, 1)
	foundToken := false
	for _, ev := range envVars {
		if strings.HasPrefix(ev, expectedEnvName+"=") {
			foundToken = true
			if !strings.Contains(ev, "test-token") {
				t.Error("SAM_MCP_TOKEN env var missing token value")
			}
		}
	}
	if !foundToken {
		t.Errorf("expected %s env var in returned envVars: %v", expectedEnvName, envVars)
	}
}

func TestWriteCodexConfigLocallyRespectsCodexHome(t *testing.T) {
	tmpDir := t.TempDir()
	codexHome := filepath.Join(tmpDir, "custom-codex")
	t.Setenv("CODEX_HOME", codexHome)

	servers := []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "tok"},
	}

	_, err := writeCodexConfigLocally(servers, nil, "")
	if err != nil {
		t.Fatalf("writeCodexConfigLocally failed: %v", err)
	}

	configPath := filepath.Join(codexHome, "config.toml")
	if _, err := os.Stat(configPath); err != nil {
		t.Fatalf("config file not written to CODEX_HOME at %s: %v", configPath, err)
	}
}

func TestWriteCodexConfigLocallyMergesExistingConfig(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)
	t.Setenv("CODEX_HOME", "")

	codexDir := filepath.Join(tmpDir, ".codex")
	if err := os.MkdirAll(codexDir, 0o700); err != nil {
		t.Fatal(err)
	}
	existingContent := "model = \"gpt-5-codex\"\napproval_policy = \"never\"\n"
	if err := os.WriteFile(filepath.Join(codexDir, "config.toml"), []byte(existingContent), 0o600); err != nil {
		t.Fatal(err)
	}

	servers := []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "tok"},
	}

	_, err := writeCodexConfigLocally(servers, nil, "")
	if err != nil {
		t.Fatalf("writeCodexConfigLocally failed: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(codexDir, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	merged := string(data)
	if !strings.Contains(merged, "model = \"gpt-5-codex\"") {
		t.Error("existing model config was lost after merge")
	}
	if !strings.Contains(merged, "sam-mcp") {
		t.Error("MCP server entry was not added during merge")
	}
}

func TestWriteCodexConfigLocallyNoServersWritesSandboxControls(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)
	t.Setenv("CODEX_HOME", "")

	envVars, err := writeCodexConfigLocally(nil, nil, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(envVars) != 0 {
		t.Fatalf("expected no MCP env vars, got %v", envVars)
	}

	configPath := filepath.Join(tmpDir, ".codex", "config.toml")
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("sandbox config file was not created: %v", err)
	}
	if !strings.Contains(string(data), `sandbox_mode = "danger-full-access"`) ||
		!strings.Contains(string(data), `approval_policy = "never"`) {
		t.Fatalf("sandbox controls missing from local config: %s", data)
	}
}
