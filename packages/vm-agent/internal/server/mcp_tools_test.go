package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/ports"
)

// ---------- Test helpers ----------

// newMcpTestSessionManager creates a SessionManager suitable for unit tests.
func newMcpTestSessionManager() *auth.SessionManager {
	return auth.NewSessionManagerWithConfig(auth.SessionManagerConfig{
		CookieName:      "vm_session",
		Secure:          false,
		TTL:             1 * time.Hour,
		CleanupInterval: 1 * time.Hour,
		MaxSessions:     100,
	})
}

// mcpTestServer builds the minimal Server required for MCP tool handler tests.
func mcpTestServer(t *testing.T, controlPlaneURL string) *Server {
	t.Helper()
	sm := newMcpTestSessionManager()
	t.Cleanup(func() { sm.Stop() })

	return &Server{
		config: &config.Config{
			NodeID:          "node-test-001",
			ControlPlaneURL: controlPlaneURL,
		},
		sessionManager:  sm,
		workspaces:      make(map[string]*WorkspaceRuntime),
		portScanners:    make(map[string]*ports.Scanner),
		workspaceEvents: map[string][]EventRecord{},
		nodeEvents:      make([]EventRecord, 0),
	}
}

// injectSession creates an auth.Session pre-loaded with workspace claims and
// returns a cookie that can be attached to requests so they pass
// requireWorkspaceRequestAuth without needing a real JWT.
//
// Because workspaceCookieName is unexported on SessionManager, we manually
// compute the expected cookie name using the same formula:
//
//	"vm_session_" + workspaceID
func injectSession(t *testing.T, sm *auth.SessionManager, workspaceID string) *http.Cookie {
	t.Helper()

	claims := &auth.Claims{}
	claims.Subject = "user-test-001"
	claims.Workspace = workspaceID

	session, err := sm.CreateSession(claims)
	if err != nil {
		t.Fatalf("injectSession: CreateSession: %v", err)
	}

	// The workspace-scoped cookie name mirrors workspaceCookieName() in session.go.
	cookieName := "vm_session_" + workspaceID
	return &http.Cookie{Name: cookieName, Value: session.ID}
}

// mcpGET fires a GET request at a handler with optional auth cookie.
func mcpGET(
	t *testing.T,
	s *Server,
	path string,
	workspaceID string,
	withAuth bool,
	handlerFn http.HandlerFunc,
) *httptest.ResponseRecorder {
	t.Helper()

	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.SetPathValue("workspaceId", workspaceID)

	if withAuth {
		cookie := injectSession(t, s.sessionManager, workspaceID)
		req.AddCookie(cookie)
	}

	rec := httptest.NewRecorder()
	handlerFn(rec, req)
	return rec
}

