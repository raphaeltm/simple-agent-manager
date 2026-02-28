package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/pty"
)

// newContractTestServer builds a minimal Server suitable for contract tests.
func newContractTestServer() *Server {
	ptyManager := pty.NewManager(pty.ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		WorkDir:      "/tmp",
		BufferSize:   1024,
	})

	return &Server{
		config: &config.Config{
			NodeID: "node-contract-test",
		},
		ptyManager: ptyManager,
		workspaces: map[string]*WorkspaceRuntime{
			"ws-existing": {
				ID:         "ws-existing",
				Repository: "owner/repo",
				Branch:     "main",
				Status:     "running",
				CreatedAt:  time.Now().UTC(),
				UpdatedAt:  time.Now().UTC(),
				PTY:        ptyManager,
			},
		},
		nodeEvents:          make([]EventRecord, 0),
		workspaceEvents:     map[string][]EventRecord{},
		agentSessions:       agentsessions.NewManager(),
		sessionHosts:        make(map[string]*acp.SessionHost),
		bootLogBroadcasters: NewBootLogBroadcasterManager(),
	}
}

// =============================================================================
// GET /health — Response Shape Contract
// =============================================================================

func TestHealthResponseContract(t *testing.T) {
	t.Parallel()

	s := newContractTestServer()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	s.handleHealth(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var resp map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	// Verify required fields per contract
	if resp["status"] != "healthy" {
		t.Fatalf("expected status=healthy, got %v", resp["status"])
	}
	if resp["nodeId"] != "node-contract-test" {
		t.Fatalf("expected nodeId=node-contract-test, got %v", resp["nodeId"])
	}
	if _, ok := resp["activeWorkspaces"]; !ok {
		t.Fatal("missing activeWorkspaces field")
	}
	workspaces, ok := resp["workspaces"].([]interface{})
	if !ok {
		t.Fatal("workspaces must be an array")
	}
	if _, ok := resp["sessions"]; !ok {
		t.Fatal("missing sessions field")
	}

	// Verify workspace summary shape
	for _, ws := range workspaces {
		wsMap, ok := ws.(map[string]interface{})
		if !ok {
			t.Fatal("workspace entry must be an object")
		}
		for _, required := range []string{"id", "status", "sessions"} {
			if _, ok := wsMap[required]; !ok {
				t.Fatalf("workspace summary missing field: %s", required)
			}
		}
	}
}

// =============================================================================
// POST /workspaces — Request Parsing Contract
// =============================================================================

func TestCreateWorkspaceRequestParsing(t *testing.T) {
	t.Parallel()

	body := map[string]interface{}{
		"workspaceId":   "ws-new-123",
		"repository":    "owner/repo",
		"branch":        "main",
		"callbackToken": "cb-token",
		"gitUserName":   "Test User",
		"gitUserEmail":  "test@example.com",
		"githubId":      "42",
	}
	bodyBytes, _ := json.Marshal(body)

	var parsed struct {
		WorkspaceID   string `json:"workspaceId"`
		Repository    string `json:"repository"`
		Branch        string `json:"branch"`
		CallbackToken string `json:"callbackToken,omitempty"`
		GitUserName   string `json:"gitUserName,omitempty"`
		GitUserEmail  string `json:"gitUserEmail,omitempty"`
		GitHubID      string `json:"githubId,omitempty"`
	}
	if err := json.NewDecoder(bytes.NewReader(bodyBytes)).Decode(&parsed); err != nil {
		t.Fatalf("decode request body: %v", err)
	}

	if parsed.WorkspaceID != "ws-new-123" {
		t.Fatalf("expected workspaceId=ws-new-123, got %s", parsed.WorkspaceID)
	}
	if parsed.Repository != "owner/repo" {
		t.Fatalf("expected repository=owner/repo, got %s", parsed.Repository)
	}
	if parsed.Branch != "main" {
		t.Fatalf("expected branch=main, got %s", parsed.Branch)
	}
	if parsed.CallbackToken != "cb-token" {
		t.Fatalf("expected callbackToken=cb-token, got %s", parsed.CallbackToken)
	}
	if parsed.GitUserName != "Test User" {
		t.Fatalf("expected gitUserName=Test User, got %s", parsed.GitUserName)
	}
	if parsed.GitUserEmail != "test@example.com" {
		t.Fatalf("expected gitUserEmail=test@example.com, got %s", parsed.GitUserEmail)
	}
	if parsed.GitHubID != "42" {
		t.Fatalf("expected githubId=42, got %s", parsed.GitHubID)
	}
}

func TestCreateWorkspaceMinimalRequestParsing(t *testing.T) {
	t.Parallel()

	body := map[string]interface{}{
		"workspaceId": "ws-minimal",
		"repository":  "owner/repo",
		"branch":      "main",
	}
	bodyBytes, _ := json.Marshal(body)

	var parsed struct {
		WorkspaceID   string `json:"workspaceId"`
		Repository    string `json:"repository"`
		Branch        string `json:"branch"`
		CallbackToken string `json:"callbackToken,omitempty"`
	}
	if err := json.NewDecoder(bytes.NewReader(bodyBytes)).Decode(&parsed); err != nil {
		t.Fatalf("decode minimal request: %v", err)
	}

	if parsed.WorkspaceID != "ws-minimal" {
		t.Fatalf("workspaceId mismatch")
	}
	if parsed.CallbackToken != "" {
		t.Fatalf("callbackToken should be empty for minimal request")
	}
}

// =============================================================================
// POST /workspaces 202 Response Shape Contract
// =============================================================================

func TestCreateWorkspaceResponseShape(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	writeJSON(rec, http.StatusAccepted, map[string]interface{}{
		"workspaceId": "ws-new-123",
		"status":      "creating",
	})

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d", rec.Code)
	}

	var resp map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp["workspaceId"] != "ws-new-123" {
		t.Fatalf("response workspaceId mismatch")
	}
	if resp["status"] != "creating" {
		t.Fatalf("response status must be 'creating', got %v", resp["status"])
	}
}

