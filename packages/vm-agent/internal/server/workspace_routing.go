package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/eventstore"
)

// firstNonEmpty returns the first non-empty string argument, or "".
func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// workspaceRuntimeOpts holds optional fields for upsertWorkspaceRuntime that
// must be set under the workspace mutex to avoid data races with concurrent
// goroutines reading the runtime struct.
//
// Every string field uses its zero value to mean "not supplied", so a caller
// that only refreshes status or a callback token leaves the rest untouched.
// Lightweight is a pointer for the same reason: a plain bool cannot express
// "not supplied", and the flag gates cf-container runtime-asset injection
// (agent_ws.go) plus devcontainer recovery (workspace_provisioning.go), so an
// unrelated caller must not be able to clear it. Use lightweightOpt to set it.
type workspaceRuntimeOpts struct {
	GitUserName            string
	GitUserEmail           string
	GitHubID               string
	RepoProvider           string
	BaseBranch             string
	CloneURL               string
	RepositoryHost         string
	RepositoryPath         string
	Lightweight            *bool // nil leaves the runtime's existing flag unchanged
	DevcontainerConfigName string
	DevcontainerCache      DevcontainerCacheCredentials
	DefaultBranch          string // project's actual default branch; used by the push guard
	ProjectID              string
	ChatSessionID          string
	EvictionGeneration     string // Initial hydration only; existing runs advance through explicit restart CAS.
	TaskID                 string
}

// lightweightOpt returns an explicit override for workspaceRuntimeOpts.Lightweight.
// "Not supplied" is expressed by omitting this call entirely, leaving the struct
// field at its nil zero value.
func lightweightOpt(v bool) *bool { return &v }

func (s *Server) routedNodeID(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("X-SAM-Node-Id"))
}

func (s *Server) routedWorkspaceID(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("X-SAM-Workspace-Id"))
}

func (s *Server) requireWorkspaceRoute(w http.ResponseWriter, r *http.Request) (string, bool) {
	workspaceID := s.routedWorkspaceID(r)
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "missing X-SAM-Workspace-Id header")
		return "", false
	}
	return workspaceID, true
}

func (s *Server) requireWorkspaceRequestAuth(w http.ResponseWriter, r *http.Request, workspaceID string) bool {
	routedWorkspace := s.routedWorkspaceID(r)
	if routedWorkspace != "" && routedWorkspace != workspaceID {
		writeError(w, http.StatusForbidden, "workspace route mismatch")
		return false
	}

	// Try workspace-scoped cookie first, then fall back to legacy cookie.
	session := s.sessionManager.GetSessionForWorkspace(r, workspaceID)
	if session != nil {
		if session.Claims == nil {
			// Invalid session — fall through to token auth instead of hard-failing.
			slog.Warn("session has nil claims, falling through to token auth",
				"workspaceID", workspaceID)
		} else if session.Claims.Workspace != "" && session.Claims.Workspace != workspaceID {
			// Cookie belongs to a different workspace — skip it and try token auth.
			// This happens when multiple workspaces share a node and the browser
			// sends the legacy (unscoped) cookie for a different workspace.
			slog.Debug("session cookie workspace mismatch, falling through to token auth",
				"workspaceID", workspaceID,
				"cookieWorkspace", session.Claims.Workspace)
		} else {
			// Valid session for this workspace
			return true
		}
	}

	// Try Authorization: Bearer header first, then fall back to ?token= query param.
	// The query param fallback exists because browser WebSocket upgrade requests cannot
	// set custom headers. Server-to-server calls (API proxy) MUST use Bearer header.
	token := ""
	if authHeader := r.Header.Get("Authorization"); strings.HasPrefix(authHeader, "Bearer ") {
		token = strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	}
	if token == "" {
		token = strings.TrimSpace(r.URL.Query().Get("token"))
		if token != "" {
			slog.Debug("Auth token from query parameter (prefer Bearer header for non-WebSocket calls)",
				"workspace", workspaceID,
				"path", r.URL.Path,
			)
		}
	}
	if token == "" {
		writeError(w, http.StatusUnauthorized, "missing token")
		return false
	}

	claims, err := s.jwtValidator.ValidateWorkspaceToken(token, workspaceID)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid token")
		return false
	}

	createdSession, err := s.sessionManager.CreateSession(claims)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create session")
		return false
	}
	s.sessionManager.SetCookieForWorkspace(w, createdSession, workspaceID)
	return true
}

