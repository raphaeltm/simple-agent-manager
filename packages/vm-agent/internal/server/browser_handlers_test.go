package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/browser"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/container"
)

// testBrowserConfig returns a minimal config for browser handler tests.
func testBrowserConfig() *config.Config {
	return &config.Config{
		ControlPlaneURL:     "https://api.test.example.com",
		NekoBrowserStartTimeout: 30 * time.Second,
		NekoBrowserStopTimeout:  15 * time.Second,
		NekoImage:               "ghcr.io/m1k1o/neko/google-chrome:latest",
		NekoScreenResolution:    "1920x1080",
		NekoMaxFPS:              30,
		NekoWebRTCPort:          8080,
		NekoSocatPollInterval:   5 * time.Second,
		NekoMinRAMMB:            2048,
		NekoEnableAudio:         true,
		NekoTCPFallback:         true,
		NekoPassword:            "neko",
		NekoPasswordAdmin:       "admin",
		NekoShmSize:             "2g",
		NekoMemoryLimit:         "4g",
		NekoCPULimit:            "2",
		NekoPidsLimit:           512,
		NekoSocatMinPort:        1024,
		NekoSocatMaxPort:        65535,
		NekoViewportMinWidth:    320,
		NekoViewportMaxWidth:    7680,
		NekoViewportMinHeight:   240,
		NekoViewportMaxHeight:   4320,
		NekoViewportMaxDPR:      4,
		PortScanEphemeralMin:    32768,
	}
}

// newTestSessionManager creates a session manager for handler tests.
func newBrowserTestSessionManager() *auth.SessionManager {
	return auth.NewSessionManager("vm_session", false, 1*time.Hour)
}

// authedRequest creates an HTTP request that passes workspace auth via session cookie.
// The caller must provide the sessionManager that was used to create the session.
func authedRequest(t *testing.T, method, url, workspaceID string, sm *auth.SessionManager, body ...string) *http.Request {
	t.Helper()

	var bodyStr string
	if len(body) > 0 {
		bodyStr = body[0]
	}

	req := httptest.NewRequest(method, url, strings.NewReader(bodyStr))

	// Create a session for the workspace and set the scoped cookie
	claims := &auth.Claims{Workspace: workspaceID}
	session, err := sm.CreateSession(claims)
	if err != nil {
		t.Fatalf("failed to create test session: %v", err)
	}
	// Set workspace-scoped cookie: cookieName_workspaceID
	req.AddCookie(&http.Cookie{Name: "vm_session_" + workspaceID, Value: session.ID})

	req.SetPathValue("workspaceId", workspaceID)
	return req
}

func parseJSONResponse(t *testing.T, w *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()
	var result map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("failed to parse JSON response: %v (body: %s)", err, w.Body.String())
	}
	return result
}

// ---------------------------------------------------------------------------
// handleStartBrowser tests
// ---------------------------------------------------------------------------

