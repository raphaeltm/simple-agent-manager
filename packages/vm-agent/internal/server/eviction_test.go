package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/container"
	"github.com/workspace/vm-agent/internal/ports"
	"github.com/workspace/vm-agent/internal/pty"
	"github.com/workspace/vm-agent/internal/resourcemon"
)

func newEvictionTestServer() *Server {
	ptyManager := pty.NewManager(pty.ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		WorkDir:      "/tmp",
		BufferSize:   1024,
	})
	return &Server{
		config: &config.Config{
			NodeID:                    "node-1",
			WorkspaceID:               "workspace-1",
			ProjectID:                 "project-1",
			ChatSessionID:             "boot-chat-session",
			CallbackToken:             "node-callback-token",
			ControlPlaneURL:           "https://api.example.com",
			EvictionDockerStopTimeout: time.Second,
			EvictionSnapshotTimeout:   time.Second,
			EvictionDebounceWindow:    time.Second,
			EvictionResolveTimeout:    time.Second,
			ContainerMode:             true,
			ContainerLabelKey:         "devcontainer.local_folder",
			ContainerStatsInterval:    time.Second,
			PSIPollInterval:           time.Second,
			MaxNodeEvents:             500,
			MaxWorkspaceEvents:        500,
			HTTPCallbackTimeout:       time.Second,
		},
		workspaces: map[string]*WorkspaceRuntime{
			"workspace-1": {
				ID:                  "workspace-1",
				Status:              "running",
				ProjectID:           "project-1",
				ChatSessionID:       "chat-session-1",
				CallbackToken:       "workspace-callback-token",
				ContainerLabelValue: "/workspace/repo",
				ContainerWorkDir:    "/workspaces/repo",
				ContainerUser:       "node",
				PTY:                 ptyManager,
			},
		},
		workspaceEvents:     map[string][]EventRecord{},
		nodeEvents:          []EventRecord{},
		agentSessions:       agentsessions.NewManager(),
		sessionHosts:        map[string]*acp.SessionHost{},
		sessionMcpServers:   map[string][]acp.McpServerEntry{},
		sessionProfileOvr:   map[string]profileOverrides{},
		sessionTaskCtx:      map[string]taskCallbackContext{},
		bootLogBroadcasters: NewBootLogBroadcasterManager(),
		portScanners:        map[string]*ports.Scanner{},
		portDiscoveries:     map[string]*container.Discovery{},
		done:                make(chan struct{}),
	}
}

