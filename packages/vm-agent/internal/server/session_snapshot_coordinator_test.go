package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

func TestHibernateHandlerAcceptsBackgroundCaptureBeforeWorkCompletes(t *testing.T) {
	validator, key := newWorkspaceCreateJWTValidator(t, "node-1")
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	s := &Server{
		config: &config.Config{
			NodeID:                          "node-1",
			SessionSnapshotOperationTimeout: time.Second,
		},
		jwtValidator: validator,
		workspaces: map[string]*WorkspaceRuntime{
			"workspace-1": {ID: "workspace-1", CallbackToken: "workspace-callback-token"},
		},
		sessionSnapshotRunner: func(ctx context.Context, _ *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
			started <- struct{}{}
			select {
			case <-release:
				return map[string]interface{}{"status": "available"}, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		},
	}
	token := signWorkspaceCreateNodeToken(t, key, "node-1", "workspace-1")
	req := httptest.NewRequest(http.MethodPost, "/workspaces/workspace-1/agent-sessions/agent-1/hibernate", bytes.NewBufferString(`{"chatSessionId":"chat-1","runtime":"vm","background":true}`))
	req.SetPathValue("workspaceId", "workspace-1")
	req.SetPathValue("sessionId", "agent-1")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-SAM-Node-Id", "node-1")
	req.Header.Set("X-SAM-Workspace-Id", "workspace-1")
	recorder := httptest.NewRecorder()

	s.handleHibernateAgentSession(recorder, req)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusAccepted, recorder.Body.String())
	}
	var response struct {
		Status   string `json:"status"`
		Accepted bool   `json:"accepted"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Status != "pending" || !response.Accepted {
		t.Fatalf("response = %#v, want accepted pending capture", response)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("accepted background capture did not start")
	}
	close(release)
}

func TestBackgroundSessionSnapshotReturnsImmediatelyAndDeduplicates(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	finished := make(chan struct{}, 1)
	var calls atomic.Int32
	s := &Server{
		config: &config.Config{SessionSnapshotOperationTimeout: time.Second},
		sessionSnapshotRunner: func(ctx context.Context, _ *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
			calls.Add(1)
			started <- struct{}{}
			select {
			case <-release:
				finished <- struct{}{}
				return map[string]interface{}{"status": "available"}, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		},
	}
	input := &sessionSnapshotHandlerInput{chatSessionID: "chat-1"}

	if !s.startBackgroundSessionSnapshot(input) {
		t.Fatal("first background snapshot was not accepted")
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("background snapshot did not start")
	}
	if s.startBackgroundSessionSnapshot(input) {
		t.Fatal("duplicate background snapshot was accepted while capture was active")
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("snapshot calls = %d, want 1", got)
	}

	close(release)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("background snapshot did not finish")
	}
}

func TestFinalSessionSnapshotWaitsForBackgroundCaptureThenRunsFreshCapture(t *testing.T) {
	backgroundStarted := make(chan struct{}, 1)
	releaseBackground := make(chan struct{})
	finalStarted := make(chan struct{}, 1)
	var calls atomic.Int32
	s := &Server{
		config: &config.Config{SessionSnapshotOperationTimeout: time.Second},
		sessionSnapshotRunner: func(ctx context.Context, _ *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
			switch calls.Add(1) {
			case 1:
				backgroundStarted <- struct{}{}
				select {
				case <-releaseBackground:
					return map[string]interface{}{"status": "available"}, nil
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			case 2:
				finalStarted <- struct{}{}
				return map[string]interface{}{"status": "available"}, nil
			default:
				t.Fatalf("unexpected snapshot call %d", calls.Load())
				return nil, nil
			}
		},
	}
	input := &sessionSnapshotHandlerInput{chatSessionID: "chat-1"}
	if !s.startBackgroundSessionSnapshot(input) {
		t.Fatal("background snapshot was not accepted")
	}
	<-backgroundStarted

	finalDone := make(chan error, 1)
	go func() {
		_, err := s.captureSessionSnapshot(context.Background(), input)
		finalDone <- err
	}()
	select {
	case <-finalStarted:
		t.Fatal("final snapshot raced the active background capture")
	case <-time.After(50 * time.Millisecond):
	}

	close(releaseBackground)
	select {
	case <-finalStarted:
	case <-time.After(time.Second):
		t.Fatal("final snapshot did not start after background capture completed")
	}
	if err := <-finalDone; err != nil {
		t.Fatalf("final snapshot failed: %v", err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("snapshot calls = %d, want 2", got)
	}
}
