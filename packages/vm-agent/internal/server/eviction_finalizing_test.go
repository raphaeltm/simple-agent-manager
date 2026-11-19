package server

// Staging 2026-11-05: the final eviction capture runs between the container stop and the
// recorded eviction. The heartbeat's callback retry found the stop's write-ahead intent in
// that window, reconciled it as an interrupted stop and sent the control plane
// snapshotCaptured=false, which it refuses with 409 on every retry. The controller's own
// record then found the eviction already recorded and never sent the real callback, so the
// workspace stayed `running` in D1 with its container stopped.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/resourcemon"
)

func evictionCallbackRecorder(t *testing.T, s *Server) chan map[string]interface{} {
	t.Helper()
	callbacks := make(chan map[string]interface{}, 4)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/eviction") {
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			callbacks <- body
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(api.Close)
	s.config.ControlPlaneURL = api.URL
	return callbacks
}

func expectNoEvictionCallback(t *testing.T, callbacks chan map[string]interface{}) {
	t.Helper()
	select {
	case body := <-callbacks:
		t.Fatalf("eviction callback sent while the eviction was still finalizing: %v", body)
	case <-time.After(100 * time.Millisecond):
	}
}

func expectEvictionCallback(t *testing.T, callbacks chan map[string]interface{}) map[string]interface{} {
	t.Helper()
	select {
	case body := <-callbacks:
		return body
	case <-time.After(5 * time.Second):
		t.Fatal("eviction callback was not delivered")
		return nil
	}
}

func TestHeartbeatLeavesAnEvictionFinalizingItsSnapshotToTheController(t *testing.T) {
	s := newEvictionTestServer()
	initializeEvictionTestStore(t, s)
	setupEvictionDocker(t, evictionTestContainerID)
	callbacks := evictionCallbackRecorder(t, s)
	target := evictionTargetFixture(s)

	// The controller stops the container after its pre-stop capture succeeded...
	if err := s.stopEvictedWorkspaceContainer(context.Background(), target); err != nil {
		t.Fatalf("stop: %v", err)
	}
	// ...and the final capture is still running when the heartbeat retries callbacks.
	s.retryPendingEvictionCallbacks()
	expectNoEvictionCallback(t, callbacks)
	if got := s.workspaces["workspace-1"].Status; got != "running" {
		t.Fatalf("heartbeat recorded a finalizing eviction (status %q)", got)
	}

	// The controller records the eviction after the final capture and delivers it.
	result := resourcemon.EvictionResult{Target: target, SnapshotCaptured: true, ContainerStopped: true,
		CompletedAt: time.Now().UTC()}
	if !s.markWorkspaceEvicted(result) {
		t.Fatal("controller could not record its own eviction")
	}
	if err := s.notifyWorkspaceEvicted(context.Background(), result); err != nil {
		t.Fatal(err)
	}
	body := expectEvictionCallback(t, callbacks)
	if body["snapshotCaptured"] != true || body["containerStopped"] != true {
		t.Fatalf("callback = %v", body)
	}
	if s.isEvictionFinalizing("workspace-1") {
		t.Fatal("finalizing mark outlived the recorded eviction")
	}
}

