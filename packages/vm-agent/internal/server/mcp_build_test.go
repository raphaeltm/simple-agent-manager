package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ---------- POST /workspaces/{workspaceId}/mcp/build-and-publish ----------
//
// These tests cover the deterministic validation branches of
// handleMcpBuildAndPublish only. The happy path is intentionally NOT exercised
// here: publish.Build shells out to `docker compose build`/`config`/`image
// inspect` on the host daemon, which is not available in unit tests. Build/push
// behavior is covered by the publish package's orchestrator tests and verified
// end-to-end on staging.

func TestMcpBuildAndPublish_MissingWorkspaceID(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	// Empty workspaceId path value is rejected before auth runs.
	req := httptest.NewRequest(http.MethodPost, "/workspaces//mcp/build-and-publish", nil)
	req.SetPathValue("workspaceId", "")

	rec := httptest.NewRecorder()
	s.handleMcpBuildAndPublish(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty workspaceId, got %d (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestMcpBuildAndPublish_AuthRejection(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	rec := mcpPOST(t, s, "/workspaces/ws-001/mcp/build-and-publish", "ws-001", false,
		McpBuildAndPublishRequest{}, s.handleMcpBuildAndPublish)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestMcpBuildAndPublish_InvalidBody(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	cookie := injectSession(t, s.sessionManager, "ws-001")

	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws-001/mcp/build-and-publish",
		strings.NewReader("{not-json}"))
	req.Header.Set("Content-Type", "application/json")
	req.SetPathValue("workspaceId", "ws-001")
	req.AddCookie(cookie)

	rec := httptest.NewRecorder()
	s.handleMcpBuildAndPublish(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid JSON body, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	var errResp map[string]string
	decodeJSON(t, rec, &errResp)
	if !strings.Contains(errResp["error"], "invalid request body") {
		t.Errorf("expected 'invalid request body' in error, got %q", errResp["error"])
	}
}

func TestMcpBuildAndPublish_WorkspaceNotFound(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	// No workspace registered.
	rec := mcpPOST(t, s, "/workspaces/ws-missing/mcp/build-and-publish", "ws-missing", true,
		McpBuildAndPublishRequest{}, s.handleMcpBuildAndPublish)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for missing workspace, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	var errResp map[string]string
	decodeJSON(t, rec, &errResp)
	if !strings.Contains(errResp["error"], "workspace not found") {
		t.Errorf("expected 'workspace not found' in error, got %q", errResp["error"])
	}
}

func TestMcpBuildAndPublish_MissingWorkspaceDir(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	// Workspace exists but has no cloned repository path.
	s.workspaces["ws-001"] = &WorkspaceRuntime{
		ID:            "ws-001",
		Status:        "running",
		ProjectID:     "proj-1",
		CallbackToken: "tok",
	}

	rec := mcpPOST(t, s, "/workspaces/ws-001/mcp/build-and-publish", "ws-001", true,
		McpBuildAndPublishRequest{}, s.handleMcpBuildAndPublish)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for missing workspaceDir, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	var errResp map[string]string
	decodeJSON(t, rec, &errResp)
	if !strings.Contains(errResp["error"], "workspace has no cloned repository path") {
		t.Errorf("expected cloned-repository-path error, got %q", errResp["error"])
	}
}

func TestMcpBuildAndPublish_MissingProjectID(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")
	// Ensure the config-level fallback projectID is also empty so the runtime
	// value is the only source.
	s.config.ProjectID = ""

	s.workspaces["ws-001"] = &WorkspaceRuntime{
		ID:            "ws-001",
		Status:        "running",
		WorkspaceDir:  "/workspace/WS_001",
		CallbackToken: "tok",
	}

	rec := mcpPOST(t, s, "/workspaces/ws-001/mcp/build-and-publish", "ws-001", true,
		McpBuildAndPublishRequest{}, s.handleMcpBuildAndPublish)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for missing projectID, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	var errResp map[string]string
	decodeJSON(t, rec, &errResp)
	if !strings.Contains(errResp["error"], "workspace is not linked to a project") {
		t.Errorf("expected project-link error, got %q", errResp["error"])
	}
}

func TestMcpBuildAndPublish_MissingCallbackToken(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	s.workspaces["ws-001"] = &WorkspaceRuntime{
		ID:           "ws-001",
		Status:       "running",
		WorkspaceDir: "/workspace/WS_001",
		ProjectID:    "proj-1",
	}

	rec := mcpPOST(t, s, "/workspaces/ws-001/mcp/build-and-publish", "ws-001", true,
		McpBuildAndPublishRequest{}, s.handleMcpBuildAndPublish)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for missing callback token, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	var errResp map[string]string
	decodeJSON(t, rec, &errResp)
	if !strings.Contains(errResp["error"], "workspace has no callback token") {
		t.Errorf("expected callback-token error, got %q", errResp["error"])
	}
}

// TestMcpBuildAndPublish_ProjectIDFallsBackToConfig verifies the runtime
// projectID is optional when the node-level config carries one — the handler
// then proceeds past the project check (and fails later at the docker-dependent
// build step, which is not reachable in unit tests, so we only assert it did NOT
// fail with the project-link error).
func TestMcpBuildAndPublish_ProjectIDFallsBackToConfig(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")
	s.config.ProjectID = "proj-from-config"

	s.workspaces["ws-001"] = &WorkspaceRuntime{
		ID:           "ws-001",
		Status:       "running",
		WorkspaceDir: "/workspace/WS_001",
		// No runtime ProjectID — must fall back to config.
		CallbackToken: "tok",
	}

	rec := mcpPOST(t, s, "/workspaces/ws-001/mcp/build-and-publish", "ws-001", true,
		McpBuildAndPublishRequest{}, s.handleMcpBuildAndPublish)

	// The build step shells out to docker and will fail in CI/unit env, but the
	// failure must be a build failure, NOT the project-link validation error.
	var errResp map[string]string
	decodeJSON(t, rec, &errResp)
	if strings.Contains(errResp["error"], "workspace is not linked to a project") {
		t.Errorf("config projectID should satisfy the project check, got %q", errResp["error"])
	}
}
