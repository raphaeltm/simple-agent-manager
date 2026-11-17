package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/workspace/vm-agent/internal/agentsessions"
)

// Cross-boundary contract test (.claude/rules/23) for waking a chat whose sleep
// fell back to transcript-only.
//
// It reads the SAME fixture as the Worker tests that produce the control plane's
// restore response (apps/api/tests/integration/session-sleep-bounded-fallback.test.ts)
// and consume this handler's answer (apps/api/tests/unit/durable-objects/
// task-runner-transcript-only-wake.test.ts). Before the fix the Worker threw on
// this exact answer, and every wake of such a chat failed.
type transcriptOnlyRestoreFixture struct {
	ControlPlaneRestoreResponse json.RawMessage        `json:"controlPlaneRestoreResponse"`
	VMAgentRestoreResponse      map[string]interface{} `json:"vmAgentRestoreResponse"`
}

func loadTranscriptOnlyRestoreFixture(t *testing.T) transcriptOnlyRestoreFixture {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "tests", "fixtures", "session-snapshot-restore-transcript-only-v1.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read shared contract fixture %s: %v", path, err)
	}
	var fixture transcriptOnlyRestoreFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("decode shared contract fixture: %v", err)
	}
	if len(fixture.ControlPlaneRestoreResponse) == 0 || len(fixture.VMAgentRestoreResponse) == 0 {
		t.Fatal("shared contract fixture is missing a response")
	}
	return fixture
}

// A VM wake: the workspace was provisioned by create-workspace and the wake's
// pristine agent session was created, then the control plane calls restore.
func TestVMRestoreHandlerAnswersTranscriptOnlyFallbackWithSharedContract(t *testing.T) {
	fixture := loadTranscriptOnlyRestoreFixture(t)
	s, _ := newRestoreRetryTestServer(t)
	validator, key := newWorkspaceCreateJWTValidator(t, "node-test")
	s.jwtValidator = validator
	token := signWorkspaceCreateNodeToken(t, key, "node-test", "ws")

	var mu sync.Mutex
	var reported []map[string]string
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/session-snapshot/restore"):
			_, _ = w.Write(fixture.ControlPlaneRestoreResponse)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/session-snapshot/restore-result"):
			body, _ := io.ReadAll(r.Body)
			var payload map[string]string
			_ = json.Unmarshal(body, &payload)
			mu.Lock()
			reported = append(reported, payload)
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected control-plane call %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(cp.Close)
	s.config.ControlPlaneURL = cp.URL

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost,
		"/workspaces/ws/agent-sessions/session/restore",
		strings.NewReader(`{"chatSessionId":"chat","runtime":"vm","agentType":"claude-code","workspaceCallbackToken":"fresh"}`))
	req.SetPathValue("workspaceId", "ws")
	req.SetPathValue("sessionId", "session")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-SAM-Workspace-Id", "ws")
	rec := httptest.NewRecorder()
	s.handleRestoreAgentSession(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("restore status = %d, body %s", rec.Code, rec.Body.String())
	}
	var got map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode restore response %q: %v", rec.Body.String(), err)
	}
	if !reflect.DeepEqual(got, fixture.VMAgentRestoreResponse) {
		t.Fatalf("restore response = %v, want the shared contract %v", got, fixture.VMAgentRestoreResponse)
	}

	// The Worker then starts the agent fresh on this same session, so the
	// restore must leave it exactly as create made it: no host, no agent identity.
	session, ok := s.agentSessions.Get("ws", "session")
	if !ok {
		t.Fatal("transcript replay removed the wake's agent session")
	}
	if session.Status != agentsessions.StatusRunning || session.AcpSessionID != "" || session.AgentType != "" {
		t.Fatalf("transcript replay changed the agent session: %+v", session)
	}
	s.sessionHostMu.Lock()
	hosts := len(s.sessionHosts)
	s.sessionHostMu.Unlock()
	if hosts != 0 {
		t.Fatalf("transcript replay created %d agent host(s); the fresh start must create the first", hosts)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(reported) != 1 || reported[0]["status"] != "missing" || reported[0]["chatSessionId"] != "chat" {
		t.Fatalf("restore-result reports = %v, want one 'missing' report for chat", reported)
	}
}