func TestCaptureEvictionSessionSnapshotUsesSynchronousHibernateInput(t *testing.T) {
	s := newEvictionTestServer()
	session, _, err := s.agentSessions.Create("workspace-1", "agent-session-1", "Agent", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.agentSessions.UpdateAcpSessionID("workspace-1", session.ID, "acp-session-1", "openai-codex"); err != nil {
		t.Fatal(err)
	}

	var captured *sessionSnapshotHandlerInput
	s.sessionSnapshotRunner = func(_ context.Context, input *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
		copy := *input
		captured = &copy
		return map[string]interface{}{"status": "available"}, nil
	}

	err = s.captureEvictionSessionSnapshot(context.Background(), resourcemon.EvictionTarget{
		WorkspaceID: "workspace-1",
		ContainerID: "container-1",
		Reason:      resourcemon.EvictionReasonMemoryPressure,
	})
	if err != nil {
		t.Fatalf("captureEvictionSessionSnapshot: %v", err)
	}
	if captured == nil {
		t.Fatal("snapshot runner was not called")
	}
	if captured.background {
		t.Fatal("eviction snapshot used background capture; want synchronous capture")
	}
	if captured.workspaceID != "workspace-1" ||
		captured.sessionID != "agent-session-1" ||
		captured.chatSessionID != "chat-session-1" ||
		captured.callbackToken != "workspace-callback-token" ||
		captured.acpSessionID != "acp-session-1" ||
		captured.agentType != "openai-codex" ||
		captured.runtimeName != defaultEvictionSnapshotRuntimeName {
		t.Fatalf("captured input = %#v", captured)
	}
}

func TestCaptureEvictionSessionSnapshotRequiresChatSessionID(t *testing.T) {
	s := newEvictionTestServer()
	s.workspaces["workspace-1"].ChatSessionID = ""
	s.config.ChatSessionID = ""
	if _, _, err := s.agentSessions.Create("workspace-1", "agent-session-1", "Agent", ""); err != nil {
		t.Fatal(err)
	}

	err := s.captureEvictionSessionSnapshot(context.Background(), resourcemon.EvictionTarget{
		WorkspaceID: "workspace-1",
		ContainerID: "container-1",
		Reason:      resourcemon.EvictionReasonMemoryPressure,
	})
	if err == nil {
		t.Fatal("captureEvictionSessionSnapshot returned nil error without chat session ID")
	}
}

func TestMarkWorkspaceEvictedUpdatesRuntimeAndAgentSessions(t *testing.T) {
	s := newEvictionTestServer()
	session, _, err := s.agentSessions.Create("workspace-1", "agent-session-1", "Agent", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.agentSessions.UpdateAcpSessionID("workspace-1", session.ID, "acp-session-1", "openai-codex"); err != nil {
		t.Fatal(err)
	}

	s.markWorkspaceEvicted(resourcemon.EvictionResult{
		Target: resourcemon.EvictionTarget{
			WorkspaceID: "workspace-1",
			ContainerID: "container-1",
			Reason:      resourcemon.EvictionReasonOOMKill,
		},
		SnapshotCaptured: true,
		ContainerStopped: true,
	})

	runtime := s.workspaces["workspace-1"]
	if runtime.Status != "evicted" {
		t.Fatalf("runtime status = %q, want evicted", runtime.Status)
	}
	gotSession, ok := s.agentSessions.Get("workspace-1", "agent-session-1")
	if !ok {
		t.Fatal("agent session missing")
	}
	if gotSession.Status != agentsessions.StatusError {
		t.Fatalf("agent session status = %s, want error", gotSession.Status)
	}
	if gotSession.AcpSessionID != "acp-session-1" {
		t.Fatalf("AcpSessionID = %q, want preserved", gotSession.AcpSessionID)
	}
	if len(s.workspaceEvents["workspace-1"]) == 0 {
		t.Fatal("workspace eviction event was not appended")
	}
}

func TestNotifyWorkspaceEvictedPostsCallbackPayload(t *testing.T) {
	s := newEvictionTestServer()
	type callbackBody struct {
		NodeID           string `json:"nodeId"`
		WorkspaceID      string `json:"workspaceId"`
		Reason           string `json:"reason"`
		SnapshotCaptured bool   `json:"snapshotCaptured"`
		ContainerStopped bool   `json:"containerStopped"`
	}
	type callbackRequest struct {
		Method        string
		Path          string
		Authorization string
		ContentType   string
		Body          callbackBody
		Err           string
	}
	requests := make(chan callbackRequest, 1)
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body callbackBody
		req := callbackRequest{
			Method:        r.Method,
			Path:          r.URL.EscapedPath(),
			Authorization: r.Header.Get("Authorization"),
			ContentType:   r.Header.Get("Content-Type"),
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			req.Err = err.Error()
			requests <- req
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		req.Body = body
		requests <- req
		w.WriteHeader(http.StatusNoContent)
	}))
	defer controlPlane.Close()
	s.config.ControlPlaneURL = controlPlane.URL

	err := s.notifyWorkspaceEvicted(context.Background(), resourcemon.EvictionResult{
		Target: resourcemon.EvictionTarget{
			WorkspaceID: "workspace-1",
			ContainerID: "container-1",
			Reason:      resourcemon.EvictionReasonOOMKill,
		},
		SnapshotCaptured: false,
		ContainerStopped: true,
	})
	if err != nil {
		t.Fatalf("notifyWorkspaceEvicted: %v", err)
	}

	select {
	case got := <-requests:
		if got.Err != "" {
			t.Fatalf("callback decode error: %s", got.Err)
		}
		if got.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", got.Method)
		}
		if got.Path != "/api/projects/project-1/workspaces/workspace-1/eviction" {
			t.Fatalf("path = %q", got.Path)
		}
		if got.Authorization != "Bearer workspace-callback-token" {
			t.Fatalf("Authorization = %q, want workspace callback token", got.Authorization)
		}
		if got.ContentType != "application/json" {
			t.Fatalf("Content-Type = %q, want application/json", got.ContentType)
		}
		wantBody := callbackBody{
			NodeID:           "node-1",
			WorkspaceID:      "workspace-1",
			Reason:           string(resourcemon.EvictionReasonOOMKill),
			SnapshotCaptured: false,
			ContainerStopped: true,
		}
		if got.Body != wantBody {
			t.Fatalf("body = %#v, want %#v", got.Body, wantBody)
		}
	case <-time.After(time.Second):
		t.Fatal("control plane callback was not sent")
	}
}

func TestEvictionDockerStopArgsPreserveOverlayFilesystem(t *testing.T) {
	got := evictionDockerStopArgs(10, "container-1")
	want := []string{"stop", "--time", "10", "container-1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("evictionDockerStopArgs = %#v, want %#v", got, want)
	}
	for _, arg := range got {
		if arg == "rm" || arg == "-f" || arg == "--force" {
			t.Fatalf("eviction docker args include destructive removal flag: %#v", got)
		}
	}
}

func TestEvictionDockerStopCommandTimeoutAllowsDockerClientToReturn(t *testing.T) {
	stopTimeout := 10 * time.Second
	if got := evictionDockerStopCommandTimeout(stopTimeout); got <= stopTimeout {
		t.Fatalf("evictionDockerStopCommandTimeout = %s, want greater than docker --time %s", got, stopTimeout)
	}
}
