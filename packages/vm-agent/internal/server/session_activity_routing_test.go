package server

import (
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/messagereport"
)

func TestSessionHostActivityUsesOwningWorkspaceProject(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	paths := make([]string, 0, 2)
	reported := make(chan struct{}, 2)
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		reported <- struct{}{}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer controlPlane.Close()

	serverConfig := &config.Config{
		NodeID:               "node-routing",
		ControlPlaneURL:      controlPlane.URL,
		CallbackToken:        "node-callback-token",
		ACPMessageBufferSize: 32,
		ACPViewerSendBuffer:  8,
	}
	s := &Server{
		config: serverConfig,
		acpConfig: acp.GatewayConfig{
			NodeID:          serverConfig.NodeID,
			ControlPlaneURL: controlPlane.URL,
			CallbackToken:   serverConfig.CallbackToken,
			HTTPClient:      controlPlane.Client(),
		},
		workspaces: map[string]*WorkspaceRuntime{
			"workspace-a": {ID: "workspace-a", ProjectID: "project-a"},
			"workspace-b": {ID: "workspace-b", ProjectID: "project-b"},
		},
		agentSessions:     agentsessions.NewManager(),
		sessionHosts:      map[string]*acp.SessionHost{},
		sessionMcpServers: map[string][]acp.McpServerEntry{},
		sessionProfileOvr: map[string]profileOverrides{},
		sessionTaskCtx:    map[string]taskCallbackContext{},
		messageReporters:  map[string]*messagereport.Reporter{},
	}

	for _, tc := range []struct {
		workspaceID string
		sessionID   string
	}{
		{workspaceID: "workspace-a", sessionID: "session-a"},
		{workspaceID: "workspace-b", sessionID: "session-b"},
	} {
		runtime := s.workspaces[tc.workspaceID]
		host := s.getOrCreateSessionHost(
			tc.workspaceID+":"+tc.sessionID,
			tc.workspaceID,
			tc.sessionID,
			agentsessions.Session{ID: tc.sessionID, WorkspaceID: tc.workspaceID},
			runtime,
			"",
		)
		host.Stop()
	}

	for range 2 {
		select {
		case <-reported:
		case <-time.After(500 * time.Millisecond):
			t.Fatal("timed out waiting for project-scoped activity callbacks")
		}
	}

	mu.Lock()
	sort.Strings(paths)
	got := append([]string(nil), paths...)
	mu.Unlock()
	want := []string{
		"/api/projects/project-a/acp-sessions/session-a/activity",
		"/api/projects/project-b/acp-sessions/session-b/activity",
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("activity paths = %v, want %v", got, want)
		}
	}
}
