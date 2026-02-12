package server

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/container"
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
		if repository != "" {
			runtime.Repository = repository
		}
		if branch != "" {
			runtime.Branch = branch
		}
		if status != "" {
			runtime.Status = status
		}
		if callbackToken != "" {
			runtime.CallbackToken = strings.TrimSpace(callbackToken)
		}
		if runtime.WorkspaceDir == "" {
			runtime.WorkspaceDir = s.workspaceDirForRuntime(workspaceID)
		}
		if runtime.ContainerLabelValue == "" {
			runtime.ContainerLabelValue = runtime.WorkspaceDir
		}
		if runtime.ContainerWorkDir == "" {
			runtime.ContainerWorkDir = deriveContainerWorkDir(runtime.WorkspaceDir)
		}
		runtime.UpdatedAt = time.Now().UTC()
		return runtime
	}

	workspaceDir := s.workspaceDirForRuntime(workspaceID)
	containerLabelValue := workspaceDir
	containerWorkDir := deriveContainerWorkDir(workspaceDir)

	workDir := workspaceDir
	if s.config.ContainerMode {
		workDir = containerWorkDir
	}

	config := pty.ManagerConfig{
		DefaultShell:      s.config.DefaultShell,
		DefaultRows:       s.config.DefaultRows,
		DefaultCols:       s.config.DefaultCols,
		WorkDir:           workDir,
		ContainerResolver: s.ptyManagerContainerResolverForLabel(containerLabelValue),
		ContainerUser:     s.config.ContainerUser,
		GracePeriod:       s.config.PTYOrphanGracePeriod,
		BufferSize:        s.config.PTYOutputBufferSize,
	}

	manager := pty.NewManager(config)
	// Preserve compatibility with single-workspace mode.
	if s.ptyManager != nil && ((s.config.WorkspaceID != "" && workspaceID == s.config.WorkspaceID) || (!s.config.ContainerMode && len(s.workspaces) == 0)) {
		manager = s.ptyManager
	}

	runtime = &WorkspaceRuntime{
		ID:                  workspaceID,
		Repository:          repository,
		Branch:              branch,
		Status:              status,
		CreatedAt:           time.Now().UTC(),
		UpdatedAt:           time.Now().UTC(),
		WorkspaceDir:        workspaceDir,
		ContainerLabelValue: containerLabelValue,
		ContainerWorkDir:    containerWorkDir,
		CallbackToken:       strings.TrimSpace(callbackToken),
		PTY:                 manager,
	}
	s.workspaces[workspaceID] = runtime
	return runtime
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
}

func (s *Server) workspaceSessionCount(workspaceID string) int {
	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		return 0
	}
	return runtime.PTY.SessionCount()
}

func (s *Server) workspaceDirForRuntime(workspaceID string) string {
	baseDir := strings.TrimSpace(s.config.WorkspaceDir)
	if baseDir == "" {
		baseDir = "/workspace"
	}
	// In single-workspace mode, WorkspaceDir may already include the repo path.
	// Keep using that when the IDs match to preserve compatibility.
	if strings.TrimSpace(s.config.WorkspaceID) != "" && workspaceID == strings.TrimSpace(s.config.WorkspaceID) {
		return baseDir
	}

	safeWorkspaceID := strings.TrimSpace(workspaceID)
	if safeWorkspaceID == "" {
		return baseDir
	}
	safeWorkspaceID = strings.ReplaceAll(safeWorkspaceID, string(filepath.Separator), "-")
	return filepath.Join(baseDir, safeWorkspaceID)
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

	s.nodeEvents = append([]EventRecord{event}, s.nodeEvents...)
	if len(s.nodeEvents) > 500 {
		s.nodeEvents = s.nodeEvents[:500]
	}

	if workspaceID != "" {
		s.workspaceEvents[workspaceID] = append([]EventRecord{event}, s.workspaceEvents[workspaceID]...)
		if len(s.workspaceEvents[workspaceID]) > 500 {
			s.workspaceEvents[workspaceID] = s.workspaceEvents[workspaceID][:500]
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

	resolvedLabel := strings.TrimSpace(labelValue)
	if resolvedLabel == "" {
		resolvedLabel = strings.TrimSpace(s.config.ContainerLabelValue)
	}
	if resolvedLabel == "" {
		resolvedLabel = strings.TrimSpace(s.config.WorkspaceDir)
	}
	if resolvedLabel == "" {
		resolvedLabel = "/workspace"
	}

	discovery := container.NewDiscovery(container.Config{
		LabelKey:   s.config.ContainerLabelKey,
		LabelValue: resolvedLabel,
		CacheTTL:   s.config.ContainerCacheTTL,
	})
	return discovery.GetContainerID
}
