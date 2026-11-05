package server

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

func stubSelfRestartSignal(t *testing.T) *atomic.Int32 {
	t.Helper()
	var calls atomic.Int32
	original := selfRestartSignal
	selfRestartSignal = func() error {
		calls.Add(1)
		return nil
	}
	t.Cleanup(func() { selfRestartSignal = original })
	return &calls
}

func restartRequest(token string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/admin/restart-agent", nil)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	request.Header.Set("X-SAM-Node-Id", diagnosticAuthNodeID)
	return request
}

func waitForSignals(t *testing.T, calls *atomic.Int32, want int32) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for calls.Load() < want && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := calls.Load(); got != want {
		t.Fatalf("restart signals = %d, want %d", got, want)
	}
}

func TestRestartAgentRequiresANodeScopedManagementToken(t *testing.T) {
	fx := newDiagnosticAuthFixture(t)
	defer fx.stop()
	calls := stubSelfRestartSignal(t)
	fx.server.config.SelfRestartDelay = 0

	cases := map[string]*http.Request{
		"no credentials":         restartRequest(""),
		"workspace-scoped token": restartRequest(fx.workspaceMgmtA),
	}
	cookie := restartRequest("")
	cookie.AddCookie(fx.workspaceCookieA)
	cases["workspace session cookie"] = cookie

	for name, request := range cases {
		t.Run(name, func(t *testing.T) {
			response := httptest.NewRecorder()
			fx.server.handleRestartAgent(response, request)
			if response.Code != http.StatusUnauthorized && response.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 401/403; body=%s", response.Code, response.Body.String())
			}
		})
	}
	time.Sleep(50 * time.Millisecond)
	if calls.Load() != 0 {
		t.Fatal("an unauthorized request restarted the agent")
	}
}

func TestRestartAgentAnswersFirstThenSignalsOnceForRepeatedRequests(t *testing.T) {
	fx := newDiagnosticAuthFixture(t)
	defer fx.stop()
	calls := stubSelfRestartSignal(t)
	fx.server.config.SelfRestartDelay = 20 * time.Millisecond

	first := httptest.NewRecorder()
	fx.server.handleRestartAgent(first, restartRequest(fx.nodeToken))
	if first.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", first.Code, first.Body.String())
	}
	if calls.Load() != 0 {
		t.Fatal("signalled before the response was written and the delay elapsed")
	}
	second := httptest.NewRecorder()
	fx.server.handleRestartAgent(second, restartRequest(fx.nodeToken))
	if second.Code != http.StatusAccepted {
		t.Fatalf("repeat status = %d, want 202", second.Code)
	}
	waitForSignals(t, calls, 1)
	time.Sleep(50 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatalf("repeated requests signalled %d times, want 1", calls.Load())
	}
}

func TestRestartAgentIsRefusedInStandaloneMode(t *testing.T) {
	fx := newDiagnosticAuthFixture(t)
	defer fx.stop()
	calls := stubSelfRestartSignal(t)
	fx.server.config.SelfRestartDelay = 0
	fx.server.config.Role = config.RoleStandalone

	response := httptest.NewRecorder()
	fx.server.handleRestartAgent(response, restartRequest(fx.nodeToken))
	if response.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", response.Code, response.Body.String())
	}
	time.Sleep(50 * time.Millisecond)
	if calls.Load() != 0 {
		t.Fatal("standalone agent signalled itself with no supervisor to restart it")
	}
}