// mcpPOST fires a POST request at a handler with a JSON body and optional auth cookie.
func mcpPOST(
	t *testing.T,
	s *Server,
	path string,
	workspaceID string,
	withAuth bool,
	body interface{},
	handlerFn http.HandlerFunc,
) *httptest.ResponseRecorder {
	t.Helper()

	bodyBytes, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("mcpPOST: marshal body: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.SetPathValue("workspaceId", workspaceID)

	if withAuth {
		cookie := injectSession(t, s.sessionManager, workspaceID)
		req.AddCookie(cookie)
	}

	rec := httptest.NewRecorder()
	handlerFn(rec, req)
	return rec
}

// decodeJSON is a convenience wrapper that unmarshals a response body into v.
func decodeJSON(t *testing.T, rec *httptest.ResponseRecorder, v interface{}) {
	t.Helper()
	if err := json.NewDecoder(rec.Body).Decode(v); err != nil {
		t.Fatalf("decodeJSON: %v (body: %s)", err, rec.Body.String())
	}
}

// ---------- GET /workspaces/{workspaceId}/mcp/workspace-info ----------

func TestMcpWorkspaceInfo_AuthRejection(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	rec := mcpGET(t, s, "/workspaces/ws-001/mcp/workspace-info", "ws-001", false, s.handleMcpWorkspaceInfo)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestMcpWorkspaceInfo_WorkspaceNotFound(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	// No workspace registered — resolveContainerForWorkspace returns "workspace not found".
	rec := mcpGET(t, s, "/workspaces/ws-missing/mcp/workspace-info", "ws-missing", true, s.handleMcpWorkspaceInfo)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for missing workspace, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	var errResp map[string]string
	decodeJSON(t, rec, &errResp)
	if !strings.Contains(errResp["error"], "workspace not found") {
		t.Errorf("expected error to mention 'workspace not found', got %q", errResp["error"])
	}
}

func TestMcpWorkspaceInfo_WorkspaceNotRunning(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	// Workspace exists but is in "stopped" status.
	s.workspaces["ws-stopped"] = &WorkspaceRuntime{
		ID:        "ws-stopped",
		Status:    "stopped",
		Repository: "octo/repo",
		Branch:    "main",
		CreatedAt: time.Now().Add(-10 * time.Minute),
	}

	rec := mcpGET(t, s, "/workspaces/ws-stopped/mcp/workspace-info", "ws-stopped", true, s.handleMcpWorkspaceInfo)

	// resolveContainerForWorkspace rejects non-running/recovery statuses.
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for non-running workspace, got %d (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestMcpWorkspaceInfo_ContainerModeDisabled(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")
	s.config.ContainerMode = false

	s.workspaces["ws-001"] = &WorkspaceRuntime{
		ID:        "ws-001",
		Status:    "running",
		Repository: "octo/fallback-repo",
		Branch:    "feature-branch",
		CreatedAt: time.Now().Add(-5 * time.Minute),
	}

	// Container mode is off — resolveContainerForWorkspace returns "container mode is not enabled".
	rec := mcpGET(t, s, "/workspaces/ws-001/mcp/workspace-info", "ws-001", true, s.handleMcpWorkspaceInfo)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 when container mode disabled, got %d (body: %s)", rec.Code, rec.Body.String())
	}
}

// ---------- GET /workspaces/{workspaceId}/mcp/credential-status ----------

func TestMcpCredentialStatus_AuthRejection(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	rec := mcpGET(t, s, "/workspaces/ws-001/mcp/credential-status", "ws-001", false, s.handleMcpCredentialStatus)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestMcpCredentialStatus_WorkspaceNotFound(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	rec := mcpGET(t, s, "/workspaces/ws-missing/mcp/credential-status", "ws-missing", true, s.handleMcpCredentialStatus)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for missing workspace, got %d", rec.Code)
	}

	var errResp map[string]string
	decodeJSON(t, rec, &errResp)
	if !strings.Contains(errResp["error"], "workspace not found") {
		t.Errorf("expected 'workspace not found' in error, got %q", errResp["error"])
	}
}

func TestMcpCredentialStatus_WorkspaceNotRunning(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	s.workspaces["ws-creating"] = &WorkspaceRuntime{
		ID:     "ws-creating",
		Status: "creating",
	}

	rec := mcpGET(t, s, "/workspaces/ws-creating/mcp/credential-status", "ws-creating", true, s.handleMcpCredentialStatus)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for non-running workspace, got %d", rec.Code)
	}
}

func TestMcpCredentialStatus_ContainerModeDisabled(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")
	s.config.ContainerMode = false

	s.workspaces["ws-001"] = &WorkspaceRuntime{
		ID:     "ws-001",
		Status: "running",
	}

	// Without container mode, resolveContainerForWorkspace returns an error.
	rec := mcpGET(t, s, "/workspaces/ws-001/mcp/credential-status", "ws-001", true, s.handleMcpCredentialStatus)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 when container mode disabled, got %d", rec.Code)
	}
}

// ---------- GET /workspaces/{workspaceId}/mcp/network-info ----------

func TestMcpNetworkInfo_AuthRejection(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	rec := mcpGET(t, s, "/workspaces/ws-001/mcp/network-info", "ws-001", false, s.handleMcpNetworkInfo)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestMcpNetworkInfo_HappyPath_NoPorts(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	// No port scanner registered for workspace — ports list should be empty.
	rec := mcpGET(t, s, "/workspaces/ws-001/mcp/network-info", "ws-001", true, s.handleMcpNetworkInfo)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	var resp McpNetworkInfoResponse
	decodeJSON(t, rec, &resp)

	if resp.WorkspaceURL != "https://ws-ws-001.example.com" {
		t.Errorf("unexpected WorkspaceURL: %q", resp.WorkspaceURL)
	}
	if resp.BaseDomain != "example.com" {
		t.Errorf("unexpected BaseDomain: %q", resp.BaseDomain)
	}
	if resp.Ports == nil {
		t.Error("expected non-nil Ports slice")
	}
	if len(resp.Ports) != 0 {
		t.Errorf("expected 0 ports, got %d", len(resp.Ports))
	}
}

// TestMcpNetworkInfo_HappyPath_WithScanner verifies that a registered scanner is
// consulted for port data, and that the response lists detected ports with the
// correct external URL pattern. The scanner is registered but has no open ports
// (it has not scanned yet), so the result is an empty list — this tests the code
// path that reads from the scanner rather than returning nil.
func TestMcpNetworkInfo_HappyPath_WithEmptyScanner(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	scanner := ports.NewScanner(ports.ScannerConfig{
		Enabled:  true,
		Interval: 24 * time.Hour, // won't tick during test
	})

	s.portScannerMu.Lock()
	s.portScanners["ws-001"] = scanner
	s.portScannerMu.Unlock()

	rec := mcpGET(t, s, "/workspaces/ws-001/mcp/network-info", "ws-001", true, s.handleMcpNetworkInfo)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	var resp McpNetworkInfoResponse
	decodeJSON(t, rec, &resp)

	// Scanner registered but no ports detected yet — slice must be non-nil and empty.
	if resp.Ports == nil {
		t.Error("expected non-nil Ports slice even when scanner reports no open ports")
	}
	if len(resp.Ports) != 0 {
		t.Errorf("expected 0 ports from empty scanner, got %d", len(resp.Ports))
	}
}

// TestMcpNetworkInfo_WorkspaceURLConstruction verifies URL construction across domains.
func TestMcpNetworkInfo_WorkspaceURLConstruction(t *testing.T) {
	t.Parallel()

	tests := []struct {
		controlPlaneURL      string
		workspaceID          string
		expectedWorkspaceURL string
		expectedBaseDomain   string
	}{
		{
			controlPlaneURL:      "https://api.example.com",
			workspaceID:          "ws-abc",
			expectedWorkspaceURL: "https://ws-ws-abc.example.com",
			expectedBaseDomain:   "example.com",
		},
		{
			controlPlaneURL:      "https://api.sammy.party",
			workspaceID:          "ws-xyz",
			expectedWorkspaceURL: "https://ws-ws-xyz.sammy.party",
			expectedBaseDomain:   "sammy.party",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.controlPlaneURL, func(t *testing.T) {
			t.Parallel()
			s := mcpTestServer(t, tc.controlPlaneURL)

			rec := mcpGET(t, s, "/workspaces/"+tc.workspaceID+"/mcp/network-info", tc.workspaceID, true, s.handleMcpNetworkInfo)

			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d", rec.Code)
			}

			var resp McpNetworkInfoResponse
			decodeJSON(t, rec, &resp)

			if resp.WorkspaceURL != tc.expectedWorkspaceURL {
				t.Errorf("WorkspaceURL = %q, want %q", resp.WorkspaceURL, tc.expectedWorkspaceURL)
			}
			if resp.BaseDomain != tc.expectedBaseDomain {
				t.Errorf("BaseDomain = %q, want %q", resp.BaseDomain, tc.expectedBaseDomain)
			}
		})
	}
}

// TestMcpNetworkInfo_WorkspaceRouteMismatch verifies that a mismatch between the
// X-SAM-Workspace-Id header and the path workspaceId returns 403.
func TestMcpNetworkInfo_WorkspaceRouteMismatch(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	cookie := injectSession(t, s.sessionManager, "ws-001")

	req := httptest.NewRequest(http.MethodGet, "/workspaces/ws-001/mcp/network-info", nil)
	req.SetPathValue("workspaceId", "ws-001")
	req.Header.Set("X-SAM-Workspace-Id", "ws-OTHER") // deliberate mismatch
	req.AddCookie(cookie)

	rec := httptest.NewRecorder()
	s.handleMcpNetworkInfo(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for workspace route mismatch, got %d (body: %s)", rec.Code, rec.Body.String())
	}
}

// ---------- POST /workspaces/{workspaceId}/mcp/expose-port ----------

func TestMcpExposePort_AuthRejection(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	rec := mcpPOST(t, s, "/workspaces/ws-001/mcp/expose-port", "ws-001", false,
		McpExposePortRequest{Port: 3000}, s.handleMcpExposePort)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestMcpExposePort_InvalidPort_Zero(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	rec := mcpPOST(t, s, "/workspaces/ws-001/mcp/expose-port", "ws-001", true,
		McpExposePortRequest{Port: 0}, s.handleMcpExposePort)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for port=0, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	var errResp map[string]string
	decodeJSON(t, rec, &errResp)
	if !strings.Contains(errResp["error"], "port must be between") {
		t.Errorf("expected port range error, got %q", errResp["error"])
	}
}

func TestMcpExposePort_InvalidPort_TooHigh(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	rec := mcpPOST(t, s, "/workspaces/ws-001/mcp/expose-port", "ws-001", true,
		McpExposePortRequest{Port: 99999}, s.handleMcpExposePort)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for port=99999, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	var errResp map[string]string
	decodeJSON(t, rec, &errResp)
	if !strings.Contains(errResp["error"], "port must be between") {
		t.Errorf("expected port range error, got %q", errResp["error"])
	}
}

func TestMcpExposePort_InvalidPort_Negative(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	rec := mcpPOST(t, s, "/workspaces/ws-001/mcp/expose-port", "ws-001", true,
		McpExposePortRequest{Port: -1}, s.handleMcpExposePort)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for port=-1, got %d", rec.Code)
	}
}

func TestMcpExposePort_HappyPath_NoScanner(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	// No scanner registered — port is not detected as listening.
	rec := mcpPOST(t, s, "/workspaces/ws-001/mcp/expose-port", "ws-001", true,
		McpExposePortRequest{Port: 3000, Label: "dev server"}, s.handleMcpExposePort)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	var resp McpExposePortResponse
	decodeJSON(t, rec, &resp)

	if resp.Port != 3000 {
		t.Errorf("Port = %d, want 3000", resp.Port)
	}
	if resp.ExternalURL != "https://ws-ws-001--3000.example.com" {
		t.Errorf("ExternalURL = %q, want https://ws-ws-001--3000.example.com", resp.ExternalURL)
	}
	if resp.Listening {
		t.Error("expected Listening=false when no scanner registered")
	}
	if resp.Label != "dev server" {
		t.Errorf("Label = %q, want 'dev server'", resp.Label)
	}
}

func TestMcpExposePort_HappyPath_ScannerEmptyNoPorts(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	// Register an empty scanner (no ports detected).
	scanner := ports.NewScanner(ports.ScannerConfig{
		Enabled:  true,
		Interval: 24 * time.Hour,
	})

	s.portScannerMu.Lock()
	s.portScanners["ws-001"] = scanner
	s.portScannerMu.Unlock()

	rec := mcpPOST(t, s, "/workspaces/ws-001/mcp/expose-port", "ws-001", true,
		McpExposePortRequest{Port: 3000}, s.handleMcpExposePort)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	var resp McpExposePortResponse
	decodeJSON(t, rec, &resp)

	if resp.Listening {
		t.Error("expected Listening=false when scanner has no open ports")
	}
	if resp.Port != 3000 {
		t.Errorf("Port = %d, want 3000", resp.Port)
	}
	if resp.ExternalURL != "https://ws-ws-001--3000.example.com" {
		t.Errorf("ExternalURL = %q, want https://ws-ws-001--3000.example.com", resp.ExternalURL)
	}
}

func TestMcpExposePort_InvalidBody(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	cookie := injectSession(t, s.sessionManager, "ws-001")

	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws-001/mcp/expose-port",
		strings.NewReader("{not-json}"))
	req.Header.Set("Content-Type", "application/json")
	req.SetPathValue("workspaceId", "ws-001")
	req.AddCookie(cookie)

	rec := httptest.NewRecorder()
	s.handleMcpExposePort(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid JSON body, got %d", rec.Code)
	}
}

