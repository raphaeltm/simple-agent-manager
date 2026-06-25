package server

import (
	"bytes"
	"context"
	"crypto/rsa"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/persistence"
	"github.com/workspace/vm-agent/internal/publish"
)

// ---------- POST /workspaces/{workspaceId}/mcp/build-and-publish ----------
//
// These tests cover the deterministic validation branches of
// handleMcpBuildAndPublish only. The happy path is intentionally NOT exercised
// here: publish.Build shells out to `docker compose build`/`config`/`image
// inspect` on the host daemon, which is not available in unit tests. Build/push
// behavior is covered by the publish package's orchestrator tests and verified
// end-to-end on staging.

func mcpBuildTestServer(t *testing.T) (*Server, *rsa.PrivateKey) {
	t.Helper()
	s := mcpTestServer(t, "https://api.example.com")
	validator, key := newWorkspaceCreateJWTValidator(t, s.config.NodeID)
	s.jwtValidator = validator
	return s, key
}

func validMcpBuildRequest() McpBuildAndPublishRequest {
	return McpBuildAndPublishRequest{
		Environment:   "staging",
		EnvironmentID: "env-1",
	}
}

func mcpBuildPOST(
	t *testing.T,
	s *Server,
	key *rsa.PrivateKey,
	path string,
	workspaceID string,
	body interface{},
) *httptest.ResponseRecorder {
	t.Helper()

	bodyBytes, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("mcpBuildPOST: marshal body: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, key, s.config.NodeID, workspaceID))
	req.Header.Set("X-SAM-Node-Id", s.config.NodeID)
	req.Header.Set("X-SAM-Workspace-Id", workspaceID)
	req.SetPathValue("workspaceId", workspaceID)

	rec := httptest.NewRecorder()
	s.handleMcpBuildAndPublish(rec, req)
	return rec
}

func mcpBuildJobStartPOST(
	t *testing.T,
	s *Server,
	key *rsa.PrivateKey,
	workspaceID string,
	jobID string,
	body interface{},
	ctx context.Context,
) *httptest.ResponseRecorder {
	t.Helper()

	bodyBytes, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("mcpBuildJobStartPOST: marshal body: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/workspaces/"+workspaceID+"/mcp/build-and-publish-jobs/"+jobID+"/start", bytes.NewReader(bodyBytes)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, key, s.config.NodeID, workspaceID))
	req.Header.Set("X-SAM-Node-Id", s.config.NodeID)
	req.Header.Set("X-SAM-Workspace-Id", workspaceID)
	req.SetPathValue("workspaceId", workspaceID)
	req.SetPathValue("jobId", jobID)

	rec := httptest.NewRecorder()
	s.handleMcpBuildAndPublishJobStart(rec, req)
	return rec
}

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