// checkWorkspaceRequestAuth is a non-writing variant of requireWorkspaceRequestAuth.
// It returns true if the request is authenticated for the given workspace, but does
// NOT write any HTTP error response on failure. This allows callers to try multiple
// auth methods without producing garbled double-write responses.
func (s *Server) checkWorkspaceRequestAuth(r *http.Request, workspaceID string) bool {
	routedWorkspace := s.routedWorkspaceID(r)
	if routedWorkspace != "" && routedWorkspace != workspaceID {
		return false
	}

	// Try workspace-scoped cookie first, then fall back to legacy cookie.
	session := s.sessionManager.GetSessionForWorkspace(r, workspaceID)
	if session != nil {
		if session.Claims != nil &&
			(session.Claims.Workspace == "" || session.Claims.Workspace == workspaceID) {
			return true
		}
	}

	// Try Authorization: Bearer header first, then fall back to ?token= query param.
	token := ""
	if authHeader := r.Header.Get("Authorization"); strings.HasPrefix(authHeader, "Bearer ") {
		token = strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	}
	if token == "" {
		token = strings.TrimSpace(r.URL.Query().Get("token"))
	}
	if token == "" {
		return false
	}

	_, err := s.jwtValidator.ValidateWorkspaceToken(token, workspaceID)
	return err == nil
}

func (s *Server) requireWorkspaceReconnectState(w http.ResponseWriter, r *http.Request, runtime *WorkspaceRuntime) bool {
	lock := s.workspaceLifecycleLock(runtime.ID)
	if err := lock.Lock(r.Context()); err != nil {
		writeError(w, http.StatusRequestTimeout, "workspace lifecycle operation canceled")
		return false
	}
	defer lock.Unlock()
	snapshot, err := s.refreshWorkspaceEvictionState(runtime)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return false
	}
	if snapshot.Status == "evicted" {
		writeError(w, http.StatusConflict, "workspace was evicted; restart it before reconnecting")
		return false
	}
	return true
}

func (s *Server) getWorkspaceRuntime(workspaceID string) (*WorkspaceRuntime, bool) {
	s.workspaceMu.RLock()
	defer s.workspaceMu.RUnlock()
	runtime, ok := s.workspaces[workspaceID]
	return runtime, ok
}

