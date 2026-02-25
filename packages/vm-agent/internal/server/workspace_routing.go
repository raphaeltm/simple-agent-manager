package server

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/container"
	"github.com/workspace/vm-agent/internal/persistence"
	"github.com/workspace/vm-agent/internal/pty"
)

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

	session := s.sessionManager.GetSessionFromRequest(r)
	if session != nil {
		if session.Claims == nil {
			writeError(w, http.StatusUnauthorized, "invalid session claims")
			return false
		}
		if session.Claims.Workspace == "" || session.Claims.Workspace != workspaceID {
			writeError(w, http.StatusForbidden, "workspace claim mismatch")
			return false
		}
		return true
	}

	token := strings.TrimSpace(r.URL.Query().Get("token"))
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
	s.sessionManager.SetCookie(w, createdSession)
	return true
}

func (s *Server) getWorkspaceRuntime(workspaceID string) (*WorkspaceRuntime, bool) {
	s.workspaceMu.RLock()
	defer s.workspaceMu.RUnlock()
	runtime, ok := s.workspaces[workspaceID]
	return runtime, ok
}

func (s *Server) upsertWorkspaceRuntime(workspaceID, repository, branch, status, callbackToken string) *WorkspaceRuntime {
	s.workspaceMu.Lock()
	defer s.workspaceMu.Unlock()

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
		if status != "" {
			runtime.Status = status
		}
		if callbackToken != "" {
			runtime.CallbackToken = strings.TrimSpace(callbackToken)
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
			runtime.ContainerWorkDir = deriveContainerWorkDirForRepo(runtime.WorkspaceDir, runtime.Repository)
			metadataChanged = true
		}
		if runtime.ContainerUser == "" {
			runtime.ContainerUser = strings.TrimSpace(s.config.ContainerUser)
		}
		runtime.UpdatedAt = time.Now().UTC()

		if metadataChanged && runtime.Repository != "" {
			s.persistWorkspaceMetadata(runtime)
		}
		return runtime
	}

	// Hydrate from SQLite persistence if available — this is the critical path
	// for recovering workspace metadata after an agent restart.
	effectiveRepo := repository
	effectiveBranch := branch
	var persistedWorkspaceDir, persistedContainerWorkDir, persistedContainerLabelValue, persistedContainerUser string

	if s.store != nil {
		meta, err := s.store.GetWorkspaceMetadata(workspaceID)
		if err != nil {
			slog.Warn("Failed to read persisted workspace metadata", "workspace", workspaceID, "error", err)
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
		containerWorkDir = deriveContainerWorkDirForRepo(workspaceDir, effectiveRepo)
	}
	containerUser := persistedContainerUser
	if containerUser == "" {
		containerUser = strings.TrimSpace(s.config.ContainerUser)
	}

	manager := s.newPTYManagerForWorkspace(workspaceID, workspaceDir, containerWorkDir, containerLabelValue, containerUser)

	runtime = &WorkspaceRuntime{
		ID:                  workspaceID,
		Repository:          effectiveRepo,
		Branch:              effectiveBranch,
		Status:              status,
		CreatedAt:           time.Now().UTC(),
		UpdatedAt:           time.Now().UTC(),
		WorkspaceDir:        workspaceDir,
		ContainerLabelValue: containerLabelValue,
		ContainerWorkDir:    containerWorkDir,
		ContainerUser:       containerUser,
		CallbackToken:       strings.TrimSpace(callbackToken),
		PTY:                 manager,
	}
	s.workspaces[workspaceID] = runtime

	if effectiveRepo != "" {
		s.persistWorkspaceMetadata(runtime)
	}
	return runtime
}

func (s *Server) newPTYManagerForWorkspace(
	workspaceID,
	workspaceDir,
	containerWorkDir,
	containerLabelValue,
	containerUser string,
) *pty.Manager {
	workDir := workspaceDir
	if s.config.ContainerMode {
		workDir = containerWorkDir
	}
	resolvedContainerUser := strings.TrimSpace(containerUser)
	if resolvedContainerUser == "" {
		resolvedContainerUser = strings.TrimSpace(s.config.ContainerUser)
	}

	config := pty.ManagerConfig{
		DefaultShell:      s.config.DefaultShell,
		DefaultRows:       s.config.DefaultRows,
		DefaultCols:       s.config.DefaultCols,
		WorkDir:           workDir,
		ContainerResolver: s.ptyManagerContainerResolverForLabel(containerLabelValue),
		ContainerUser:     resolvedContainerUser,
		GracePeriod:       s.config.PTYOrphanGracePeriod,
		BufferSize:        s.config.PTYOutputBufferSize,
	}

	manager := pty.NewManager(config)
	if s.shouldReusePrimaryPTYManager(workspaceID, workspaceDir, containerWorkDir, containerLabelValue) {
		return s.ptyManager
	}

	return manager
}