func TestFailedEvictionStopReturnsTheIntentToTheReconciler(t *testing.T) {
	s := newEvictionTestServer()
	initializeEvictionTestStore(t, s)
	setupEvictionDocker(t, evictionTestContainerID)
	callbacks := evictionCallbackRecorder(t, s)
	t.Setenv("SAM_EVICTION_TEST_STOP_EXIT", "1")
	if err := s.stopEvictedWorkspaceContainer(context.Background(), evictionTargetFixture(s)); err == nil {
		t.Fatal("stop unexpectedly succeeded")
	}
	if s.isEvictionFinalizing("workspace-1") {
		t.Fatal("a failed stop left the eviction marked finalizing")
	}
	// The reconciler retries the stop and delivers, as it did before the final capture.
	t.Setenv("SAM_EVICTION_TEST_STOP_EXIT", "0")
	if err := s.deliverPendingWorkspaceEvictionAt(context.Background(), "", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	body := expectEvictionCallback(t, callbacks)
	if body["snapshotCaptured"] != true || body["containerStopped"] != true {
		t.Fatalf("reconciled callback = %v", body)
	}
}

func TestSnapshotsAreRefusedWhileAnEvictionIsFinalizingOrDone(t *testing.T) {
	for _, test := range []struct {
		name  string
		setup func(s *Server)
	}{
		{"finalizing", func(s *Server) { s.markEvictionFinalizing("workspace-1") }},
		{"evicted", func(s *Server) { s.workspaces["workspace-1"].Status = "evicted" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := newEvictionTestServer()
			ran := make(chan struct{}, 2)
			s.sessionSnapshotRunner = func(context.Context, *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
				ran <- struct{}{}
				return map[string]interface{}{"status": "available"}, nil
			}
			test.setup(s)
			input := &sessionSnapshotHandlerInput{workspaceID: "workspace-1", chatSessionID: "chat-1"}
			if _, err := s.captureSessionSnapshot(context.Background(), input); err != errWorkspaceEvicting {
				t.Fatalf("capture err = %v", err)
			}
			if !s.startBackgroundSessionSnapshot(input) {
				t.Fatal("background snapshot was not accepted")
			}
			select {
			case <-ran:
				t.Fatal("a snapshot ran during the eviction")
			case <-time.After(200 * time.Millisecond):
			}
		})
	}
}

func TestSnapshotsStillRunForALiveWorkspace(t *testing.T) {
	s := newEvictionTestServer()
	ran := make(chan struct{}, 2)
	s.sessionSnapshotRunner = func(context.Context, *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
		ran <- struct{}{}
		return map[string]interface{}{"status": "available"}, nil
	}
	input := &sessionSnapshotHandlerInput{workspaceID: "workspace-1", chatSessionID: "chat-1"}
	if _, err := s.captureSessionSnapshot(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	if !s.startBackgroundSessionSnapshot(input) {
		t.Fatal("background snapshot was not accepted")
	}
	for i := 0; i < 2; i++ {
		select {
		case <-ran:
		case <-time.After(2 * time.Second):
			t.Fatal("snapshot did not run for a live workspace")
		}
	}
}

func TestUnwrittenEvictionIntentLeavesNoFinalizingMark(t *testing.T) {
	s := newEvictionTestServer() // No delivery store: the write-ahead intent cannot be written.
	setupEvictionDocker(t, evictionTestContainerID)
	if err := s.stopEvictedWorkspaceContainer(context.Background(), evictionTargetFixture(s)); err == nil {
		t.Fatal("stopped without a durable intent")
	}
	if s.isEvictionFinalizing("workspace-1") {
		t.Fatal("an eviction that never wrote its intent stayed marked finalizing")
	}
}

func hibernateRequestForEvictionTest(t *testing.T, s *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	validator, key := newWorkspaceCreateJWTValidator(t, "node-1")
	s.jwtValidator = validator
	req := httptest.NewRequest(http.MethodPost, "/workspaces/workspace-1/agent-sessions/agent-1/hibernate", bytes.NewBufferString(body))
	req.SetPathValue("workspaceId", "workspace-1")
	req.SetPathValue("sessionId", "agent-1")
	req.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, key, "node-1", "workspace-1"))
	req.Header.Set("X-SAM-Node-Id", "node-1")
	req.Header.Set("X-SAM-Workspace-Id", "workspace-1")
	recorder := httptest.NewRecorder()
	s.handleHibernateAgentSession(recorder, req)
	return recorder
}

// A hibernate request carries a callback token and chat binding, and writing either bumps
// the runtime's UpdatedAt. The eviction records itself only while UpdatedAt still equals
// the runtime version it stopped, so a request arriving during the final capture used to
// make markWorkspaceEvicted return false silently and the eviction was never recorded.
func TestHibernateRequestDuringFinalizingEvictionLeavesTheRuntimeUntouched(t *testing.T) {
	s := newEvictionTestServer()
	initializeEvictionTestStore(t, s)
	setupEvictionDocker(t, evictionTestContainerID)
	callbacks := evictionCallbackRecorder(t, s)
	target := evictionTargetFixture(s)
	if err := s.stopEvictedWorkspaceContainer(context.Background(), target); err != nil {
		t.Fatalf("stop: %v", err)
	}
	before := *s.workspaces["workspace-1"]

	for _, background := range []string{"false", "true"} {
		rec := hibernateRequestForEvictionTest(t, s, `{"chatSessionId":"chat-session-2","runtime":"vm","background":`+background+`,"workspaceCallbackToken":"fresh-workspace-token"}`)
		if rec.Code != http.StatusConflict {
			t.Fatalf("background=%s: hibernate during finalizing = %d %s, want 409", background, rec.Code, rec.Body.String())
		}
	}
	after := s.workspaces["workspace-1"]
	if !after.UpdatedAt.Equal(before.UpdatedAt) || after.CallbackToken != before.CallbackToken || after.ChatSessionID != before.ChatSessionID {
		t.Fatalf("finalizing runtime mutated: updatedAt %v -> %v, token %q -> %q, chat %q -> %q",
			before.UpdatedAt, after.UpdatedAt, before.CallbackToken, after.CallbackToken, before.ChatSessionID, after.ChatSessionID)
	}
	result := resourcemon.EvictionResult{Target: target, SnapshotCaptured: true, ContainerStopped: true, CompletedAt: time.Now().UTC()}
	if !s.markWorkspaceEvicted(result) {
		t.Fatal("the eviction could not record itself after a hibernate request")
	}
	if err := s.notifyWorkspaceEvicted(context.Background(), result); err != nil {
		t.Fatal(err)
	}
	expectEvictionCallback(t, callbacks)
}

// Control: outside an eviction the same request still binds the chat session and captures.
func TestHibernateRequestOutsideAnEvictionStillBindsTheRuntime(t *testing.T) {
	s := newEvictionTestServer()
	s.sessionSnapshotRunner = func(context.Context, *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
		return map[string]interface{}{"status": "available"}, nil
	}
	rec := hibernateRequestForEvictionTest(t, s, `{"chatSessionId":"chat-session-2","runtime":"vm","workspaceCallbackToken":"fresh-workspace-token"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("hibernate = %d %s", rec.Code, rec.Body.String())
	}
	if got := s.workspaces["workspace-1"].ChatSessionID; got != "chat-session-2" {
		t.Fatalf("chat session = %q, want the hibernate request's binding", got)
	}
}
