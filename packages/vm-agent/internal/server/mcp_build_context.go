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
	"github.com/workspace/vm-agent/internal/container"
	"github.com/workspace/vm-agent/internal/publish/contextcollect"
)

type collectBuildContextRequest struct {
	McpBuildAndPublishRequest
	MaxBytes         int64 `json:"maxBytes,omitempty"`
	CollectTimeoutMs int64 `json:"collectTimeoutMs,omitempty"`
}

// This request owns collection and upload. Unlike accepted async build jobs,
// disconnection cancels it; no goroutine retains the HTTP request (rule 71).
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
	token := s.workspaceCallbackToken(workspaceID)
	if projectID == "" || token == "" {
		writeError(w, 409, "workspace requires project identity and callback token")
		return
	}
	timeout := time.Duration(req.CollectTimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = time.Duration(contextcollect.DEFAULT_BUILD_CONTEXT_COLLECT_TIMEOUT_MS) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.deployBuildPublishTimeout())
	defer cancel()
	reporter := newPublishJobReporter(s.config.ControlPlaneURL, projectID, jobID, func() string { return s.workspaceCallbackToken(workspaceID) }, s.controlPlaneHTTPClient(s.deployBuildPublishTimeout()), slog.Default())
	stopHeartbeats := s.startPublishJobHeartbeats(ctx, reporter)
	defer stopHeartbeats()
	collectCtx, collectCancel := context.WithTimeout(ctx, timeout)
	defer collectCancel()
	source, err := s.resolveContextSourceDir(collectCtx, workspaceID, runtime, req.WorkingDir)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	file, err := os.CreateTemp("", "sam-build-context-*.tar.zst")
	if err != nil {
		writeError(w, 500, "cannot create context archive")
		return
	}
	defer os.Remove(file.Name())
	defer file.Close()
	result, err := contextcollect.Collect(collectCtx, contextcollect.Options{Root: source, BuildEnv: req.BuildInterpolationEnv, SecretKeys: req.SecretInterpolationKeys, MaxBytes: req.MaxBytes, Timeout: timeout}, file)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	collectCancel()
	callbackPath := "/api/projects/" + url.PathEscape(projectID) + "/deployment-publish-jobs/" + url.PathEscape(jobID) + "/context/"
	body := map[string]any{"attempt": req.Attempt, "sizeBytes": result.Bytes, "sha256": result.SHA256, "durationMs": result.DurationMs}
	var slot struct {
		UploadURL string `json:"uploadUrl"`
	}
	if err := s.contextCallback(ctx, workspaceID, callbackPath+"init", body, &slot); err != nil {
		writeError(w, 502, err.Error())
		return
	}
	if slot.UploadURL == "" {
		writeError(w, 502, "context init returned no upload URL")
		return
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		writeError(w, 500, "cannot read context archive")
		return
	}
	put, err := http.NewRequestWithContext(ctx, http.MethodPut, slot.UploadURL, file)
	if err != nil {
		writeError(w, 502, "invalid context upload URL")
		return
	}
	put.ContentLength = result.Bytes
	put.Header.Set("Content-Type", "application/zstd")
	put.Header.Set("x-amz-meta-sha256", result.SHA256)
	// Never send a workspace credential to the signed R2 endpoint.
	resp, err := s.controlPlaneHTTPClient(s.deployBuildPublishTimeout()).Do(put)
	if err != nil {
		writeError(w, 502, "context upload failed")
		return
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		writeError(w, 502, fmt.Sprintf("context upload returned %d", resp.StatusCode))
		return
	}
	if err := s.contextCallback(ctx, workspaceID, callbackPath+"complete", body, nil); err != nil {
		writeError(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"publishJobId": jobID, "status": "context_ready", "sizeBytes": result.Bytes, "sha256": result.SHA256, "durationMs": result.DurationMs})
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