// TestMcpExposePort_ValidPortBoundary verifies that the minimum (1) and maximum
// (65535) valid port values are accepted and return 200.
func TestMcpExposePort_ValidPortBoundary(t *testing.T) {
	t.Parallel()

	for _, port := range []int{1, 65535} {
		port := port
		t.Run("boundary port", func(t *testing.T) {
			t.Parallel()
			s := mcpTestServer(t, "https://api.example.com")
			rec := mcpPOST(t, s, "/workspaces/ws-001/mcp/expose-port", "ws-001", true,
				McpExposePortRequest{Port: port}, s.handleMcpExposePort)

			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200 for port %d (boundary), got %d (body: %s)",
					port, rec.Code, rec.Body.String())
			}

			var resp McpExposePortResponse
			decodeJSON(t, rec, &resp)
			if resp.Port != port {
				t.Errorf("Port = %d, want %d", resp.Port, port)
			}
		})
	}
}

// TestMcpExposePort_ExternalURLFormat verifies the external URL embeds the workspace
// ID (lowercased) and the port number in the expected pattern.
func TestMcpExposePort_ExternalURLFormat(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.sammy.party")

	rec := mcpPOST(t, s, "/workspaces/ws-ABC/mcp/expose-port", "ws-ABC", true,
		McpExposePortRequest{Port: 5173}, s.handleMcpExposePort)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var resp McpExposePortResponse
	decodeJSON(t, rec, &resp)

	want := "https://ws-ws-ABC--5173.sammy.party"
	if resp.ExternalURL != want {
		t.Errorf("ExternalURL = %q, want %q", resp.ExternalURL, want)
	}
}