func (s *Server) upsertWorkspaceRuntime(workspaceID, repository, branch, status, callbackToken string, opts ...workspaceRuntimeOpts) *WorkspaceRuntime {
	var opt workspaceRuntimeOpts
	if len(opts) > 0 {
		opt = opts[0]
	}
	s.workspaceMu.Lock()
	var resourceHistorySnapshot *WorkspaceRuntime
	var adoptedCallbackToken string // persisted under the lock, published after it
	defer func() {
		s.workspaceMu.Unlock()
		s.propagateWorkspaceCallbackToken(workspaceID, adoptedCallbackToken)
		if resourceHistorySnapshot != nil {
			s.ensureResourceHistoryForRuntime(resourceHistorySnapshot)
		}
	}()

	if s.workspaces == nil {
		s.workspaces = make(map[string]*WorkspaceRuntime)
	}
	if s.workspaceEvents == nil {
		s.workspaceEvents = make(map[string][]EventRecord)
	}
	if s.agentSessions == nil {
		s.agentSessions = agentsessions.NewManager()
	}

	runtime, ok := s.workspaces[workspaceID]
	if ok {
		metadataChanged := false
		if repository != "" {
			runtime.Repository = repository
			metadataChanged = true
		}
		if branch != "" {
			runtime.Branch = branch
			metadataChanged = true
		}
		if status != "" && runtime.Status != "evicted" && !runtime.ProvisioningActive && !runtime.MetadataUnavailable {
			runtime.Status = status
		}
		if adoptWorkspaceCallbackTokenLocked(runtime, callbackToken) {
			adoptedCallbackToken, metadataChanged = runtime.CallbackToken, true
		}
		if runtime.WorkspaceDir == "" {
			runtime.WorkspaceDir = s.workspaceDirForRepo(workspaceID, runtime.Repository)
			metadataChanged = true
		}
		if runtime.ContainerLabelValue == "" {
			runtime.ContainerLabelValue = runtime.WorkspaceDir
			metadataChanged = true
		}
		if runtime.ContainerWorkDir == "" {
			runtime.ContainerWorkDir = s.defaultContainerWorkDir(runtime.WorkspaceDir, runtime.Repository)
			metadataChanged = true
		}
		if runtime.ContainerUser == "" {
			runtime.ContainerUser = strings.TrimSpace(s.config.ContainerUser)
		}
		// Apply optional fields under mutex to prevent data races
		if opt.GitUserName != "" {
			runtime.GitUserName = opt.GitUserName
		}
		if opt.GitUserEmail != "" {
			runtime.GitUserEmail = opt.GitUserEmail
		}
		if opt.GitHubID != "" {
			runtime.GitHubID = opt.GitHubID
		}
		if opt.BaseBranch != "" {
			runtime.BaseBranch = opt.BaseBranch
			metadataChanged = true
		}
		if opt.RepoProvider != "" {
			runtime.RepoProvider = opt.RepoProvider
			metadataChanged = true
		}
		if opt.CloneURL != "" {
			runtime.CloneURL = opt.CloneURL
			metadataChanged = true
		}
		if opt.RepositoryHost != "" {
			runtime.RepositoryHost = opt.RepositoryHost
			metadataChanged = true
		}
		if opt.RepositoryPath != "" {
			runtime.RepositoryPath = opt.RepositoryPath
			metadataChanged = true
		}
		if opt.Lightweight != nil {
			runtime.Lightweight = *opt.Lightweight
		}
		if opt.DevcontainerConfigName != "" {
			runtime.DevcontainerConfigName = opt.DevcontainerConfigName
		}
		if opt.DevcontainerCache.Ref != "" {
			runtime.DevcontainerCache = opt.DevcontainerCache
		}
		if opt.DefaultBranch != "" {
			runtime.DefaultBranch = opt.DefaultBranch
			metadataChanged = true
		}
		if opt.ProjectID != "" && runtime.ProjectID == "" {
			runtime.ProjectID = opt.ProjectID
			metadataChanged = true
		}
		if opt.ChatSessionID != "" {
			runtime.ChatSessionID = opt.ChatSessionID
			metadataChanged = true
		}
		if opt.TaskID != "" {
			runtime.TaskID = opt.TaskID
		}
		runtime.UpdatedAt = time.Now().UTC()

		if metadataChanged && runtime.Repository != "" && !runtime.MetadataUnavailable {
			s.persistWorkspaceMetadata(runtime)
		}
		runtimeCopy := *runtime
		resourceHistorySnapshot = &runtimeCopy
		return runtime
	}

	// Hydrate from SQLite persistence if available — this is the critical path
	// for recovering workspace metadata after an agent restart.
	effectiveRepo := repository
	effectiveBranch := branch
	var persistedWorkspaceDir, persistedContainerWorkDir, persistedContainerLabelValue, persistedContainerUser string
	var persistedCallbackToken string
	var persistedProjectID, persistedChatSessionID, persistedEvictionGeneration string
	var persistedBaseBranch, persistedDefaultBranch string
	var persistedRepoProvider, persistedCloneURL, persistedRepositoryHost, persistedRepositoryPath string
	var persistedLightweight, metadataUnavailable bool
	var persistedDevcontainerConfigName string

	if s.store != nil {
		meta, err := s.store.GetWorkspaceMetadata(workspaceID)
		if err != nil {
			slog.Warn("Failed to read persisted workspace metadata", "workspace", workspaceID, "error", err)
			metadataUnavailable = true
			status = "error"
		} else if meta != nil {
			slog.Info("Hydrated workspace metadata from SQLite",
				"workspace", workspaceID, "repository", meta.Repository,
				"containerWorkDir", meta.ContainerWorkDir)
			if effectiveRepo == "" && meta.Repository != "" {
				effectiveRepo = meta.Repository
			}
			if effectiveBranch == "" && meta.Branch != "" {
				effectiveBranch = meta.Branch
			}
			persistedWorkspaceDir = meta.WorkspaceDir
			persistedContainerWorkDir = meta.ContainerWorkDir
			persistedContainerLabelValue = meta.ContainerLabelVal
			persistedContainerUser = meta.ContainerUser
			persistedCallbackToken = meta.CallbackToken
			persistedRepoProvider = meta.RepoProvider
			persistedBaseBranch = meta.BaseBranch
			persistedDefaultBranch = meta.DefaultBranch
			persistedCloneURL = meta.CloneURL
			persistedRepositoryHost = meta.RepositoryHost
			persistedRepositoryPath = meta.RepositoryPath
			persistedProjectID = meta.ProjectID
			persistedChatSessionID = meta.ChatSessionID
			persistedEvictionGeneration = meta.EvictionGeneration
			if meta.Evicted {
				status = "evicted"
			}
			persistedLightweight = meta.Lightweight
			persistedDevcontainerConfigName = meta.DevcontainerConfigName
		}
	}

	workspaceDir := persistedWorkspaceDir
	if workspaceDir == "" {
		workspaceDir = s.workspaceDirForRepo(workspaceID, effectiveRepo)
	}
	containerLabelValue := persistedContainerLabelValue
	if containerLabelValue == "" {
		containerLabelValue = workspaceDir
	}
	containerWorkDir := persistedContainerWorkDir
	if containerWorkDir == "" {
		containerWorkDir = s.defaultContainerWorkDir(workspaceDir, effectiveRepo)
	}
	containerUser := persistedContainerUser
	if containerUser == "" {
		containerUser = strings.TrimSpace(s.config.ContainerUser)
	}

	manager := s.newPTYManagerForWorkspace(workspaceID, workspaceDir, containerWorkDir, containerLabelValue, containerUser)

	runtime = &WorkspaceRuntime{
		ID:                     workspaceID,
		Repository:             effectiveRepo,
		Branch:                 effectiveBranch,
		BaseBranch:             firstNonEmpty(opt.BaseBranch, persistedBaseBranch),
		RepoProvider:           firstNonEmpty(opt.RepoProvider, persistedRepoProvider),
		CloneURL:               firstNonEmpty(opt.CloneURL, persistedCloneURL),
		RepositoryHost:         firstNonEmpty(opt.RepositoryHost, persistedRepositoryHost),
		RepositoryPath:         firstNonEmpty(opt.RepositoryPath, persistedRepositoryPath),
		Status:                 status,
		CreatedAt:              time.Now().UTC(),
		UpdatedAt:              time.Now().UTC(),
		WorkspaceDir:           workspaceDir,
		ContainerLabelValue:    containerLabelValue,
		ContainerWorkDir:       containerWorkDir,
		ContainerUser:          containerUser,
		CallbackToken:          firstNonEmpty(strings.TrimSpace(callbackToken), strings.TrimSpace(persistedCallbackToken)),
		ProjectID:              firstNonEmpty(persistedProjectID, opt.ProjectID),
		ChatSessionID:          firstNonEmpty(opt.ChatSessionID, persistedChatSessionID),
		EvictionGeneration:     firstNonEmpty(persistedEvictionGeneration, opt.EvictionGeneration),
		MetadataUnavailable:    metadataUnavailable,
		TaskID:                 opt.TaskID,
		GitUserName:            opt.GitUserName,
		GitUserEmail:           opt.GitUserEmail,
		GitHubID:               opt.GitHubID,
		Lightweight:            (opt.Lightweight != nil && *opt.Lightweight) || persistedLightweight,
		DevcontainerConfigName: firstNonEmpty(opt.DevcontainerConfigName, persistedDevcontainerConfigName),
		DefaultBranch:          firstNonEmpty(opt.DefaultBranch, persistedDefaultBranch),
		DevcontainerCache:      opt.DevcontainerCache,
		PTY:                    manager,
	}
	s.workspaces[workspaceID] = runtime
	adoptedCallbackToken = runtime.CallbackToken
	runtimeCopy := *runtime
	resourceHistorySnapshot = &runtimeCopy

	if effectiveRepo != "" && !metadataUnavailable {
		s.persistWorkspaceMetadata(runtime)
	}
	return runtime
}

