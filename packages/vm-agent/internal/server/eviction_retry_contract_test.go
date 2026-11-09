package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
)

func TestEvictionOwnedStartRetryDoesNotAdmitOrMutateWork(t *testing.T) {
	for _, versioned := range []bool{false, true} {
		name := "legacy"
		if versioned {
			name = "versioned"
		}
		t.Run(name, func(t *testing.T) {
			f := startEvictionAgentFixture(t, false)
			s := f.server
			s.config.NodeID = "node-test"
			body := map[string]any{"agentType": "claude-code", "initialPrompt": "long-running work", "projectId": "project-1", "taskId": "task-1", "taskMode": "conversation"}
			if versioned {
				body["protocolVersion"] = 1
				body["deliveryId"] = "start-retry-1"
				body["messageId"] = "message-1"
			}
			post := func(session string, b map[string]any) *httptest.ResponseRecorder {
				return nodeManagementPOST(t, s, s.handleStartAgentSession, "workspace-1", session, "/workspaces/workspace-1/agent-sessions/"+session+"/start", b)
			}
			first := post("agent-1", body)
			if first.Code != http.StatusAccepted {
				t.Fatalf("first start=%d %s", first.Code, first.Body.String())
			}
			waitForFile(t, f.launcher.pidFile+".prompting")
			if versioned {
				conflicting := make(map[string]any, len(body))
				for k, v := range body {
					conflicting[k] = v
				}
				conflicting["initialPrompt"] = "conflicting content"
				if response := post("agent-1", conflicting); response.Code != http.StatusConflict {
					t.Fatalf("receipt conflict=%d", response.Code)
				}
			}

			s.sessionHostMu.Lock()
			before := s.sessionProfileOvr["workspace-1:agent-1"]
			taskBefore := s.sessionTaskCtx["workspace-1:agent-1"]
			s.sessionHostMu.Unlock()
			s.markEvictionFinalizing("workspace-1")
			defer s.clearEvictionFinalizing("workspace-1")
			f.host.PrepareEviction()
			retry := post("agent-1", body)
			want := http.StatusAccepted
			if versioned {
				want = http.StatusOK
			}
			if retry.Code != want {
				t.Fatalf("owned retry=%d %s", retry.Code, retry.Body.String())
			}
			for _, field := range []string{"initialPrompt", "taskId", "model", "deliveryId"} {
				if field == "deliveryId" && !versioned {
					continue
				}
				changed := make(map[string]any, len(body))
				for k, v := range body {
					changed[k] = v
				}
				changed[field] = "different"
				response := post("agent-1", changed)
				if response.Code != http.StatusConflict {
					t.Fatalf("changed %s accepted: %d %s", field, response.Code, response.Body.String())
				}
			}
			if _, _, err := s.agentSessions.Create("workspace-1", "other-session", "Other", ""); err != nil {
				t.Fatal(err)
			}
			if response := post("other-session", body); response.Code != http.StatusConflict {
				t.Fatalf("new session accepted: %d", response.Code)
			}
			s.sessionHostMu.Lock()
			after := s.sessionProfileOvr["workspace-1:agent-1"]
			taskAfter := s.sessionTaskCtx["workspace-1:agent-1"]
			s.sessionHostMu.Unlock()
			if before != after || taskBefore != taskAfter {
				t.Fatal("retry mutated active settings or task attribution")
			}
			if f.host.Status() != acp.HostPrompting || f.launcher.starts.Load() != 1 {
				t.Fatal("retry admitted work or restarted host")
			}
			expectNoTaskCallback(t, f.taskCallbacks, 50*time.Millisecond, "owned start retry")
			count, err := os.ReadFile(f.launcher.pidFile + ".prompt-count")
			if err != nil || string(count) != "1" {
				t.Fatalf("ACP prompt calls=%q err=%v", count, err)
			}
			f.host.StopForEviction()
		})
	}
}