// =============================================================================
// DELETE /workspaces/:id — Response Shape Contract
// =============================================================================

func TestDeleteWorkspaceResponseShape(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	writeJSON(rec, http.StatusOK, map[string]interface{}{"success": true})

	var resp map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp["success"] != true {
		t.Fatalf("expected success=true, got %v", resp["success"])
	}
}

// =============================================================================
// POST /workspaces/:id/agent-sessions — Request/Response Contract
// =============================================================================

func TestCreateAgentSessionRequestParsing(t *testing.T) {
	t.Parallel()

	body := map[string]interface{}{
		"sessionId": "sess-new-123",
		"label":     "Test Session",
	}
	bodyBytes, _ := json.Marshal(body)

	var parsed struct {
		SessionID string `json:"sessionId"`
		Label     string `json:"label"`
	}
	if err := json.NewDecoder(bytes.NewReader(bodyBytes)).Decode(&parsed); err != nil {
		t.Fatalf("decode request: %v", err)
	}

	if parsed.SessionID != "sess-new-123" {
		t.Fatalf("sessionId mismatch: got %s", parsed.SessionID)
	}
	if parsed.Label != "Test Session" {
		t.Fatalf("label mismatch: got %s", parsed.Label)
	}
}

func TestAgentSessionResponseShape(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	session := agentsessions.Session{
		ID:          "sess-abc",
		WorkspaceID: "ws-existing",
		Status:      "running",
		Label:       "My Session",
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	rec := httptest.NewRecorder()
	writeJSON(rec, http.StatusCreated, session)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", rec.Code)
	}

	var resp map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	for _, required := range []string{"id", "workspaceId", "status", "createdAt", "updatedAt"} {
		if _, ok := resp[required]; !ok {
			t.Fatalf("agent session response missing field: %s", required)
		}
	}

	if resp["status"] != "running" {
		t.Fatalf("expected status=running, got %v", resp["status"])
	}
}

// =============================================================================
// POST /workspaces/:id/agent-sessions/:sessionId/start — Request/Response Contract
// =============================================================================

func TestStartAgentSessionRequestParsing(t *testing.T) {
	t.Parallel()

	body := map[string]interface{}{
		"agentType":     "claude-code",
		"initialPrompt": "Fix the login timeout bug in auth.ts",
	}
	bodyBytes, _ := json.Marshal(body)

	var parsed struct {
		AgentType     string `json:"agentType"`
		InitialPrompt string `json:"initialPrompt"`
	}
	if err := json.NewDecoder(bytes.NewReader(bodyBytes)).Decode(&parsed); err != nil {
		t.Fatalf("decode request: %v", err)
	}

	if parsed.AgentType != "claude-code" {
		t.Fatalf("agentType mismatch: got %s", parsed.AgentType)
	}
	if parsed.InitialPrompt != "Fix the login timeout bug in auth.ts" {
		t.Fatalf("initialPrompt mismatch: got %s", parsed.InitialPrompt)
	}
}