// casWorkspaceStatus performs a compare-and-swap status transition.
// It only sets the new status if the current status is one of the expected values.
// Returns true if the transition was applied, false if the current status did not match.
func (s *Server) casWorkspaceStatus(workspaceID string, expectedStatuses []string, newStatus string) bool {
	s.workspaceMu.Lock()
	defer s.workspaceMu.Unlock()

	runtime, ok := s.workspaces[workspaceID]
	if !ok {
		return false
	}

	for _, expected := range expectedStatuses {
		if runtime.Status == expected {
			runtime.Status = newStatus
			runtime.UpdatedAt = nowUTC()
			return true
		}
	}
	return false
}

func (s *Server) removeWorkspaceRuntime(workspaceID string) {
	s.stopResourceHistoryForWorkspace(workspaceID, context.Background())
	s.workspaceMu.Lock()
	defer func() {
		s.workspaceMu.Unlock()
		s.clearRemovedWorkspaceRestores(workspaceID)
	}()

	if runtime, ok := s.workspaces[workspaceID]; ok {
		runtime.PTY.CloseAllSessions()
		delete(s.workspaces, workspaceID)
	}
	delete(s.workspaceEvents, workspaceID)
	s.agentSessions.RemoveWorkspace(workspaceID)

	if s.store != nil {
		if err := s.store.DeleteWorkspaceMetadata(workspaceID); err != nil {
			slog.Warn("Failed to delete persisted workspace metadata", "workspace", workspaceID, "error", err)
		}
	}
}