func TestMcpBuildAndPublishJobStart_RequestCancelDoesNotCancelBackgroundJob(t *testing.T) {
	s, key := mcpBuildTestServer(t)
	tmp := t.TempDir()
	t.Setenv("SAM_DOCKER_CLI_PATH", fakeDockerCLI(t, tmp, "", true))
	store, err := persistence.Open(filepath.Join(tmp, "vm-agent.db"))
	if err != nil {
		t.Fatalf("Open persistence store: %v", err)
	}
	defer store.Close()
	s.store = store

	callbacks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/deployment-publish-jobs/job-1/events") {
			t.Errorf("unexpected callback path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer callbacks.Close()
	s.config.ControlPlaneURL = callbacks.URL
	s.workspaces["ws-001"] = &WorkspaceRuntime{
		ID:            "ws-001",
		Status:        "running",
		WorkspaceDir:  "/workspace/WS_001",
		ProjectID:     "proj-1",
		CallbackToken: "callback-token",
	}

	started := make(chan context.Context, 1)
	release := make(chan struct{})
	done := make(chan error, 1)
	s.buildPublishRunner = func(ctx context.Context, _ *preparedBuildPublish, _ publish.EventSink) (*publish.ReleaseResult, error) {
		started <- ctx
		select {
		case <-ctx.Done():
			done <- ctx.Err()
			return nil, ctx.Err()
		case <-release:
			done <- nil
			return &publish.ReleaseResult{ReleaseID: "rel-1", Version: 1, Status: "created"}, nil
		}
	}

	reqCtx, cancelReq := context.WithCancel(context.Background())
	rec := mcpBuildJobStartPOST(t, s, key, "ws-001", "job-1", McpBuildAndPublishRequest{
		PublishJobID:  "job-1",
		Environment:   "staging",
		EnvironmentID: "env-1",
	}, reqCtx)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202 accepted, got %d: %s", rec.Code, rec.Body.String())
	}

	var jobCtx context.Context
	select {
	case jobCtx = <-started:
	case <-time.After(time.Second):
		t.Fatal("background publish runner did not start")
	}

	cancelReq()
	select {
	case err := <-done:
		t.Fatalf("background job stopped after request cancellation: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := jobCtx.Err(); err != nil {
		t.Fatalf("job context should not inherit request cancellation, got %v", err)
	}

	close(release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("background job returned unexpected error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("background job did not finish after release")
	}

	var job *persistence.JobRecord
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		var getErr error
		job, getErr = store.GetJob("job-1")
		if getErr != nil {
			t.Fatalf("GetJob: %v", getErr)
		}
		if job != nil && job.Status == vmJobStatusSucceeded && job.CurrentStep == "succeeded" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if job == nil || job.Status != vmJobStatusSucceeded || job.CurrentStep != "succeeded" {
		t.Fatalf("expected durable succeeded publish job, got %+v", job)
	}
	events, err := store.ListJobEvents("job-1")
	if err != nil {
		t.Fatalf("ListJobEvents: %v", err)
	}
	if len(events) == 0 {
		t.Fatal("expected durable publish job events")
	}
}

func TestMcpBuildAndPublish_AuthRejection(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	rec := mcpPOST(t, s, "/workspaces/ws-001/mcp/build-and-publish", "ws-001", false,
		validMcpBuildRequest(), s.handleMcpBuildAndPublish)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestMcpBuildAndPublish_WorkspaceSessionCookieRejected(t *testing.T) {
	t.Parallel()
	s := mcpTestServer(t, "https://api.example.com")

	rec := mcpPOST(t, s, "/workspaces/ws-001/mcp/build-and-publish", "ws-001", true,
		validMcpBuildRequest(), s.handleMcpBuildAndPublish)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for workspace session cookie, got %d (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestMcpBuildAndPublish_InvalidBody(t *testing.T) {
	t.Parallel()
	s, key := mcpBuildTestServer(t)

	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws-001/mcp/build-and-publish",
		strings.NewReader("{not-json}"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, key, s.config.NodeID, "ws-001"))
	req.Header.Set("X-SAM-Node-Id", s.config.NodeID)
	req.Header.Set("X-SAM-Workspace-Id", "ws-001")
	req.SetPathValue("workspaceId", "ws-001")

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

func TestMcpBuildAndPublish_MissingEnvironment(t *testing.T) {
	t.Parallel()
	s, key := mcpBuildTestServer(t)

	rec := mcpBuildPOST(t, s, key, "/workspaces/ws-001/mcp/build-and-publish", "ws-001",
		McpBuildAndPublishRequest{})

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing environment, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	var errResp map[string]string
	decodeJSON(t, rec, &errResp)
	if !strings.Contains(errResp["error"], "environment is required") {
		t.Errorf("expected environment-required error, got %q", errResp["error"])
	}
}

func TestMcpBuildAndPublish_MissingEnvironmentID(t *testing.T) {
	t.Parallel()
	s, key := mcpBuildTestServer(t)

	rec := mcpBuildPOST(t, s, key, "/workspaces/ws-001/mcp/build-and-publish", "ws-001",
		McpBuildAndPublishRequest{Environment: "staging"})

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing environmentId, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	var errResp map[string]string
	decodeJSON(t, rec, &errResp)
	if !strings.Contains(errResp["error"], "environmentId is required") {
		t.Errorf("expected environmentId-required error, got %q", errResp["error"])
	}
}

func TestMcpBuildAndPublish_WorkspaceNotFound(t *testing.T) {
	t.Parallel()
	s, key := mcpBuildTestServer(t)

	// No workspace registered.
	rec := mcpBuildPOST(t, s, key, "/workspaces/ws-missing/mcp/build-and-publish", "ws-missing",
		validMcpBuildRequest())

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
	s, key := mcpBuildTestServer(t)

	// Workspace exists but has no cloned repository path.
	s.workspaces["ws-001"] = &WorkspaceRuntime{
		ID:            "ws-001",
		Status:        "running",
		ProjectID:     "proj-1",
		CallbackToken: "tok",
	}

	rec := mcpBuildPOST(t, s, key, "/workspaces/ws-001/mcp/build-and-publish", "ws-001",
		validMcpBuildRequest())

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
	s, key := mcpBuildTestServer(t)
	// Ensure the config-level fallback projectID is also empty so the runtime
	// value is the only source.
	s.config.ProjectID = ""

	s.workspaces["ws-001"] = &WorkspaceRuntime{
		ID:            "ws-001",
		Status:        "running",
		WorkspaceDir:  "/workspace/WS_001",
		CallbackToken: "tok",
	}

	rec := mcpBuildPOST(t, s, key, "/workspaces/ws-001/mcp/build-and-publish", "ws-001",
		validMcpBuildRequest())

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
	s, key := mcpBuildTestServer(t)

	s.workspaces["ws-001"] = &WorkspaceRuntime{
		ID:           "ws-001",
		Status:       "running",
		WorkspaceDir: "/workspace/WS_001",
		ProjectID:    "proj-1",
	}

	rec := mcpBuildPOST(t, s, key, "/workspaces/ws-001/mcp/build-and-publish", "ws-001",
		validMcpBuildRequest())

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
	s, key := mcpBuildTestServer(t)
	s.config.ProjectID = "proj-from-config"

	s.workspaces["ws-001"] = &WorkspaceRuntime{
		ID:           "ws-001",
		Status:       "running",
		WorkspaceDir: "/workspace/WS_001",
		// No runtime ProjectID — must fall back to config.
		CallbackToken: "tok",
	}

	rec := mcpBuildPOST(t, s, key, "/workspaces/ws-001/mcp/build-and-publish", "ws-001",
		validMcpBuildRequest())

	// The build step shells out to docker and will fail in CI/unit env, but the
	// failure must be a build failure, NOT the project-link validation error.
	var errResp map[string]string
	decodeJSON(t, rec, &errResp)
	if strings.Contains(errResp["error"], "workspace is not linked to a project") {
		t.Errorf("config projectID should satisfy the project check, got %q", errResp["error"])
	}
}

// ---------- resolveBuildSourceDir ----------
//
// The coding agent's real source lives in the devcontainer's named volume
// (sam-ws-{workspaceId}), not in runtime.WorkspaceDir (a host clone frozen at
// boot). resolveBuildSourceDir must return the volume-backed path so the build
// publishes the agent's committed source — and must fall back to the host clone
// whenever the volume cannot be resolved, so the publish still attempts a build.

// fakeDockerCLI writes an executable shell script that emulates
// `docker volume inspect <name> --format {{.Mountpoint}}` by echoing mountpoint
// (or exiting non-zero when fail is set). Returns its absolute path for use as
// SAM_DOCKER_CLI_PATH.
func fakeDockerCLI(t *testing.T, dir, mountpoint string, fail bool) string {
	t.Helper()
	body := "#!/bin/sh\n"
	if fail {
		body += "exit 1\n"
	} else {
		body += "echo \"" + mountpoint + "\"\n"
	}
	path := filepath.Join(dir, "docker")
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatalf("write fake docker cli: %v", err)
	}
	return path
}

func discardBuildLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestResolveBuildSourceDir_ResolvesFromVolume(t *testing.T) {
	tmp := t.TempDir()
	mountpoint := filepath.Join(tmp, "vol-data")
	repoDir := filepath.Join(mountpoint, "crewai")
	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		t.Fatalf("mkdir repo dir: %v", err)
	}
	t.Setenv("SAM_DOCKER_CLI_PATH", fakeDockerCLI(t, tmp, mountpoint, false))

	s := &Server{}
	rt := &WorkspaceRuntime{
		ID:               "ws-1",
		WorkspaceDir:     "/workspace/ws-1",
		ContainerWorkDir: "/workspaces/crewai",
		Repository:       "https://github.com/acme/crewai",
	}

	got := s.resolveBuildSourceDir(context.Background(), "ws-1", rt, "", discardBuildLogger())
	if got != repoDir {
		t.Fatalf("expected volume-backed build dir %q, got %q", repoDir, got)
	}
}

func TestResolveBuildSourceDir_FallsBackWhenVolumePathMissing(t *testing.T) {
	tmp := t.TempDir()
	mountpoint := filepath.Join(tmp, "vol-data")
	if err := os.MkdirAll(mountpoint, 0o755); err != nil {
		t.Fatalf("mkdir mountpoint: %v", err)
	}
	// Note: the "crewai" subdir is deliberately NOT created.
	t.Setenv("SAM_DOCKER_CLI_PATH", fakeDockerCLI(t, tmp, mountpoint, false))

	s := &Server{}
	rt := &WorkspaceRuntime{
		ID:               "ws-1",
		WorkspaceDir:     "/workspace/ws-1",
		ContainerWorkDir: "/workspaces/crewai",
		Repository:       "https://github.com/acme/crewai",
	}

	got := s.resolveBuildSourceDir(context.Background(), "ws-1", rt, "", discardBuildLogger())
	if got != "/workspace/ws-1" {
		t.Fatalf("expected fallback to host clone, got %q", got)
	}
}

func TestResolveBuildSourceDir_FallsBackWhenDockerFails(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("SAM_DOCKER_CLI_PATH", fakeDockerCLI(t, tmp, "", true))

	s := &Server{}
	rt := &WorkspaceRuntime{
		ID:               "ws-1",
		WorkspaceDir:     "/workspace/ws-1",
		ContainerWorkDir: "/workspaces/crewai",
		Repository:       "https://github.com/acme/crewai",
	}

	got := s.resolveBuildSourceDir(context.Background(), "ws-1", rt, "", discardBuildLogger())
	if got != "/workspace/ws-1" {
		t.Fatalf("expected fallback to host clone when docker fails, got %q", got)
	}
}

func TestResolveBuildSourceDir_FallsBackWhenNoRepoDir(t *testing.T) {
	// No ContainerWorkDir and no Repository -> cannot derive a repo subdir, so
	// the resolver falls back without ever invoking docker.
	tmp := t.TempDir()
	t.Setenv("SAM_DOCKER_CLI_PATH", fakeDockerCLI(t, tmp, "/should/not/matter", false))

	s := &Server{}
	rt := &WorkspaceRuntime{
		ID:           "ws-1",
		WorkspaceDir: "/workspace/ws-1",
	}

	got := s.resolveBuildSourceDir(context.Background(), "ws-1", rt, "", discardBuildLogger())
	if got != "/workspace/ws-1" {
		t.Fatalf("expected fallback to host clone when repo dir underivable, got %q", got)
	}
}

func TestResolveBuildSourceDir_DerivesRepoDirFromRepository(t *testing.T) {
	// ContainerWorkDir empty, but Repository yields repo dir "crewai".
	tmp := t.TempDir()
	mountpoint := filepath.Join(tmp, "vol-data")
	repoDir := filepath.Join(mountpoint, "crewai")
	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		t.Fatalf("mkdir repo dir: %v", err)
	}
	t.Setenv("SAM_DOCKER_CLI_PATH", fakeDockerCLI(t, tmp, mountpoint, false))

	s := &Server{}
	rt := &WorkspaceRuntime{
		ID:           "ws-1",
		WorkspaceDir: "/workspace/ws-1",
		Repository:   "https://github.com/acme/crewai",
	}

	got := s.resolveBuildSourceDir(context.Background(), "ws-1", rt, "", discardBuildLogger())
	if got != repoDir {
		t.Fatalf("expected build dir %q derived from repository, got %q", repoDir, got)
	}
}

func TestResolveBuildSourceDir_PrefersRequestedWorktreeDir(t *testing.T) {
	// The agent is working in a git worktree (a sibling of the primary repo under
	// /workspaces). The explicit working dir must win over runtime.ContainerWorkDir
	// so the build publishes the worktree's source, not the primary repo's.
	tmp := t.TempDir()
	mountpoint := filepath.Join(tmp, "vol-data")
	worktree := filepath.Join(mountpoint, "crewai-wt-feature")
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatalf("mkdir worktree dir: %v", err)
	}
	// Also create the primary repo dir to prove it is NOT chosen.
	if err := os.MkdirAll(filepath.Join(mountpoint, "crewai"), 0o755); err != nil {
		t.Fatalf("mkdir primary repo dir: %v", err)
	}
	t.Setenv("SAM_DOCKER_CLI_PATH", fakeDockerCLI(t, tmp, mountpoint, false))

	s := &Server{}
	rt := &WorkspaceRuntime{
		ID:               "ws-1",
		WorkspaceDir:     "/workspace/ws-1",
		ContainerWorkDir: "/workspaces/crewai",
		Repository:       "https://github.com/acme/crewai",
	}

	got := s.resolveBuildSourceDir(context.Background(), "ws-1", rt, "/workspaces/crewai-wt-feature", discardBuildLogger())
	if got != worktree {
		t.Fatalf("expected worktree build dir %q, got %q", worktree, got)
	}
}

func TestResolveBuildSourceDir_RejectsWorkingDirOutsideWorkspaces(t *testing.T) {
	// A caller-supplied working dir that is not under /workspaces (or attempts
	// traversal) must be ignored in favor of the safe primary-repo resolution.
	tmp := t.TempDir()
	mountpoint := filepath.Join(tmp, "vol-data")
	repoDir := filepath.Join(mountpoint, "crewai")
	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		t.Fatalf("mkdir repo dir: %v", err)
	}
	t.Setenv("SAM_DOCKER_CLI_PATH", fakeDockerCLI(t, tmp, mountpoint, false))

	s := &Server{}
	rt := &WorkspaceRuntime{
		ID:               "ws-1",
		WorkspaceDir:     "/workspace/ws-1",
		ContainerWorkDir: "/workspaces/crewai",
		Repository:       "https://github.com/acme/crewai",
	}

	for _, bad := range []string{"/etc/passwd", "/workspaces/../etc", "relative/path", "/workspaces"} {
		got := s.resolveBuildSourceDir(context.Background(), "ws-1", rt, bad, discardBuildLogger())
		if got != repoDir {
			t.Fatalf("working dir %q should be rejected and fall through to primary repo %q, got %q", bad, repoDir, got)
		}
	}
}

func TestContainerPathRelativeToWorkspaces(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in      string
		wantRel string
		wantOK  bool
	}{
		{"/workspaces/crewai", "crewai", true},
		{"/workspaces/crewai-wt-feature", "crewai-wt-feature", true},
		{"/workspaces/crewai/", "crewai", true},
		{"  /workspaces/crewai  ", "crewai", true},
		{"/workspaces", "", false},
		{"/workspaces/", "", false},
		{"/etc/passwd", "", false},
		{"relative/crewai", "", false},
		{"/workspaces/../etc/passwd", "", false},
		{"", "", false},
	}
	for _, c := range cases {
		gotRel, gotOK := containerPathRelativeToWorkspaces(c.in)
		if gotOK != c.wantOK || gotRel != c.wantRel {
			t.Errorf("containerPathRelativeToWorkspaces(%q) = (%q, %v), want (%q, %v)",
				c.in, gotRel, gotOK, c.wantRel, c.wantOK)
		}
	}
}
