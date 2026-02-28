package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentSessionsSourceContract(t *testing.T) {
	path := filepath.Join("workspaces.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	for _, needle := range []string{
		"handleListAgentSessions",
		"handleCreateAgentSession",
		"handleStartAgentSession",
		"handleStopAgentSession",
		"Idempotency-Key",
		// Session visibility enrichment
		"enrichedSession",
		"HostStatus",
		"ViewerCount",
		"host.Status()",
		"host.ViewerCount()",
	} {
		if !strings.Contains(content, needle) {
			t.Fatalf("expected %q in %s", needle, path)
		}
	}
}

func TestStartAgentSessionSourceContract(t *testing.T) {
	path := filepath.Join("workspaces.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	// Verify the start endpoint handler exists and has the required structure
	for _, needle := range []string{
		"handleStartAgentSession",
		"startAgentWithPrompt",
		`"agentType"`,
		`"initialPrompt"`,
		"agentType is required",
		"initialPrompt is required",
		"getOrCreateSessionHost",
		"SelectAgent",
		"HandlePrompt",
		"OnPromptCompleteCallback",
		"agent_session.starting",
		"agent_session.start_failed",
		"agent_session.prompt_sent",
		// Duplicate prompt protection: HostPrompting must cause early return
		"HostPrompting",
		"skipping duplicate",
	} {
		if !strings.Contains(content, needle) {
			t.Fatalf("expected %q in %s for start endpoint", needle, path)
		}
	}
}

func TestStartAgentSessionRouteRegistration(t *testing.T) {
	path := filepath.Join("server.go")
	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	content := string(contentBytes)

	route := `"POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/start"`
	if !strings.Contains(content, route) {
		t.Fatalf("missing route registration: %s", route)
	}
}
