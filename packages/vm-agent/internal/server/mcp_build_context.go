package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/container"
	"github.com/workspace/vm-agent/internal/publish"
	"github.com/workspace/vm-agent/internal/publish/contextcollect"
)

type collectBuildContextRequest struct {
	McpBuildAndPublishRequest
	MaxBytes         int64 `json:"maxBytes,omitempty"`
	CollectTimeoutMs int64 `json:"collectTimeoutMs,omitempty"`
	Shadow           bool  `json:"shadow,omitempty"`
}

// Collection is accepted quickly and runs in a job-owned context, like node
// publishing. No goroutine retains the HTTP request or response writer.
func (s *Server) handleMcpBuildContextCollect(w http.ResponseWriter, r *http.Request) {
	workspaceID, jobID := r.PathValue("workspaceId"), r.PathValue("jobId")
	if workspaceID == "" || jobID == "" {
		writeError(w, 400, "workspaceId and jobId are required")
		return
	}
	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}
	var req collectBuildContextRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, 400, "invalid context request")
		return
	}
	if req.Attempt < 1 || (req.PublishJobID != "" && req.PublishJobID != jobID) {
		writeError(w, 400, "positive attempt and matching publishJobId are required")
		return
	}
	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		writeError(w, 404, "workspace not found")
		return
	}
	projectID := s.workspaceSAMIdentity(workspaceID, runtime, nil).ProjectID
	if projectID == "" || s.workspaceCallbackToken(workspaceID) == "" {
		writeError(w, 409, "workspace requires project identity and callback token")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.deployBuildPublishTimeout())
	s.publishJobsMu.Lock()
	if s.publishJobs == nil {
		s.publishJobs = map[string]publishJobState{}
	}
	if existing, ok := s.publishJobs[jobID]; ok && existing.CompletedAt.IsZero() {
		s.publishJobsMu.Unlock()
		cancel()
		writeError(w, 409, "context job is already active")
		return
	}
	s.publishJobs[jobID] = publishJobState{ID: jobID, ContextOnly: true, WorkspaceID: workspaceID, ProjectID: projectID, Status: "collecting", Cancel: cancel, StartedAt: time.Now().UTC()}
	s.publishJobsMu.Unlock()
	// Freeze accepted source paths; workspace updates may mutate the live runtime.
	s.workspaceMu.RLock()
	source := &WorkspaceRuntime{ContainerWorkDir: runtime.ContainerWorkDir, WorkspaceDir: runtime.WorkspaceDir, Repository: runtime.Repository}
	s.workspaceMu.RUnlock()
	go s.runAcceptedContextCollection(ctx, cancel, workspaceID, projectID, jobID, source, req)
	writeJSON(w, http.StatusAccepted, map[string]string{"publishJobId": jobID, "status": "accepted"})
}
func (s *Server) runAcceptedContextCollection(ctx context.Context, cancel context.CancelFunc, workspaceID, projectID, jobID string, runtime *WorkspaceRuntime, req collectBuildContextRequest) {
	defer cancel()
	reporter := newPublishJobReporter(s.config.ControlPlaneURL, projectID, jobID, func() string { return s.workspaceCallbackToken(workspaceID) }, s.controlPlaneHTTPClient(s.deployBuildPublishTimeout()), slog.Default())
	stop := s.startPublishJobHeartbeats(ctx, reporter)
	result, err := s.collectAndUploadBuildContext(ctx, workspaceID, projectID, jobID, runtime, req)
	stop()
	status := "context_ready"
	event := publish.Event{Status: status, CurrentStep: status, EventType: "publish.context.collected", Message: "build context collection complete"}
	if err != nil {
		status = "failed"
		event = publish.Event{Status: status, CurrentStep: status, EventType: "publish.context.failed", Message: "build context collection failed", ErrorMessage: err.Error(), ErrorCode: "context_collection_failed", Terminal: true}
	}
	if err == nil && req.Shadow {
		status = "succeeded"
		event.Status = status
		event.Terminal = true
	}
	if result != nil {
		event.Detail = map[string]any{"sizeBytes": result.Bytes, "sha256": result.SHA256, "durationMs": result.DurationMs}
	}
	reportTimeout := s.config.HTTPCallbackTimeout
	if reportTimeout <= 0 {
		reportTimeout = config.DefaultHTTPCallbackTimeout
	}
	reportCtx, abort := context.WithTimeout(context.Background(), reportTimeout)
	defer abort()
	reporter.Event(reportCtx, event)
	s.publishJobsMu.Lock()
	state := s.publishJobs[jobID]
	state.Status = status
	state.CompletedAt = time.Now().UTC()
	s.publishJobs[jobID] = state
	s.publishJobsMu.Unlock()
}
func (s *Server) collectAndUploadBuildContext(ctx context.Context, workspaceID, projectID, jobID string, runtime *WorkspaceRuntime, req collectBuildContextRequest) (*contextcollect.Result, error) {
	timeout := time.Duration(req.CollectTimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = time.Duration(contextcollect.DEFAULT_BUILD_CONTEXT_COLLECT_TIMEOUT_MS) * time.Millisecond
	}
	collectCtx, collectCancel := context.WithTimeout(ctx, timeout)
	defer collectCancel()
	source, err := s.resolveContextSourceDir(collectCtx, workspaceID, runtime, req.WorkingDir)
	if err != nil {
		return nil, err
	}
	file, err := os.CreateTemp("", "sam-build-context-*.tar.zst")
	if err != nil {
		return nil, fmt.Errorf("cannot create context archive: %w", err)
	}
	defer os.Remove(file.Name())
	defer file.Close()
	result, err := contextcollect.Collect(collectCtx, contextcollect.Options{Root: source, BuildEnv: req.BuildInterpolationEnv, SecretKeys: req.SecretInterpolationKeys, MaxBytes: req.MaxBytes, Timeout: timeout}, file)
	if err != nil {
		return nil, err
	}
	collectCancel()
	callbackPath := "/api/projects/" + url.PathEscape(projectID) + "/deployment-publish-jobs/" + url.PathEscape(jobID) + "/context/"
	body := map[string]any{"attempt": req.Attempt, "sizeBytes": result.Bytes, "sha256": result.SHA256, "durationMs": result.DurationMs}
	var slot struct {
		UploadURL string `json:"uploadUrl"`
	}
	if err := s.contextCallback(ctx, workspaceID, callbackPath+"init", body, &slot); err != nil {
		return nil, err
	}
	if slot.UploadURL == "" {
		return nil, fmt.Errorf("context init returned no upload URL")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	put, err := http.NewRequestWithContext(ctx, http.MethodPut, slot.UploadURL, file)
	if err != nil {
		return nil, fmt.Errorf("invalid context upload URL")
	}
	put.ContentLength = result.Bytes
	put.Header.Set("Content-Type", "application/zstd")
	put.Header.Set("x-amz-meta-sha256", result.SHA256)
	// Never send a workspace credential to the signed R2 endpoint.
	resp, err := s.controlPlaneHTTPClient(s.deployBuildPublishTimeout()).Do(put)
	if err != nil {
		return nil, fmt.Errorf("context upload failed")
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("context upload returned %d", resp.StatusCode)
	}
	if err := s.contextCallback(ctx, workspaceID, callbackPath+"complete", body, nil); err != nil {
		return nil, err
	}
	return result, nil
}
func (s *Server) contextCallback(ctx context.Context, workspaceID, path string, body any, out any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.config.ControlPlaneURL, "/")+path, strings.NewReader(string(data)))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.workspaceCallbackToken(workspaceID))
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.controlPlaneHTTPClient(s.deployBuildPublishTimeout()).Do(req)
	if err != nil {
		return fmt.Errorf("context callback unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("context callback returned %d; inspect publish job state before retrying", resp.StatusCode)
	}
	if out != nil {
		return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out)
	}
	return nil
}