func TestRestoreDeniedByEvictionReturnsDegradedWithoutLosingFence(t *testing.T) {
	s, input := newRestoreRetryTestServer(t)
	s.config.Role = config.RoleStandalone
	input.runtime.WorkspaceDir = filepath.Join(t.TempDir(), "workspace")
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/session-snapshot/restore") {
			// The snapshot response races eviction after restore acquired lifecycle ownership.
			s.markEvictionFinalizing("ws")
			_, _ = w.Write([]byte(`{"available":true,"manifest":{"agentType":"claude-code","acpSessionId":"saved-session","artifacts":{"home":{}}}}`))
		} else {
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer api.Close()
	s.config.ControlPlaneURL = api.URL
	response := nodeManagementPOST(t, s, s.handleRestoreAgentSession, "ws", "session", "/workspaces/ws/agent-sessions/session/restore", map[string]any{"chatSessionId": "chat", "runtime": "vm", "agentType": "claude-code", "workspaceCallbackToken": "fresh"})
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"degraded"`) {
		t.Fatalf("denied restore=%d %s", response.Code, response.Body.String())
	}
	if !s.isEvictionFinalizing("ws") {
		t.Fatal("degraded restore cleared eviction fence")
	}
	if len(s.sessionHosts) != 0 {
		t.Fatal("degraded restore admitted a host")
	}
	session, _ := s.agentSessions.Get("ws", "session")
	if session.AcpSessionID != "saved-session" {
		t.Fatalf("fallback discarded eviction-owned session identity: %+v", session)
	}
	// Replay must retain the bounded degraded result, rather than a cached panic conflict.
	response = nodeManagementPOST(t, s, s.handleRestoreAgentSession, "ws", "session", "/workspaces/ws/agent-sessions/session/restore", map[string]any{"chatSessionId": "chat", "runtime": "vm", "agentType": "claude-code", "workspaceCallbackToken": "fresh"})
	if response.Code != http.StatusOK {
		t.Fatalf("degraded retry=%d %s", response.Code, response.Body.String())
	}
}

func TestPendingEvictionRetryDoesNotClearExistingFinalization(t *testing.T) {
	s := newEvictionTestServer()
	initializeEvictionTestStore(t, s)
	setupEvictionDocker(t, evictionTestContainerID)
	delivery := queueEvictionFixture(t, s, false)
	// Another owner has reached the stop/final-capture window after retry admission.
	s.markEvictionFinalizing("workspace-1")
	obsolete, err := s.reconcilePendingEvictionStop(context.Background(), &delivery)
	if err == nil || obsolete {
		t.Fatalf("retry stole existing finalization: obsolete=%v err=%v", obsolete, err)
	}
	if !s.isEvictionFinalizing("workspace-1") {
		t.Fatal("retry cleared the original stop's admission fence")
	}
	session := agentsessions.Session{}
	if host := s.getOrCreateSessionHost("workspace-1:late", "workspace-1", "late", session, nil, ""); host != nil {
		t.Fatal("retry reopened host admission")
	}
	s.clearEvictionFinalizing("workspace-1")
	if host := s.getOrCreateSessionHost("workspace-1:late", "workspace-1", "late", session, nil, ""); host == nil {
		t.Fatal("original finalization release did not reopen admission")
	}
}

func TestRejectedStartDoesNotReplaceAcceptedPromptFingerprint(t *testing.T) {
	f := startEvictionAgentFixture(t, false)
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.server.startAgentWithPromptObserved(f.host, "workspace-1", "agent-1", "claude-code", "owner prompt", "", "", nil, "owner-fingerprint")
	}()
	waitForFile(t, f.launcher.pidFile+".prompting")
	// The later start arrives while the actual prompt owns admission. It must
	// neither invoke ACP nor replace the identity used to acknowledge eviction.
	f.server.startAgentWithPromptObserved(f.host, "workspace-1", "agent-1", "claude-code", "different prompt", "", "", nil, "other-fingerprint")
	f.server.sessionHostMu.Lock()
	got := f.server.sessionProfileOvr["workspace-1:agent-1"].StartFingerprint
	f.server.sessionHostMu.Unlock()
	if got != "owner-fingerprint" {
		t.Fatalf("accepted prompt identity overwritten: %q", got)
	}
	count, err := os.ReadFile(f.launcher.pidFile + ".prompt-count")
	if err != nil || string(count) != "1" {
		t.Fatalf("ACP prompt calls=%q err=%v", count, err)
	}
	f.host.PrepareEviction()
	f.host.StopForEviction()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("eviction did not release owner prompt")
	}
}