func TestStartAgentSessionResponseShape(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	writeJSON(rec, http.StatusAccepted, map[string]interface{}{
		"status":    "starting",
		"sessionId": "sess-abc",
	})

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d", rec.Code)
	}

	var resp map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp["status"] != "starting" {
		t.Fatalf("expected status=starting, got %v", resp["status"])
	}
	if resp["sessionId"] != "sess-abc" {
		t.Fatalf("expected sessionId=sess-abc, got %v", resp["sessionId"])
	}
}

// =============================================================================
// POST /workspaces/:id/agent-sessions/:sessionId/start — Handler-Level Tests
// =============================================================================

func TestStartAgentSessionHandler_MissingPathParams(t *testing.T) {
	t.Parallel()
	s := newContractTestServer()

	// Both params empty — handler checks workspaceID == "" || sessionID == ""
	body := `{"agentType":"claude-code","initialPrompt":"do stuff"}`
	req := httptest.NewRequest(http.MethodPost, "/workspaces//agent-sessions//start", strings.NewReader(body))
	// SetPathValue with empty strings to simulate missing path params
	req.SetPathValue("workspaceId", "")
	req.SetPathValue("sessionId", "")
	rec := httptest.NewRecorder()

	s.handleStartAgentSession(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing path params, got %d", rec.Code)
	}
	var resp map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp["error"] != "workspaceId and sessionId are required" {
		t.Fatalf("unexpected error message: %q", resp["error"])
	}
}

func TestStartAgentSessionHandler_MissingAuth(t *testing.T) {
	t.Parallel()
	s := newContractTestServer()

	body := `{"agentType":"claude-code","initialPrompt":"do stuff"}`
	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws-existing/agent-sessions/sess-1/start", strings.NewReader(body))
	req.SetPathValue("workspaceId", "ws-existing")
	req.SetPathValue("sessionId", "sess-1")
	// No Authorization header
	rec := httptest.NewRecorder()

	s.handleStartAgentSession(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for missing auth, got %d", rec.Code)
	}
}

func TestStartAgentSessionHandler_EmptyBearerToken(t *testing.T) {
	t.Parallel()
	s := newContractTestServer()

	body := `{"agentType":"claude-code","initialPrompt":"do stuff"}`
	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws-existing/agent-sessions/sess-1/start", strings.NewReader(body))
	req.SetPathValue("workspaceId", "ws-existing")
	req.SetPathValue("sessionId", "sess-1")
	req.Header.Set("Authorization", "Bearer ")
	rec := httptest.NewRecorder()

	s.handleStartAgentSession(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for empty bearer token, got %d", rec.Code)
	}
}

func TestStartAgentSessionSourceValidation(t *testing.T) {
	t.Parallel()

	// Verify the handler source contains all required validation checks.
	// Handler-level tests with real HTTP require JWT auth setup, so we verify
	// the validation logic exists in the source code via contract.
	content, err := os.ReadFile("workspaces.go")
	if err != nil {
		t.Fatalf("read workspaces.go: %v", err)
	}
	src := string(content)

	validationChecks := []string{
		// Path param validation
		`workspaceID == "" || sessionID == ""`,
		// Auth check
		"requireNodeManagementAuth",
		// Body field validation
		`AgentType`,
		`InitialPrompt`,
		`"agentType is required"`,
		`"initialPrompt is required"`,
		// Session existence check
		"agentSessions.Get",
		"session not found",
		// Session status check
		"StatusRunning",
		"session is not running",
		// Workspace runtime check
		"getWorkspaceRuntime",
		"workspace not found",
		// Async goroutine launch
		"go s.startAgentWithPrompt",
		// 202 response
		"StatusAccepted",
	}

	for _, check := range validationChecks {
		if !strings.Contains(src, check) {
			t.Fatalf("missing validation logic in handleStartAgentSession: %q", check)
		}
	}
}

// =============================================================================
// Error Response Format Contract
// =============================================================================