// ---------- GET /workspaces/{workspaceId}/mcp/cost-estimate ----------

func TestMcpCostEstimate_AuthRejection(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	rec := mcpGET(t, s, "/workspaces/ws-001/mcp/cost-estimate", "ws-001", false, s.handleMcpCostEstimate)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestMcpCostEstimate_HappyPath_NoRuntime(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	// No workspace runtime registered — uptime defaults to 0.
	rec := mcpGET(t, s, "/workspaces/ws-none/mcp/cost-estimate", "ws-none", true, s.handleMcpCostEstimate)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	var resp McpCostEstimateResponse
	decodeJSON(t, rec, &resp)

	if resp.UptimeSecs != 0 {
		t.Errorf("expected UptimeSecs=0 when no runtime, got %f", resp.UptimeSecs)
	}
	if resp.TotalCost != 0 {
		t.Errorf("expected TotalCost=0 when no runtime, got %f", resp.TotalCost)
	}
	if resp.Currency != "USD" {
		t.Errorf("expected Currency=USD, got %q", resp.Currency)
	}
	if resp.VMSize != "small" {
		t.Errorf("expected VMSize=small (default), got %q", resp.VMSize)
	}
}

func TestMcpCostEstimate_HappyPath_WithRuntime(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	// Workspace created approximately 30 minutes ago.
	createdAt := time.Now().Add(-30 * time.Minute)
	s.workspaces["ws-001"] = &WorkspaceRuntime{
		ID:        "ws-001",
		Status:    "running",
		CreatedAt: createdAt,
	}

	rec := mcpGET(t, s, "/workspaces/ws-001/mcp/cost-estimate", "ws-001", true, s.handleMcpCostEstimate)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	var resp McpCostEstimateResponse
	decodeJSON(t, rec, &resp)

	// Uptime should be approximately 30 minutes (allow generous ±2 min tolerance).
	expectedSecs := 30 * 60.0
	tolerance := 120.0
	if resp.UptimeSecs < expectedSecs-tolerance || resp.UptimeSecs > expectedSecs+tolerance {
		t.Errorf("UptimeSecs = %f, expected ~%f (±%f)", resp.UptimeSecs, expectedSecs, tolerance)
	}

	if resp.VMSize != "small" {
		t.Errorf("VMSize = %q, want 'small'", resp.VMSize)
	}
	if resp.HourlyRate != defaultVMPricing["small"] {
		t.Errorf("HourlyRate = %f, want %f", resp.HourlyRate, defaultVMPricing["small"])
	}

	// TotalCost = hourlyRate * uptimeHrs
	expectedCost := resp.HourlyRate * resp.UptimeHrs
	if resp.TotalCost != expectedCost {
		t.Errorf("TotalCost = %f, want hourlyRate(%f) * uptimeHrs(%f) = %f",
			resp.TotalCost, resp.HourlyRate, resp.UptimeHrs, expectedCost)
	}

	if resp.Currency != "USD" {
		t.Errorf("Currency = %q, want USD", resp.Currency)
	}
}

// TestMcpCostEstimate_UsesCreatedAtForUptime verifies that the handler derives
// uptime from runtime.CreatedAt and not from any other source (e.g. /proc/uptime).
func TestMcpCostEstimate_UsesCreatedAtForUptime(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	createdAt := time.Now().Add(-1 * time.Hour)
	s.workspaces["ws-001"] = &WorkspaceRuntime{
		ID:        "ws-001",
		Status:    "running",
		CreatedAt: createdAt,
	}

	rec := mcpGET(t, s, "/workspaces/ws-001/mcp/cost-estimate", "ws-001", true, s.handleMcpCostEstimate)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var resp McpCostEstimateResponse
	decodeJSON(t, rec, &resp)

	// One hour ± 30 second tolerance.
	const oneHourSecs = 3600.0
	const tolerance = 30.0
	if resp.UptimeSecs < oneHourSecs-tolerance || resp.UptimeSecs > oneHourSecs+tolerance {
		t.Errorf("UptimeSecs = %f, expected ~%f (±%f) — handler must use runtime.CreatedAt",
			resp.UptimeSecs, oneHourSecs, tolerance)
	}
	if resp.UptimeHrs < 0.99 || resp.UptimeHrs > 1.01 {
		t.Errorf("UptimeHrs = %f, expected ~1.0 — handler must use runtime.CreatedAt",
			resp.UptimeHrs)
	}
}

// TestMcpCostEstimate_CostMathConsistency verifies that TotalCost = HourlyRate * UptimeHrs.
func TestMcpCostEstimate_CostMathConsistency(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	s.workspaces["ws-001"] = &WorkspaceRuntime{
		ID:        "ws-001",
		Status:    "running",
		CreatedAt: time.Now().Add(-2 * time.Hour),
	}

	rec := mcpGET(t, s, "/workspaces/ws-001/mcp/cost-estimate", "ws-001", true, s.handleMcpCostEstimate)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var resp McpCostEstimateResponse
	decodeJSON(t, rec, &resp)

	// Verify UptimeHrs = UptimeSecs / 3600
	expectedHrs := resp.UptimeSecs / 3600.0
	if abs(resp.UptimeHrs-expectedHrs) > 0.001 {
		t.Errorf("UptimeHrs = %f, want UptimeSecs/3600 = %f", resp.UptimeHrs, expectedHrs)
	}

	// Verify TotalCost = HourlyRate * UptimeHrs
	expectedCost := resp.HourlyRate * resp.UptimeHrs
	if abs(resp.TotalCost-expectedCost) > 0.000001 {
		t.Errorf("TotalCost = %f, want HourlyRate*UptimeHrs = %f", resp.TotalCost, expectedCost)
	}
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

// ---------- GET /workspaces/{workspaceId}/mcp/diff-summary ----------

func TestMcpDiffSummary_AuthRejection(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	rec := mcpGET(t, s, "/workspaces/ws-001/mcp/diff-summary", "ws-001", false, s.handleMcpDiffSummary)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestMcpDiffSummary_WorkspaceNotFound(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	rec := mcpGET(t, s, "/workspaces/ws-missing/mcp/diff-summary", "ws-missing", true, s.handleMcpDiffSummary)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for missing workspace, got %d", rec.Code)
	}

	var errResp map[string]string
	decodeJSON(t, rec, &errResp)
	if !strings.Contains(errResp["error"], "workspace not found") {
		t.Errorf("expected 'workspace not found' in error, got %q", errResp["error"])
	}
}

func TestMcpDiffSummary_WorkspaceNotRunning(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	s.workspaces["ws-stopped"] = &WorkspaceRuntime{
		ID:     "ws-stopped",
		Status: "stopped",
	}

	rec := mcpGET(t, s, "/workspaces/ws-stopped/mcp/diff-summary", "ws-stopped", true, s.handleMcpDiffSummary)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for non-running workspace, got %d", rec.Code)
	}
}

func TestMcpDiffSummary_ContainerModeDisabled(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")
	s.config.ContainerMode = false

	s.workspaces["ws-001"] = &WorkspaceRuntime{
		ID:     "ws-001",
		Status: "running",
	}

	rec := mcpGET(t, s, "/workspaces/ws-001/mcp/diff-summary", "ws-001", true, s.handleMcpDiffSummary)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 when container mode disabled, got %d", rec.Code)
	}
}

