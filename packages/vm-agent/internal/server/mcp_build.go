package server

import (
	"bytes"
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
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/container"
	"github.com/workspace/vm-agent/internal/publish"
)

// McpBuildAndPublishRequest is the body for the build-and-publish endpoint.
type McpBuildAndPublishRequest struct {
	// PublishJobID is the durable control-plane job id for async publish jobs.
	PublishJobID string `json:"publishJobId,omitempty"`
	// Environment is the deployment environment name already authorized by the
	// control plane MCP handler.
	Environment string `json:"environment"`
	// EnvironmentID is the exact deployment environment id selected by policy.
	EnvironmentID string `json:"environmentId"`
	// Reference is the release tag to publish (defaults to "latest").
	Reference string `json:"reference,omitempty"`
	// WorkingDir is the coding agent's container-side working directory under the
	// /workspaces volume (e.g. a git worktree at /workspaces/{repo}-wt-{branch}).
	// When set, the build uses the source at this directory instead of the
	// workspace's primary repo dir. Optional; ignored if it is not a valid path
	// under /workspaces or the resolved host path does not exist.
	WorkingDir string `json:"workingDir,omitempty"`
	// BuildInterpolationEnv contains non-secret deployment config values only.
	// Secrets are intentionally omitted from workspace/build nodes.
	BuildInterpolationEnv map[string]string `json:"buildInterpolationEnv,omitempty"`
	// SecretInterpolationKeys contains secret names for validation only; values
	// are never sent to build nodes.
	SecretInterpolationKeys []string `json:"secretInterpolationKeys,omitempty"`
	// SubmittedBy carries agent/task/workspace attribution for release history.
	SubmittedBy *publish.ReleaseSubmittedBy `json:"submittedBy,omitempty"`
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

type McpBuildAndPublishJobStartResponse struct {
	PublishJobID string `json:"publishJobId"`
	Status       string `json:"status"`
}

type publishJobState struct {
	ID          string
	WorkspaceID string
	ProjectID   string
	Status      string
	Cancel      context.CancelFunc
	StartedAt   time.Time
	CompletedAt time.Time
}

type preparedBuildPublish struct {
	WorkspaceID   string
	ProjectID     string
	Environment   string
	EnvironmentID string
	Reference     string
	BuildDir      string
	HostCloneDir  string
	Token         string
	Request       McpBuildAndPublishRequest
	Log           *slog.Logger
}

// handleMcpBuildAndPublish builds the workspace's compose services on the host
// docker daemon, re-pushes the built images into the project-scoped registry
// namespace with short-lived control-plane credentials, and records a release.
// The coding agent triggers this server-side; it runs zero docker commands.
// POST /workspaces/{workspaceId}/mcp/build-and-publish
func (s *Server) handleMcpBuildAndPublish(w http.ResponseWriter, r *http.Request) {
	prepared, ok := s.prepareMcpBuildAndPublish(w, r)
	if !ok {
		return
	}

	publishTimeout := s.deployBuildPublishTimeout()
	ctx, cancel := context.WithTimeout(r.Context(), publishTimeout)
	defer cancel()
	result, err := s.runPreparedBuildAndPublish(ctx, prepared, nil)
	if err != nil {
		prepared.Log.Error("publish failed", "error", err)
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, McpBuildAndPublishResponse{
		ReleaseID: result.ReleaseID,
		Version:   result.Version,
		Status:    result.Status,
	})
}

// handleMcpBuildAndPublishJobStart accepts an async publish job and starts the
// real build/publish work in a job-owned background context. The context is not
// parented to r.Context(), so Cloudflare/API/client cancellation after 202
// acceptance cannot kill docker build/save or R2 upload work.
func (s *Server) handleMcpBuildAndPublishJobStart(w http.ResponseWriter, r *http.Request) {
	jobID := strings.TrimSpace(r.PathValue("jobId"))
	if jobID == "" {
		writeError(w, http.StatusBadRequest, "jobId is required")
		return
	}

	prepared, ok := s.prepareMcpBuildAndPublish(w, r)
	if !ok {
		return
	}
	if prepared.Request.PublishJobID != "" && prepared.Request.PublishJobID != jobID {
		writeError(w, http.StatusBadRequest, "publishJobId does not match path jobId")
		return
	}

	s.publishJobsMu.Lock()
	if s.publishJobs == nil {
		s.publishJobs = make(map[string]publishJobState)
	}
	if existing, exists := s.publishJobs[jobID]; exists && existing.CompletedAt.IsZero() {
		s.publishJobsMu.Unlock()
		writeError(w, http.StatusConflict, "publish job is already active")
		return
	}
	for _, existing := range s.publishJobs {
		if existing.WorkspaceID == prepared.WorkspaceID && existing.CompletedAt.IsZero() {
			s.publishJobsMu.Unlock()
			writeError(w, http.StatusConflict, "workspace already has an active publish job")
			return
		}
	}
	publishTimeout := s.deployBuildPublishTimeout()
	jobCtx, cancel := context.WithTimeout(context.Background(), publishTimeout)
	s.publishJobs[jobID] = publishJobState{
		ID:          jobID,
		WorkspaceID: prepared.WorkspaceID,
		ProjectID:   prepared.ProjectID,
		Status:      "starting",
		Cancel:      cancel,
		StartedAt:   time.Now().UTC(),
	}
	s.publishJobsMu.Unlock()
	s.persistVMJobStart(jobID, vmJobKindPublish, prepared.WorkspaceID, vmJobStatusStarting, "starting")

	controlPlaneReporter := newPublishJobReporter(s.config.ControlPlaneURL, prepared.ProjectID, jobID, prepared.Token, s.controlPlaneHTTPClient(publishTimeout), prepared.Log)
	reporter := publish.EventFunc(func(ctx context.Context, event publish.Event) {
		s.persistPublishEvent(jobID, event)
		controlPlaneReporter.Event(ctx, event)
	})
	go s.runAcceptedPublishJob(jobCtx, jobID, prepared, reporter)

	writeJSON(w, http.StatusAccepted, McpBuildAndPublishJobStartResponse{
		PublishJobID: jobID,
		Status:       "accepted",
	})
}

func (s *Server) prepareMcpBuildAndPublish(w http.ResponseWriter, r *http.Request) (*preparedBuildPublish, bool) {
	workspaceID := r.PathValue("workspaceId")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return nil, false
	}

	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return nil, false
	}

	var req McpBuildAndPublishRequest
	// Body is optional; an empty body (io.EOF) is fine.
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return nil, false
	}

	reference := strings.TrimSpace(req.Reference)
	if reference == "" {
		reference = "latest"
	}
	environment := strings.TrimSpace(req.Environment)
	if environment == "" {
		writeError(w, http.StatusBadRequest, "environment is required")
		return nil, false
	}
	environmentID := strings.TrimSpace(req.EnvironmentID)
	if environmentID == "" {
		writeError(w, http.StatusBadRequest, "environmentId is required")
		return nil, false
	}

	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		writeError(w, http.StatusNotFound, "workspace not found")
		return nil, false
	}

	workspaceDir := strings.TrimSpace(runtime.WorkspaceDir)
	if workspaceDir == "" {
		writeError(w, http.StatusInternalServerError, "workspace has no cloned repository path")
		return nil, false
	}

	projectID := firstNonEmpty(strings.TrimSpace(runtime.ProjectID), strings.TrimSpace(s.config.ProjectID))
	if projectID == "" {
		writeError(w, http.StatusInternalServerError, "workspace is not linked to a project")
		return nil, false
	}

	token := strings.TrimSpace(runtime.CallbackToken)
	if token == "" {
		writeError(w, http.StatusInternalServerError, "workspace has no callback token for publishing")
		return nil, false
	}

	log := slog.Default().With(
		"component", "mcp-build-publish",
		"workspaceId", workspaceID,
		"projectId", projectID,
		"environment", environment,
		"environmentId", environmentID,
		"reference", reference)

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// runtime.WorkspaceDir is a host clone captured at workspace boot. The coding
	// agent edits and commits its real source inside the devcontainer's named
	// volume (sam-ws-{workspaceId}) mounted at /workspaces — which is never
	// re-synced back to the host clone. Building the host clone publishes the
	// stale boot-time tree, so resolve the agent's actual working tree from the
	// named volume before building. req.WorkingDir lets the agent point at a git
	// worktree (a sibling dir of the primary repo) rather than the primary repo.
	buildDir := s.resolveBuildSourceDir(ctx, workspaceID, runtime, req.WorkingDir, log)
	return &preparedBuildPublish{
		WorkspaceID:   workspaceID,
		ProjectID:     projectID,
		Environment:   environment,
		EnvironmentID: environmentID,
		Reference:     reference,
		BuildDir:      buildDir,
		HostCloneDir:  workspaceDir,
		Token:         token,
		Request:       req,
		Log:           log,
	}, true
}

