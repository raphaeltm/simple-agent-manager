package acp

import (
	"testing"
)

func TestGetAgentCommandInfoClaudeCode(t *testing.T) {
	t.Parallel()

	info := getAgentCommandInfo("claude-code")
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

	info := getAgentCommandInfo("openai-codex")
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

	info := getAgentCommandInfo("google-gemini")
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

	info := getAgentCommandInfo("custom-agent")
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