// ---------- parseShortstat unit tests ----------

func TestParseShortstat_FullLine(t *testing.T) {
	t.Parallel()

	resp := &McpDiffSummaryResponse{}
	parseShortstat("3 files changed, 10 insertions(+), 5 deletions(-)", resp)

	if resp.FilesChanged != 3 {
		t.Errorf("FilesChanged = %d, want 3", resp.FilesChanged)
	}
	if resp.Insertions != 10 {
		t.Errorf("Insertions = %d, want 10", resp.Insertions)
	}
	if resp.Deletions != 5 {
		t.Errorf("Deletions = %d, want 5", resp.Deletions)
	}
}

func TestParseShortstat_InsertionsOnly(t *testing.T) {
	t.Parallel()

	resp := &McpDiffSummaryResponse{}
	parseShortstat("1 file changed, 7 insertions(+)", resp)

	if resp.FilesChanged != 1 {
		t.Errorf("FilesChanged = %d, want 1", resp.FilesChanged)
	}
	if resp.Insertions != 7 {
		t.Errorf("Insertions = %d, want 7", resp.Insertions)
	}
	if resp.Deletions != 0 {
		t.Errorf("Deletions = %d, want 0", resp.Deletions)
	}
}

func TestParseShortstat_DeletionsOnly(t *testing.T) {
	t.Parallel()

	resp := &McpDiffSummaryResponse{}
	parseShortstat("2 files changed, 3 deletions(-)", resp)

	if resp.FilesChanged != 2 {
		t.Errorf("FilesChanged = %d, want 2", resp.FilesChanged)
	}
	if resp.Insertions != 0 {
		t.Errorf("Insertions = %d, want 0", resp.Insertions)
	}
	if resp.Deletions != 3 {
		t.Errorf("Deletions = %d, want 3", resp.Deletions)
	}
}