func TestHandleStartBrowser_MissingWorkspaceID(t *testing.T) {
	sm := newBrowserTestSessionManager()
	defer sm.Stop()
	s := &Server{
		config:         testBrowserConfig(),
		sessionManager: sm,
	}

	req := httptest.NewRequest("POST", "/workspaces//browser", nil)
	// PathValue returns "" when workspaceId is not set
	w := httptest.NewRecorder()
	s.handleStartBrowser(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	resp := parseJSONResponse(t, w)
	if resp["error"] != "workspaceId is required" {
		t.Fatalf("unexpected error: %v", resp["error"])
	}
}

func TestHandleStartBrowser_AuthRejection(t *testing.T) {
	sm := newBrowserTestSessionManager()
	defer sm.Stop()
	s := &Server{
		config:         testBrowserConfig(),
		sessionManager: sm,
	}

	req := httptest.NewRequest("POST", "/workspaces/ws-test/browser", nil)
	req.SetPathValue("workspaceId", "ws-test")
	// No auth cookie or token
	w := httptest.NewRecorder()
	s.handleStartBrowser(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestHandleStartBrowser_NilBrowserManager(t *testing.T) {
	sm := newBrowserTestSessionManager()
	defer sm.Stop()
	s := &Server{
		config:         testBrowserConfig(),
		sessionManager: sm,
		browserManager: nil,
	}

	req := authedRequest(t, "POST", "/workspaces/ws-test/browser", "ws-test", sm)
	w := httptest.NewRecorder()
	s.handleStartBrowser(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", w.Code)
	}
	resp := parseJSONResponse(t, w)
	if resp["error"] != "browser sidecar not available" {
		t.Fatalf("unexpected error: %v", resp["error"])
	}
}

func TestHandleStartBrowser_ResolveContainerIDError(t *testing.T) {
	sm := newBrowserTestSessionManager()
	defer sm.Stop()
	docker := &noopDocker{}
	mgr := browser.NewManager(testBrowserConfig(), docker)

	s := &Server{
		config:             testBrowserConfig(),
		sessionManager:     sm,
		browserManager:     mgr,
		containerDiscovery: nil,
		portDiscoveries:    map[string]*container.Discovery{},
	}

	req := authedRequest(t, "POST", "/workspaces/ws-test/browser", "ws-test", sm)
	w := httptest.NewRecorder()
	s.handleStartBrowser(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	resp := parseJSONResponse(t, w)
	errMsg, _ := resp["error"].(string)
	if !strings.Contains(errMsg, "workspace container not found") {
		t.Fatalf("unexpected error: %v", resp["error"])
	}
}

// ---------------------------------------------------------------------------
// handleGetBrowserStatus tests
// ---------------------------------------------------------------------------

func TestHandleGetBrowserStatus_MissingWorkspaceID(t *testing.T) {
	sm := newBrowserTestSessionManager()
	defer sm.Stop()
	s := &Server{
		config:         testBrowserConfig(),
		sessionManager: sm,
	}

	req := httptest.NewRequest("GET", "/workspaces//browser", nil)
	w := httptest.NewRecorder()
	s.handleGetBrowserStatus(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestHandleGetBrowserStatus_AuthRejection(t *testing.T) {
	sm := newBrowserTestSessionManager()
	defer sm.Stop()
	s := &Server{
		config:         testBrowserConfig(),
		sessionManager: sm,
	}

	req := httptest.NewRequest("GET", "/workspaces/ws-test/browser", nil)
	req.SetPathValue("workspaceId", "ws-test")
	w := httptest.NewRecorder()
	s.handleGetBrowserStatus(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestHandleGetBrowserStatus_NilBrowserManager(t *testing.T) {
	sm := newBrowserTestSessionManager()
	defer sm.Stop()
	s := &Server{
		config:         testBrowserConfig(),
		sessionManager: sm,
		browserManager: nil,
	}

	req := authedRequest(t, "GET", "/workspaces/ws-test/browser", "ws-test", sm)
	w := httptest.NewRecorder()
	s.handleGetBrowserStatus(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	resp := parseJSONResponse(t, w)
	if resp["status"] != "off" {
		t.Fatalf("expected status 'off', got %v", resp["status"])
	}
}

func TestHandleGetBrowserStatus_NoSidecar(t *testing.T) {
	sm := newBrowserTestSessionManager()
	defer sm.Stop()
	docker := &noopDocker{}
	mgr := browser.NewManager(testBrowserConfig(), docker)

	s := &Server{
		config:         testBrowserConfig(),
		sessionManager: sm,
		browserManager: mgr,
	}

	req := authedRequest(t, "GET", "/workspaces/ws-test/browser", "ws-test", sm)
	w := httptest.NewRecorder()
	s.handleGetBrowserStatus(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	resp := parseJSONResponse(t, w)
	if resp["status"] != "off" {
		t.Fatalf("expected status 'off' for no sidecar, got %v", resp["status"])
	}
}

// ---------------------------------------------------------------------------
// handleStopBrowser tests
// ---------------------------------------------------------------------------

func TestHandleStopBrowser_MissingWorkspaceID(t *testing.T) {
	sm := newBrowserTestSessionManager()
	defer sm.Stop()
	s := &Server{
		config:         testBrowserConfig(),
		sessionManager: sm,
	}

	req := httptest.NewRequest("DELETE", "/workspaces//browser", nil)
	w := httptest.NewRecorder()
	s.handleStopBrowser(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestHandleStopBrowser_AuthRejection(t *testing.T) {
	sm := newBrowserTestSessionManager()
	defer sm.Stop()
	s := &Server{
		config:         testBrowserConfig(),
		sessionManager: sm,
	}

	req := httptest.NewRequest("DELETE", "/workspaces/ws-test/browser", nil)
	req.SetPathValue("workspaceId", "ws-test")
	w := httptest.NewRecorder()
	s.handleStopBrowser(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestHandleStopBrowser_NilBrowserManager(t *testing.T) {
	sm := newBrowserTestSessionManager()
	defer sm.Stop()
	s := &Server{
		config:         testBrowserConfig(),
		sessionManager: sm,
		browserManager: nil,
	}

	req := authedRequest(t, "DELETE", "/workspaces/ws-test/browser", "ws-test", sm)
	w := httptest.NewRecorder()
	s.handleStopBrowser(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	resp := parseJSONResponse(t, w)
	if resp["status"] != "off" {
		t.Fatalf("expected status 'off', got %v", resp["status"])
	}
}

func TestHandleStopBrowser_NonExistentSidecar(t *testing.T) {
	sm := newBrowserTestSessionManager()
	defer sm.Stop()
	docker := &noopDocker{}
	mgr := browser.NewManager(testBrowserConfig(), docker)

	s := &Server{
		config:         testBrowserConfig(),
		sessionManager: sm,
		browserManager: mgr,
	}

	req := authedRequest(t, "DELETE", "/workspaces/ws-test/browser", "ws-test", sm)
	w := httptest.NewRecorder()
	s.handleStopBrowser(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	resp := parseJSONResponse(t, w)
	if resp["status"] != "off" {
		t.Fatalf("expected status 'off', got %v", resp["status"])
	}
}

// ---------------------------------------------------------------------------
// handleGetBrowserPorts tests
// ---------------------------------------------------------------------------

func TestHandleGetBrowserPorts_MissingWorkspaceID(t *testing.T) {
	sm := newBrowserTestSessionManager()
	defer sm.Stop()
	s := &Server{
		config:         testBrowserConfig(),
		sessionManager: sm,
	}

	req := httptest.NewRequest("GET", "/workspaces//browser/ports", nil)
	w := httptest.NewRecorder()
	s.handleGetBrowserPorts(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestHandleGetBrowserPorts_AuthRejection(t *testing.T) {
	sm := newBrowserTestSessionManager()
	defer sm.Stop()
	s := &Server{
		config:         testBrowserConfig(),
		sessionManager: sm,
	}

	req := httptest.NewRequest("GET", "/workspaces/ws-test/browser/ports", nil)
	req.SetPathValue("workspaceId", "ws-test")
	w := httptest.NewRecorder()
	s.handleGetBrowserPorts(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestHandleGetBrowserPorts_NilBrowserManager(t *testing.T) {
	sm := newBrowserTestSessionManager()
	defer sm.Stop()
	s := &Server{
		config:         testBrowserConfig(),
		sessionManager: sm,
		browserManager: nil,
	}

	req := authedRequest(t, "GET", "/workspaces/ws-test/browser/ports", "ws-test", sm)
	w := httptest.NewRecorder()
	s.handleGetBrowserPorts(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	resp := parseJSONResponse(t, w)
	ports, ok := resp["ports"].([]interface{})
	if !ok {
		t.Fatalf("expected ports array, got %T", resp["ports"])
	}
	if len(ports) != 0 {
		t.Fatalf("expected empty ports array, got %v", ports)
	}
}

func TestHandleGetBrowserPorts_NoSidecar(t *testing.T) {
	sm := newBrowserTestSessionManager()
	defer sm.Stop()
	docker := &noopDocker{}
	mgr := browser.NewManager(testBrowserConfig(), docker)

	s := &Server{
		config:         testBrowserConfig(),
		sessionManager: sm,
		browserManager: mgr,
	}

	req := authedRequest(t, "GET", "/workspaces/ws-test/browser/ports", "ws-test", sm)
	w := httptest.NewRecorder()
	s.handleGetBrowserPorts(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	resp := parseJSONResponse(t, w)
	ports, ok := resp["ports"].([]interface{})
	if !ok {
		t.Fatalf("expected ports array, got %T", resp["ports"])
	}
	if len(ports) != 0 {
		t.Fatalf("expected empty ports array, got %v", ports)
	}
}

// ---------------------------------------------------------------------------
// browserStateToResponse tests
// ---------------------------------------------------------------------------

func TestBrowserStateToResponse_OffStatus(t *testing.T) {
	state := &browser.SidecarState{Status: browser.StatusOff}
	resp := browserStateToResponse(state, "ws-1", "https://api.test.example.com")

	if resp["status"] != "off" {
		t.Fatalf("expected status 'off', got %v", resp["status"])
	}
	if _, ok := resp["url"]; ok {
		t.Fatal("off status should not include url")
	}
}

func TestBrowserStateToResponse_RunningWithPort(t *testing.T) {
	state := &browser.SidecarState{
		Status:        browser.StatusRunning,
		ContainerName: "neko-ws-1",
		NekoPort:      8080,
	}
	resp := browserStateToResponse(state, "ws-1", "https://api.test.example.com")

	if resp["status"] != "running" {
		t.Fatalf("expected status 'running', got %v", resp["status"])
	}
	expectedURL := "https://ws-ws-1--8080.test.example.com"
	if resp["url"] != expectedURL {
		t.Fatalf("expected url %q, got %v", expectedURL, resp["url"])
	}
	if resp["containerName"] != "neko-ws-1" {
		t.Fatalf("expected containerName 'neko-ws-1', got %v", resp["containerName"])
	}
}

func TestBrowserStateToResponse_ErrorSanitized(t *testing.T) {
	state := &browser.SidecarState{
		Status: browser.StatusError,
		Error:  "docker: Error response from daemon: OCI runtime error: internal details",
	}
	resp := browserStateToResponse(state, "ws-1", "https://api.test.example.com")

	errMsg, _ := resp["error"].(string)
	if errMsg != "browser sidecar failed to start" {
		t.Fatalf("expected sanitized error message, got %q", errMsg)
	}
	// The raw Docker error must NOT appear in the response
	if strings.Contains(errMsg, "docker") || strings.Contains(errMsg, "OCI") {
		t.Fatal("Docker internals leaked in error response")
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// noopDocker is a minimal DockerExecutor that does nothing (for tests
// that only need a non-nil browser.Manager without actual Docker I/O).
type noopDocker struct{}

func (d *noopDocker) Run(_ context.Context, _ ...string) ([]byte, error) {
	return nil, nil
}
func (d *noopDocker) RunSilent(_ context.Context, _ ...string) error {
	return nil
}
