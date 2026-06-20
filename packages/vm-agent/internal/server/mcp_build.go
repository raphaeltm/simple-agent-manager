package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/container"
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
	// WorkingDir is the coding agent's container-side working directory under the
	// /workspaces volume (e.g. a git worktree at /workspaces/{repo}-wt-{branch}).
	// When set, the build uses the source at this directory instead of the
	// workspace's primary repo dir. Optional; ignored if it is not a valid path
	// under /workspaces or the resolved host path does not exist.
	WorkingDir string `json:"workingDir,omitempty"`
}

// containerWorkspacesRoot is the in-container mount point of the workspace's
// named Docker volume (sam-ws-{workspaceId}). Both the primary repo
// (/workspaces/{repo}) and any git worktrees (/workspaces/{repo}-wt-{branch})
// live directly under it. See bootstrap.go (target=/workspaces).
const containerWorkspacesRoot = "/workspaces"

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

	// runtime.WorkspaceDir is a host clone captured at workspace boot. The coding
	// agent edits and commits its real source inside the devcontainer's named
	// volume (sam-ws-{workspaceId}) mounted at /workspaces — which is never
	// re-synced back to the host clone. Building the host clone publishes the
	// stale boot-time tree, so resolve the agent's actual working tree from the
	// named volume before building. req.WorkingDir lets the agent point at a git
	// worktree (a sibling dir of the primary repo) rather than the primary repo.
	buildDir := s.resolveBuildSourceDir(ctx, workspaceID, runtime, req.WorkingDir, log)

	log.Info("host build starting", "buildDir", buildDir, "hostClone", workspaceDir)
	artifact, err := publish.Build(ctx, publish.BuildOptions{
		WorkspaceDir: buildDir,
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

// resolveBuildSourceDir returns the host filesystem path of the agent's actual
// working tree so the build publishes the agent's committed source rather than
// the boot-time host clone.
//
// The coding agent's source lives inside the devcontainer's Docker named volume
// (sam-ws-{workspaceId}), mounted at /workspaces. That volume's data is on the
// host at the path reported by `docker volume inspect`, so the host docker daemon
// (which runs the compose build) can read it directly. We map the agent's
// container-side working directory (under /workspaces) to its host path under the
// volume mountpoint.
//
// requestedWorkingDir (from the caller) takes precedence so an agent working in a
// git worktree — a sibling dir of the primary repo, e.g.
// /workspaces/{repo}-wt-{branch} — builds that worktree rather than the primary
// repo. When it is empty we fall back to the workspace's primary container work
// dir, then to a path derived from the repository name.
//
// If the volume or path cannot be resolved for any reason, we fall back to
// runtime.WorkspaceDir so the publish still attempts a build rather than failing
// outright.
func (s *Server) resolveBuildSourceDir(ctx context.Context, workspaceID string, runtime *WorkspaceRuntime, requestedWorkingDir string, log *slog.Logger) string {
	fallback := strings.TrimSpace(runtime.WorkspaceDir)

	// Candidate container-side working dirs in priority order. The explicit
	// caller-supplied dir wins (an agent working in a git worktree, a sibling of
	// the primary repo under /workspaces), then the workspace's primary container
	// work dir, then a path derived from the repository name. The first candidate
	// that is a safe path under /workspaces is used. A non-empty but unsafe
	// requestedWorkingDir (outside /workspaces, traversal) is skipped rather than
	// forcing a host-clone fallback — so a bad arg still publishes the primary
	// repo from the live volume instead of the stale boot-time clone.
	candidates := []string{
		strings.TrimSpace(requestedWorkingDir),
		strings.TrimSpace(runtime.ContainerWorkDir),
	}
	if repoDir := repositoryDirName(runtime.Repository); repoDir != "" {
		candidates = append(candidates, containerWorkspacesRoot+"/"+repoDir)
	}

	var rel, containerDir string
	var ok bool
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if r, valid := containerPathRelativeToWorkspaces(c); valid {
			rel, containerDir, ok = r, c, true
			break
		}
	}
	if !ok {
		log.Warn("build source: could not resolve a /workspaces working dir; using host clone",
			"requestedWorkingDir", requestedWorkingDir, "containerWorkDir", runtime.ContainerWorkDir,
			"repository", runtime.Repository, "fallback", fallback)
		return fallback
	}

	volName := bootstrap.VolumeNameForWorkspace(workspaceID)
	out, err := exec.CommandContext(ctx, container.DockerCLIPath(),
		"volume", "inspect", volName, "--format", "{{.Mountpoint}}").Output()
	if err != nil {
		log.Warn("build source: docker volume inspect failed; using host clone",
			"volume", volName, "error", err, "fallback", fallback)
		return fallback
	}
	mountpoint := strings.TrimSpace(string(out))
	if mountpoint == "" {
		log.Warn("build source: empty volume mountpoint; using host clone",
			"volume", volName, "fallback", fallback)
		return fallback
	}

	buildDir := filepath.Join(mountpoint, rel)
	if _, err := os.Stat(buildDir); err != nil {
		log.Warn("build source: resolved volume path not accessible; using host clone",
			"buildDir", buildDir, "containerDir", containerDir, "error", err, "fallback", fallback)
		return fallback
	}

	log.Info("build source resolved from workspace volume",
		"volume", volName, "mountpoint", mountpoint, "containerDir", containerDir, "buildDir", buildDir)
	return buildDir
}

// containerPathRelativeToWorkspaces validates that p is a clean container path
// strictly under the /workspaces volume mount and returns its path relative to
// that root. It rejects empty paths, paths outside /workspaces, and any path
// containing a traversal segment ("..") or NUL — so a caller-supplied working dir
// can never escape the workspace volume.
func containerPathRelativeToWorkspaces(p string) (string, bool) {
	p = strings.TrimSpace(p)
	if p == "" || strings.ContainsRune(p, 0) || strings.Contains(p, "..") {
		return "", false
	}
	clean := filepath.Clean(p)
	prefix := containerWorkspacesRoot + "/"
	if !strings.HasPrefix(clean, prefix) {
		return "", false
	}
	rel := strings.TrimPrefix(clean, prefix)
	if rel == "" {
		return "", false
	}
	return rel, true
}