func (s *Server) shouldReusePrimaryPTYManager(workspaceID, workspaceDir, containerWorkDir, containerLabelValue string) bool {
	if s == nil || s.ptyManager == nil {
		return false
	}

	// Preserve compatibility with legacy single-workspace host mode.
	if !s.config.ContainerMode && len(s.workspaces) == 0 {
		return true
	}

	configuredWorkspaceID := strings.TrimSpace(s.config.WorkspaceID)
	if configuredWorkspaceID == "" || strings.TrimSpace(workspaceID) != configuredWorkspaceID {
		return false
	}

	expectedWorkspaceDir := strings.TrimSpace(s.workspaceDirForRuntime(configuredWorkspaceID))
	if expectedWorkspaceDir == "" {
		expectedWorkspaceDir = "/workspace"
	}
	if strings.TrimSpace(workspaceDir) != expectedWorkspaceDir {
		return false
	}

	if !s.config.ContainerMode {
		return true
	}

	expectedContainerLabel := strings.TrimSpace(s.config.ContainerLabelValue)
	if expectedContainerLabel == "" {
		expectedContainerLabel = expectedWorkspaceDir
	}
	if strings.TrimSpace(containerLabelValue) != expectedContainerLabel {
		return false
	}

	expectedContainerWorkDir := strings.TrimSpace(s.config.ContainerWorkDir)
	if expectedContainerWorkDir == "" {
		expectedContainerWorkDir = deriveContainerWorkDirForRepo(expectedWorkspaceDir, s.config.Repository)
	}
	if strings.TrimSpace(containerWorkDir) != expectedContainerWorkDir {
		return false
	}

	return true
}

func (s *Server) rebuildWorkspacePTYManager(runtime *WorkspaceRuntime) {
	if runtime == nil {
		return
	}
	if runtime.PTY != nil && runtime.PTY.SessionCount() > 0 {
		return
	}
	runtime.PTY = s.newPTYManagerForWorkspace(
		runtime.ID,
		strings.TrimSpace(runtime.WorkspaceDir),
		strings.TrimSpace(runtime.ContainerWorkDir),
		strings.TrimSpace(runtime.ContainerLabelValue),
		strings.TrimSpace(runtime.ContainerUser),
	)
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
	s.workspaceMu.Lock()
	defer s.workspaceMu.Unlock()

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

// persistWorkspaceMetadata writes workspace runtime state to SQLite for
// recovery after agent restarts. Called outside the workspace mutex since
// the store has its own locking.
func (s *Server) persistWorkspaceMetadata(runtime *WorkspaceRuntime) {
	if s.store == nil || runtime == nil {
		return
	}
	if err := s.store.UpsertWorkspaceMetadata(persistence.WorkspaceMetadata{
		WorkspaceID:       runtime.ID,
		Repository:        runtime.Repository,
		Branch:            runtime.Branch,
		ContainerWorkDir:  runtime.ContainerWorkDir,
		ContainerUser:     runtime.ContainerUser,
		ContainerLabelVal: runtime.ContainerLabelValue,
		WorkspaceDir:      runtime.WorkspaceDir,
	}); err != nil {
		slog.Warn("Failed to persist workspace metadata", "workspace", runtime.ID, "error", err)
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

// pty.Manager does not expose its resolver, so we derive from config.
func (s *Server) ptyManagerContainerResolver() pty.ContainerResolver {
	if !s.config.ContainerMode {
		return nil
	}
	return s.ptyManagerContainerResolverFromConfig()
}

func (s *Server) ptyManagerContainerResolverFromConfig() pty.ContainerResolver {
	return s.ptyManagerContainerResolverForLabel(s.config.ContainerLabelValue)
}

func (s *Server) ptyManagerContainerResolverForLabel(labelValue string) pty.ContainerResolver {
	if !s.config.ContainerMode {
		return nil
	}

	requestedLabel := strings.TrimSpace(labelValue)
	labelCandidates := []string{}
	if requestedLabel != "" {
		// Workspace-scoped lookups must be strict to avoid cross-workspace routing
		// when multiple containers share repo-derived or legacy label values.
		labelCandidates = containerLabelCandidates(requestedLabel)
	} else {
		labelCandidates = containerLabelCandidates(
			s.config.ContainerLabelValue,
			s.config.WorkspaceDir,
			"/workspace",
		)
	}
	if len(labelCandidates) == 0 {
		return nil
	}

	discoveries := make([]*container.Discovery, 0, len(labelCandidates))
	for _, candidate := range labelCandidates {
		discoveries = append(discoveries, container.NewDiscovery(container.Config{
			LabelKey:   s.config.ContainerLabelKey,
			LabelValue: candidate,
			CacheTTL:   s.config.ContainerCacheTTL,
		}))
	}

	return func() (string, error) {
		var lastErr error
		for _, discovery := range discoveries {
			containerID, err := discovery.GetContainerID()
			if err == nil {
				return containerID, nil
			}
			lastErr = err
		}
		if lastErr != nil {
			return "", lastErr
		}
		return "", fmt.Errorf("no container label candidates configured")
	}
}

func containerLabelCandidates(values ...string) []string {
	candidates := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		candidates = append(candidates, trimmed)
	}
	return candidates
}