func TestParseShortstat_EmptyLine(t *testing.T) {
	t.Parallel()

	resp := &McpDiffSummaryResponse{}
	parseShortstat("", resp)

	if resp.FilesChanged != 0 || resp.Insertions != 0 || resp.Deletions != 0 {
		t.Errorf("expected all zeros for empty input, got %+v", resp)
	}
}

func TestParseShortstat_LargeNumbers(t *testing.T) {
	t.Parallel()

	resp := &McpDiffSummaryResponse{}
	parseShortstat("100 files changed, 5000 insertions(+), 2500 deletions(-)", resp)

	if resp.FilesChanged != 100 {
		t.Errorf("FilesChanged = %d, want 100", resp.FilesChanged)
	}
	if resp.Insertions != 5000 {
		t.Errorf("Insertions = %d, want 5000", resp.Insertions)
	}
	if resp.Deletions != 2500 {
		t.Errorf("Deletions = %d, want 2500", resp.Deletions)
	}
}

func TestParseShortstat_SingleFileChange(t *testing.T) {
	t.Parallel()

	resp := &McpDiffSummaryResponse{}
	parseShortstat("1 file changed", resp)

	if resp.FilesChanged != 1 {
		t.Errorf("FilesChanged = %d, want 1", resp.FilesChanged)
	}
	if resp.Insertions != 0 {
		t.Errorf("Insertions = %d, want 0", resp.Insertions)
	}
	if resp.Deletions != 0 {
		t.Errorf("Deletions = %d, want 0", resp.Deletions)
	}
}

func TestParseShortstat_MalformedInput(t *testing.T) {
	t.Parallel()

	resp := &McpDiffSummaryResponse{}
	// Non-numeric first token — should be silently ignored.
	parseShortstat("many files changed, lots of things", resp)

	// Nothing should crash; values remain at zero.
	if resp.FilesChanged != 0 || resp.Insertions != 0 || resp.Deletions != 0 {
		t.Errorf("expected all zeros for non-numeric input, got %+v", resp)
	}
}