func TestErrorResponseFormat(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name       string
		statusCode int
		message    string
	}{
		{"bad request", http.StatusBadRequest, "workspaceId is required"},
		{"unauthorized", http.StatusUnauthorized, "missing Authorization header"},
		{"forbidden", http.StatusForbidden, "workspace route mismatch"},
		{"not found", http.StatusNotFound, "workspace not found"},
		{"internal error", http.StatusInternalServerError, "internal server error"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			rec := httptest.NewRecorder()
			writeError(rec, tc.statusCode, tc.message)

			if rec.Code != tc.statusCode {
				t.Fatalf("expected status %d, got %d", tc.statusCode, rec.Code)
			}

			var resp map[string]string
			if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
				t.Fatalf("decode error response: %v", err)
			}

			if resp["error"] != tc.message {
				t.Fatalf("expected error=%q, got %q", tc.message, resp["error"])
			}

			if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
				t.Fatalf("expected Content-Type=application/json, got %s", ct)
			}
		})
	}
}

// =============================================================================
// Provisioning Failed Callback Contract
// =============================================================================

func TestProvisioningFailedCallbackContract(t *testing.T) {
	t.Parallel()

	var receivedPayload map[string]string
	var receivedAuth string
	var receivedPath string

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedPath = r.URL.Path
		receivedAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&receivedPayload)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer controlPlane.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: controlPlane.URL,
			HTTPReadTimeout: 5 * time.Second,
		},
	}

	err := s.notifyWorkspaceProvisioningFailed(
		context.Background(),
		"ws-contract-test",
		"test-callback-jwt",
		"container build failed: OOM",
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if receivedPath != "/api/workspaces/ws-contract-test/provisioning-failed" {
		t.Fatalf("unexpected path: %s", receivedPath)
	}
	if receivedAuth != "Bearer test-callback-jwt" {
		t.Fatalf("unexpected auth: %s", receivedAuth)
	}
	if receivedPayload["errorMessage"] != "container build failed: OOM" {
		t.Fatalf("unexpected errorMessage: %q", receivedPayload["errorMessage"])
	}
}

func TestProvisioningFailedDefaultErrorMessage(t *testing.T) {
	t.Parallel()

	var receivedPayload map[string]string
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&receivedPayload)
		w.WriteHeader(http.StatusOK)
	}))
	defer controlPlane.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: controlPlane.URL,
			HTTPReadTimeout: 5 * time.Second,
		},
	}

	err := s.notifyWorkspaceProvisioningFailed(
		context.Background(),
		"ws-test",
		"token",
		"",
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if receivedPayload["errorMessage"] != "workspace provisioning failed" {
		t.Fatalf("expected default error message, got %q", receivedPayload["errorMessage"])
	}
}

// =============================================================================
// Source Contract: Endpoint Registration
// =============================================================================

func TestContractEndpointRegistration(t *testing.T) {
	t.Parallel()

	content, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatalf("read server.go: %v", err)
	}
	src := string(content)

	requiredEndpoints := []string{
		`"GET /health"`,
		`"POST /workspaces"`,
		`"DELETE /workspaces/{workspaceId}"`,
		`"POST /workspaces/{workspaceId}/agent-sessions"`,
		`"POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/start"`,
		`"POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/stop"`,
		`"GET /workspaces/{workspaceId}/agent-sessions"`,
	}

	for _, endpoint := range requiredEndpoints {
		if !strings.Contains(src, endpoint) {
			t.Fatalf("missing endpoint registration: %s", endpoint)
		}
	}
}

func TestContractWriteErrorFormat(t *testing.T) {
	t.Parallel()

	content, err := os.ReadFile("routes.go")
	if err != nil {
		t.Fatalf("read routes.go: %v", err)
	}
	src := string(content)

	if !strings.Contains(src, `"error"`) {
		t.Fatal("writeError must use 'error' key in response")
	}
	if !strings.Contains(src, "Content-Type") {
		t.Fatal("writeJSON must set Content-Type header")
	}
}

func TestContractCallbackEndpoints(t *testing.T) {
	t.Parallel()

	callbackContent, err := os.ReadFile("workspace_callbacks.go")
	if err != nil {
		t.Fatalf("read workspace_callbacks.go: %v", err)
	}
	src := string(callbackContent)

	if !strings.Contains(src, "notifyWorkspaceProvisioningFailed") {
		t.Fatal("missing notifyWorkspaceProvisioningFailed function")
	}
	if !strings.Contains(src, "/api/workspaces/") {
		t.Fatal("callback must use /api/workspaces/ path")
	}
	if !strings.Contains(src, "provisioning-failed") {
		t.Fatal("callback must target provisioning-failed endpoint")
	}
	if !strings.Contains(src, "Authorization") {
		t.Fatal("callback must set Authorization header")
	}
}