func (s *Server) workspaceSessionCount(workspaceID string) int {
	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		return 0
	}
	return runtime.PTY.SessionCount()
}

func (s *Server) workspaceDirForRuntime(workspaceID string) string {
	return s.workspaceDirForRepo(workspaceID, "")
}

// workspaceDirForRepo derives the host workspace directory.
// In multi-workspace mode this MUST be keyed by canonical workspace ID to ensure
// isolation even when multiple workspaces use the same repository.
func (s *Server) workspaceDirForRepo(workspaceID, repository string) string {
	baseDir := strings.TrimSpace(s.config.WorkspaceDir)
	if baseDir == "" {
		baseDir = "/workspace"
	}
	// In single-workspace mode, WorkspaceDir may already include the repo path.
	// Keep using that when the IDs match to preserve compatibility.
	if strings.TrimSpace(s.config.WorkspaceID) != "" && workspaceID == strings.TrimSpace(s.config.WorkspaceID) {
		return baseDir
	}

	if safeWorkspaceID := sanitizeWorkspaceRuntimeID(workspaceID); safeWorkspaceID != "" {
		return filepath.Join(baseDir, safeWorkspaceID)
	}

	// Fallback when workspace ID is unavailable (legacy/defensive path).
	repoDir := repositoryDirName(repository)
	if repoDir != "" {
		return filepath.Join(baseDir, repoDir)
	}
	return baseDir
}

func sanitizeWorkspaceRuntimeID(workspaceID string) string {
	safeWorkspaceID := strings.TrimSpace(workspaceID)
	if safeWorkspaceID == "" {
		return ""
	}
	safeWorkspaceID = strings.ReplaceAll(safeWorkspaceID, "/", "-")
	safeWorkspaceID = strings.ReplaceAll(safeWorkspaceID, "\\", "-")
	return safeWorkspaceID
}

func deriveContainerWorkDirForRepo(workspaceDir, repository string) string {
	if repoDir := repositoryDirName(repository); repoDir != "" {
		return filepath.Join("/workspaces", repoDir)
	}
	return deriveContainerWorkDir(workspaceDir)
}

func (s *Server) defaultContainerWorkDir(workspaceDir, repository string) string {
	if s != nil && s.config != nil && s.config.IsStandaloneMode() {
		if configured := strings.TrimSpace(s.config.ContainerWorkDir); configured != "" {
			return configured
		}
	}
	return deriveContainerWorkDirForRepo(workspaceDir, repository)
}

func deriveContainerWorkDir(workspaceDir string) string {
	trimmed := strings.TrimSpace(workspaceDir)
	if trimmed == "" {
		return "/workspaces"
	}
	base := filepath.Base(trimmed)
	if base == "" || base == "." || base == "/" {
		return "/workspaces"
	}
	return filepath.Join("/workspaces", base)
}

func (s *Server) appendNodeEvent(workspaceID, level, eventType, message string, detail map[string]interface{}) {
	now := time.Now().UTC().Format(time.RFC3339)
	event := EventRecord{
		ID:          randomEventID(),
		NodeID:      s.config.NodeID,
		WorkspaceID: workspaceID,
		Level:       level,
		Type:        eventType,
		Message:     message,
		Detail:      detail,
		CreatedAt:   now,
	}

	// Persist to SQLite (durable, survives restarts, downloadable).
	if s.eventStore != nil {
		s.eventStore.Append(eventstore.EventRecord(event))
	}

	// Also keep in-memory for backward-compat with existing API response format.
	s.eventMu.Lock()
	defer s.eventMu.Unlock()

	maxNode := s.config.MaxNodeEvents
	if maxNode <= 0 {
		maxNode = 500
	}
	maxWs := s.config.MaxWorkspaceEvents
	if maxWs <= 0 {
		maxWs = 500
	}

	s.nodeEvents = append([]EventRecord{event}, s.nodeEvents...)
	if len(s.nodeEvents) > maxNode {
		s.nodeEvents = s.nodeEvents[:maxNode]
	}

	if workspaceID != "" {
		s.workspaceEvents[workspaceID] = append([]EventRecord{event}, s.workspaceEvents[workspaceID]...)
		if len(s.workspaceEvents[workspaceID]) > maxWs {
			s.workspaceEvents[workspaceID] = s.workspaceEvents[workspaceID][:maxWs]
		}
	}
}

func randomEventID() string {
	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}
