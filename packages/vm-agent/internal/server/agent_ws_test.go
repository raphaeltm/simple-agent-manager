package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentWebSocketSourceContract(t *testing.T) {
	path := filepath.Join("agent_ws.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	for _, needle := range []string{
		"sessionId",
		"gatewayKey",
		"takeover",
		"parseTakeoverParam",
		"agentSessions",
		"idempotencyKey",
		"session_not_running",
		"session_already_attached",
		"agent.session_recovered",
		"ClosePolicyViolation",
	} {
		if !strings.Contains(content, needle) {
			t.Fatalf("expected %q in %s", needle, path)
		}
	}
}

func TestAgentWebSocketRoutingAndAuthContract(t *testing.T) {
	path := filepath.Join("agent_ws.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	for _, needle := range []string{
		"requireWorkspaceRoute",
		"authenticateWorkspaceWebsocket",
		"attach/stop race handling",
	} {
		if !strings.Contains(content, needle) {
			t.Fatalf("expected %q in %s", needle, path)
		}
	}
}
