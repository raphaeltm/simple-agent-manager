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
		"hostKey",
		"agentSessions",
		"idempotencyKey",
		"session_not_running",
		"agent.session_recovered",
		"ClosePolicyViolation",
		"SessionHost",
		"AttachViewer",
		"DetachViewer",
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
		"resolveWorkspaceIDForWebsocket",
		"authenticateWorkspaceWebsocket",
		"Post-upgrade race check",
	} {
		if !strings.Contains(content, needle) {
			t.Fatalf("expected %q in %s", needle, path)
		}
	}
}