// Strict source resolution: never collect the stale host clone on a VM. Instant
// reads /workspaces directly, and does not invoke any Docker command.
func (s *Server) resolveContextSourceDir(ctx context.Context, workspaceID string, runtime *WorkspaceRuntime, requested string) (string, error) {
	path := strings.TrimSpace(requested)
	if path == "" {
		path = runtime.ContainerWorkDir
	}
	if path == "" && s.config.ContainerMode {
		path = runtime.WorkspaceDir
	}
	if path == "" {
		path = containerWorkspacesRoot + "/" + repositoryDirName(runtime.Repository)
	}
	rel, ok := containerPathRelativeToWorkspaces(path)
	if !ok {
		return "", fmt.Errorf("workingDir must be a directory under /workspaces without traversal")
	}
	root := containerWorkspacesRoot
	if !s.config.ContainerMode {
		out, err := exec.CommandContext(ctx, container.DockerCLIPath(), "volume", "inspect", bootstrap.VolumeNameForWorkspace(workspaceID), "--format", "{{.Mountpoint}}").Output()
		if err != nil {
			return "", fmt.Errorf("cannot resolve devcontainer volume; start the workspace and retry")
		}
		root = strings.TrimSpace(string(out))
		if root == "" || !filepath.IsAbs(root) {
			return "", fmt.Errorf("devcontainer volume has no absolute mountpoint")
		}
	}
	source := filepath.Join(root, rel)
	resolved, err := filepath.EvalSymlinks(source)
	if err != nil {
		return "", fmt.Errorf("workingDir is unavailable: %w", err)
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	check, err := filepath.Rel(realRoot, resolved)
	if err != nil || check == ".." || strings.HasPrefix(check, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("workingDir symlink escapes workspace volume")
	}
	return resolved, nil
}