func (s *Server) runAcceptedPublishJob(ctx context.Context, jobID string, prepared *preparedBuildPublish, reporter publish.EventSink) {
	reporter.Event(ctx, publish.Event{Status: "starting", CurrentStep: "started", EventType: "publish.job.started", Message: "publish job started"})
	runner := s.runPreparedBuildAndPublish
	if s.buildPublishRunner != nil {
		runner = s.buildPublishRunner
	}
	result, err := runner(ctx, prepared, reporter)
	s.publishJobsMu.Lock()
	state := s.publishJobs[jobID]
	if state.Cancel != nil {
		state.Cancel()
	}
	state.CompletedAt = time.Now().UTC()
	if err != nil {
		state.Status = "failed"
	} else {
		state.Status = "succeeded"
	}
	s.publishJobs[jobID] = state
	s.publishJobsMu.Unlock()
	if err != nil {
		s.persistVMJobComplete(jobID, vmJobStatusFailed, "failed", err.Error(), nil)
		prepared.Log.Error("async publish failed", "publishJobId", jobID, "error", err)
		reporter.Event(context.Background(), publish.Event{Status: "failed", CurrentStep: "failed", Level: "error", EventType: "publish.job.failed", Message: "publish job failed", ErrorMessage: err.Error(), ErrorCode: "publish_failed", Terminal: true, Retryable: true})
		return
	}
	prepared.Log.Info("async publish complete", "publishJobId", jobID, "releaseId", result.ReleaseID, "version", result.Version)
	s.persistVMJobComplete(jobID, vmJobStatusSucceeded, "succeeded", "", result)
	reporter.Event(context.Background(), publish.Event{Status: "succeeded", CurrentStep: "succeeded", EventType: "publish.job.succeeded", Message: "publish job succeeded", ReleaseID: result.ReleaseID, ReleaseVersion: result.Version, ReleaseStatus: result.Status, Terminal: true})
}

