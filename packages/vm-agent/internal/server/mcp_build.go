package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/publish"
)

// buildPublishTimeout bounds the whole host build + push + release flow. Image
// builds and registry pushes are slow, so this is far longer than ordinary MCP
// tool calls.
const buildPublishTimeout = 20 * time.Minute

// McpBuildAndPublishRequest is the body for the build-and-publish endpoint.
type McpBuildAndPublishRequest struct {
	// Reference is the release tag to publish (defaults to "latest").
	Reference string `json:"reference,omitempty"`
}

// McpBuildAndPublishResponse reports the recorded release.
type McpBuildAndPublishResponse struct {
	ReleaseID string `json:"releaseId"`
	Version   int    `json:"version"`
	Status    string `json:"status"`
}

// handleMcpBuildAndPublish builds the workspace's compose services on the host
// docker daemon, re-pushes the built images into the project-scoped registry
// namespace with short-lived control-plane credentials, and records a release.
// The coding agent triggers this server-side; it runs zero docker commands.
// POST /workspaces/{workspaceId}/mcp/build-and-publish
func (s *Server) handleMcpBuildAndPublish(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}

	if !s.requireWorkspaceRequestAuth(w, r, workspaceID) {
		return
	}

	var req McpBuildAndPublishRequest
	// Body is optional; an empty body (io.EOF) is fine.
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	reference := strings.TrimSpace(req.Reference)
	if reference == "" {
		reference = "latest"
	}

	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		writeError(w, http.StatusNotFound, "workspace not found")
		return
	}

	workspaceDir := strings.TrimSpace(runtime.WorkspaceDir)
	if workspaceDir == "" {
		writeError(w, http.StatusInternalServerError, "workspace has no cloned repository path")
		return
	}

	projectID := firstNonEmpty(strings.TrimSpace(runtime.ProjectID), strings.TrimSpace(s.config.ProjectID))
	if projectID == "" {
		writeError(w, http.StatusInternalServerError, "workspace is not linked to a project")
		return
	}

	token := strings.TrimSpace(runtime.CallbackToken)
	if token == "" {
		writeError(w, http.StatusInternalServerError, "workspace has no callback token for publishing")
		return
	}

	log := slog.Default().With(
		"component", "mcp-build-publish",
		"workspaceId", workspaceID,
		"projectId", projectID,
		"reference", reference)

	ctx, cancel := context.WithTimeout(r.Context(), buildPublishTimeout)
	defer cancel()

	log.Info("host build starting", "workspaceDir", workspaceDir)
	artifact, err := publish.Build(ctx, publish.BuildOptions{
		WorkspaceDir: workspaceDir,
		Reference:    reference,
		Logger:       log,
	})
	if err != nil {
		log.Error("host build failed", "error", err)
		writeError(w, http.StatusInternalServerError, "build failed: "+err.Error())
		return
	}

	orch := publish.New(publish.Options{
		ControlPlane: publish.NewHTTPControlPlane(publish.HTTPControlPlaneOptions{
			BaseURL: s.config.ControlPlaneURL,
			Token:   token,
			Client:  s.controlPlaneHTTPClient(buildPublishTimeout),
			Logger:  log,
		}),
		Docker: publish.NewHostDocker(),
		Logger: log,
	})

	result, err := orch.Publish(ctx, projectID, artifact)
	if err != nil {
		log.Error("publish failed", "error", err)
		writeError(w, http.StatusInternalServerError, "publish failed: "+err.Error())
		return
	}

	log.Info("publish complete",
		"releaseId", result.ReleaseID,
		"version", result.Version,
		"status", result.Status)

	writeJSON(w, http.StatusOK, McpBuildAndPublishResponse{
		ReleaseID: result.ReleaseID,
		Version:   result.Version,
		Status:    result.Status,
	})
}
