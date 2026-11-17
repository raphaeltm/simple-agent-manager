package server

import (
	"context"
	"encoding/json"
	"fmt"
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
// The Worker sends a runtime contract (agent-session-bootstrap.ts); legacy
// callers do not, so both request shapes are covered.
func TestVMRestoreHandlerAnswersTranscriptOnlyFallbackWithSharedContract(t *testing.T) {
	for _, tc := range []struct {
		name            string
		runtimeContract string
	}{
		{name: "worker runtime contract", runtimeContract: `,"runtimeContract":{"version":1,"agentType":"claude-code","permissionMode":"default","settingsResolved":true,"taskContext":{"projectId":"project","taskId":"recovery","taskMode":"conversation"}}`},
		{name: "legacy caller without contract"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertTranscriptOnlyRestoreContract(t, tc.runtimeContract)
		})
	}
}

func assertTranscriptOnlyRestoreContract(t *testing.T, runtimeContract string) {
	t.Helper()
	fixture := loadTranscriptOnlyRestoreFixture(t)
	var controlPlane struct {
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(fixture.ControlPlaneRestoreResponse, &controlPlane); err != nil || controlPlane.Reason == "" {
		t.Fatalf("fixture control-plane response has no reason: %v", err)
	}
	s, _ := newRestoreRetryTestServer(t)
	if s.config.IsStandaloneMode() {
		t.Fatal("this contract covers VM wakes; the test server must not be standalone")
	}
	validator, key := newWorkspaceCreateJWTValidator(t, "node-test")
	s.jwtValidator = validator
	token := signWorkspaceCreateNodeToken(t, key, "node-test", "ws")

	var mu sync.Mutex
	var reported []map[string]string
	var unexpected []string
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		authorized := r.Header.Get("Authorization") == "Bearer fresh"
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/api/workspaces/ws/session-snapshot/restore"):
			if !authorized || r.URL.Query().Get("chatSessionId") != "chat" {
				mu.Lock()
				unexpected = append(unexpected, "restore fetch without the workspace token or chat: "+r.URL.String())
				mu.Unlock()
			}
			_, _ = w.Write(fixture.ControlPlaneRestoreResponse)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/api/workspaces/ws/session-snapshot/restore-result"):
			var payload map[string]string
			body, err := io.ReadAll(r.Body)
			if err == nil {
				err = json.Unmarshal(body, &payload)
			}
			mu.Lock()
			if err != nil || !authorized {
				unexpected = append(unexpected, fmt.Sprintf("bad restore-result report (authorized=%v): %v", authorized, err))
			} else {
				reported = append(reported, payload)
			}
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/lifecycle-timings"):
			// Best-effort wake telemetry, posted asynchronously; not part of this contract.
			w.WriteHeader(http.StatusNoContent)
		default:
			mu.Lock()
			unexpected = append(unexpected, r.Method+" "+r.URL.Path)
			mu.Unlock()
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(cp.Close)
	s.config.ControlPlaneURL = cp.URL

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost,
		"/workspaces/ws/agent-sessions/session/restore",
		strings.NewReader(`{"chatSessionId":"chat","runtime":"vm","agentType":"claude-code","workspaceCallbackToken":"fresh"`+runtimeContract+`}`))
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

	// The Worker then calls start on this same session. Start admission refuses
	// while a restore or creation for the workspace is pending
	// (handleStartAgentSession, getOrCreateSessionHostForRestore), and start
	// needs the session running. A completed transcript replay must leave all
	// of that open, and must not have started an agent of its own.
	s.sessionHostMu.Lock()
	restorePending := s.workspaceRestorePendingLocked("ws")
	creationPending := s.workspaceCreationPendingLocked("ws")
	hosts := len(s.sessionHosts)
	s.sessionHostMu.Unlock()
	if restorePending || creationPending {
		t.Fatalf("completed transcript replay still fences start: restorePending=%v creationPending=%v", restorePending, creationPending)
	}
	if hosts != 0 {
		t.Fatalf("transcript replay created %d agent host(s); the fresh start must create the first", hosts)
	}
	session, ok := s.agentSessions.Get("ws", "session")
	if !ok || session.Status != agentsessions.StatusRunning || session.AcpSessionID != "" || session.AgentType != "" || session.LastPrompt != "" {
		t.Fatalf("transcript replay left the session unable to start fresh: ok=%v %+v", ok, session)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(unexpected) != 0 {
		t.Fatalf("unexpected control-plane traffic: %v", unexpected)
	}
	if len(reported) != 1 || reported[0]["status"] != "missing" || reported[0]["chatSessionId"] != "chat" || reported[0]["message"] != controlPlane.Reason {
		t.Fatalf("restore-result reports = %v, want one 'missing' report for chat carrying %q", reported, controlPlane.Reason)
	}
}