func (s *Server) runPreparedBuildAndPublish(ctx context.Context, prepared *preparedBuildPublish, events publish.EventSink) (*publish.ReleaseResult, error) {
	log := prepared.Log
	log.Info("host build starting", "buildDir", prepared.BuildDir, "hostClone", prepared.HostCloneDir)
	artifact, err := publish.Build(ctx, publish.BuildOptions{
		WorkspaceDir: prepared.BuildDir,
		Reference:    prepared.Reference,
		BuildEnv:     prepared.Request.BuildInterpolationEnv,
		SecretKeys:   prepared.Request.SecretInterpolationKeys,
		Events:       events,
		Logger:       log,
	})
	if err != nil {
		log.Error("host build failed", "error", err)
		return nil, errors.New("build failed: " + err.Error())
	}

	orch := publish.New(publish.Options{
		ControlPlane: publish.NewHTTPControlPlane(publish.HTTPControlPlaneOptions{
			BaseURL: s.config.ControlPlaneURL,
			Token:   prepared.Token,
			Client:  s.controlPlaneHTTPClient(s.deployBuildPublishTimeout()),
			Logger:  log,
		}),
		Docker: publish.NewHostDocker(),
		Events: events,
		Logger: log,
	})

	result, err := orch.Publish(ctx, prepared.ProjectID, prepared.Environment, prepared.EnvironmentID, artifact, prepared.Request.SubmittedBy)
	if err != nil {
		log.Error("publish failed", "error", err)
		return nil, errors.New("publish failed: " + err.Error())
	}

	log.Info("publish complete",
		"releaseId", result.ReleaseID,
		"version", result.Version,
		"status", result.Status)
	return result, nil
}

type publishJobReporter struct {
	baseURL   string
	projectID string
	jobID     string
	token     string
	client    *http.Client
	log       *slog.Logger
}

func newPublishJobReporter(baseURL, projectID, jobID, token string, client *http.Client, log *slog.Logger) *publishJobReporter {
	return &publishJobReporter{
		baseURL:   strings.TrimRight(baseURL, "/"),
		projectID: projectID,
		jobID:     jobID,
		token:     token,
		client:    client,
		log:       log.With("component", "publish-job-reporter", "publishJobId", jobID),
	}
}

func (r *publishJobReporter) Event(ctx context.Context, event publish.Event) {
	if r == nil || r.client == nil {
		return
	}
	if event.Level == "" {
		event.Level = "info"
	}
	raw, err := json.Marshal(event)
	if err != nil {
		r.log.Warn("marshal publish job event failed", "error", err)
		return
	}
	url := r.baseURL + "/api/projects/" + r.projectID + "/deployment-publish-jobs/" + r.jobID + "/events"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		r.log.Warn("create publish job event request failed", "error", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+r.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.client.Do(req)
	if err != nil {
		r.log.Warn("send publish job event failed", "eventType", event.EventType, "error", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		r.log.Warn("publish job event rejected", "eventType", event.EventType, "status", resp.StatusCode, "body", string(body))
	}
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

func (s *Server) deployBuildPublishTimeout() time.Duration {
	if s != nil && s.config.DeployBuildPublishTimeout > 0 {
		return s.config.DeployBuildPublishTimeout
	}
	return config.DefaultDeployBuildPublishTimeout
}
