package server

import (
	"context"
	"fmt"
	"strings"

	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/persistence"
)

// This proof is process-local. Persisted tabs lack snapshot-apply provenance,
// so neither create nor restore adopts them after an agent restart. Completed
// attempts remain cached: replaying HOME/WIP could overwrite subsequent edits.
type sessionRestoreAttempt struct {
	chatSessionID string
	agentType     string
	done          chan struct{}
	result        map[string]interface{}
	err           error
}

func (s *Server) runSessionRestore(ctx context.Context, input *sessionSnapshotHandlerInput, restore func() map[string]interface{}) (map[string]interface{}, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := s.validateSessionRestoreIdentity(input.workspaceID, input.sessionID, input.chatSessionID, input.agentType); err != nil {
		return nil, err
	}
	key := input.workspaceID + ":" + input.sessionID
	s.sessionHostMu.Lock()
	if existing := s.sessionRestores[key]; existing != nil {
		s.sessionHostMu.Unlock()
		if existing.chatSessionID != input.chatSessionID || existing.agentType != input.agentType {
			return nil, fmt.Errorf("session restore identity conflicts")
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("wait for session restore: %w", ctx.Err())
		case <-existing.done:
			return existing.result, existing.err
		}
	}
	// Admission and ordinary host creation share sessionHostMu, including the
	// host factory's post-I/O recheck. Snapshot files belong to the workspace,
	// so no sibling session or host may have begun using them either.
	if s.workspaceCreationPendingLocked(input.workspaceID) {
		s.sessionHostMu.Unlock()
		return nil, fmt.Errorf("workspace session creation is still in progress")
	}
	session, exists := s.agentSessions.Get(input.workspaceID, input.sessionID)
	s.workspaceMu.RLock()
	runtime := s.workspaces[input.workspaceID]
	projectID := ""
	if runtime != nil {
		projectID = runtime.ProjectID
	}
	s.workspaceMu.RUnlock()
	if !exists || !session.MatchesRouting(projectID, input.chatSessionID) || session.Status != agentsessions.StatusRunning || session.AcpSessionID != "" || session.AgentType != "" || session.LastPrompt != "" || len(s.agentSessions.List(input.workspaceID)) != 1 {
		s.sessionHostMu.Unlock()
		return nil, fmt.Errorf("session restore requires a pristine workspace session")
	}
	for hostKey := range s.sessionHosts {
		if strings.HasPrefix(hostKey, input.workspaceID+":") {
			s.sessionHostMu.Unlock()
			return nil, fmt.Errorf("workspace already has an agent host; snapshot restore refused")
		}
	}
	// Start registers its profile intent before installing runtime settings. This
	// closes the gap between start admission and subsequent host creation.
	for hostKey := range s.sessionProfileOvr {
		if strings.HasPrefix(hostKey, input.workspaceID+":") {
			s.sessionHostMu.Unlock()
			return nil, fmt.Errorf("workspace agent start already admitted; snapshot restore refused")
		}
	}
	if s.workspaceRestorePendingLocked(input.workspaceID) {
		s.sessionHostMu.Unlock()
		return nil, fmt.Errorf("workspace snapshot restore already in progress")
	}
	attempt := &sessionRestoreAttempt{
		chatSessionID: input.chatSessionID, agentType: input.agentType,
		done: make(chan struct{}), err: fmt.Errorf("session restore did not finish"),
	}
	if s.sessionRestores == nil {
		s.sessionRestores = make(map[string]*sessionRestoreAttempt)
	}
	s.sessionRestores[key] = attempt
	s.sessionHostMu.Unlock()
	defer func() {
		close(attempt.done)
		s.clearRemovedWorkspaceRestores(input.workspaceID)
	}()
	// Persist a non-adoption fence before token, HOME/WIP, or ACP effects.
	if err := s.persistSessionRestoreFence(input.workspaceID, input.sessionID); err != nil {
		attempt.err = err
		return nil, err
	}
	// Only the reserved operation may replace routing credentials.
	if input.workspaceCallbackToken != "" {
		s.upsertWorkspaceRuntime(input.workspaceID, "", "", "", input.workspaceCallbackToken)
	}
	attempt.result = restore()
	attempt.err = nil
	return attempt.result, nil
}

// A deletion first removes the runtime/registry, then releases completed
// attempts. An in-flight restore retains its fence until it actually returns.
func (s *Server) clearRemovedWorkspaceRestores(workspaceID string) {
	s.workspaceMu.RLock()
	_, exists := s.workspaces[workspaceID]
	s.workspaceMu.RUnlock()
	if exists {
		return
	}
	s.sessionHostMu.Lock()
	defer s.sessionHostMu.Unlock()
	for key, attempt := range s.sessionRestores {
		if strings.HasPrefix(key, workspaceID+":") {
			select {
			case <-attempt.done:
				delete(s.sessionRestores, key)
			default:
			}
		}
	}
}

// Caller holds sessionHostMu. Ordinary host creation checks this at both lock
// boundaries, while the restore owner uses its explicit host factory path.
func (s *Server) workspaceRestorePendingLocked(workspaceID string) bool {
	for key, attempt := range s.sessionRestores {
		if !strings.HasPrefix(key, workspaceID+":") {
			continue
		}
		select {
		case <-attempt.done:
		default:
			return true
		}
	}
	return false
}

func (s *Server) workspaceCreationPendingLocked(workspaceID string) bool {
	for key := range s.sessionCreations {
		if strings.HasPrefix(key, workspaceID+":") {
			return true
		}
	}
	return false
}

func (s *Server) validateSessionRestoreIdentity(workspaceID, sessionID, chatSessionID, agentType string) error {
	s.workspaceMu.RLock()
	runtime := s.workspaces[workspaceID]
	projectID := ""
	if runtime != nil {
		projectID = runtime.ProjectID
	}
	s.workspaceMu.RUnlock()
	session, exists := s.agentSessions.Get(workspaceID, sessionID)
	if !exists || !session.MatchesRouting(projectID, chatSessionID) {
		return fmt.Errorf("session restore identity or state conflicts")
	}
	s.sessionHostMu.Lock()
	attempt := s.sessionRestores[workspaceID+":"+sessionID]
	s.sessionHostMu.Unlock()
	if attempt != nil && (attempt.chatSessionID != chatSessionID || attempt.agentType != agentType) {
		return fmt.Errorf("session restore identity conflicts")
	}
	return nil
}

// Fresh CF-container wakes call restore without create. Bind that first session
// to launch configuration; persisted/reloaded or unrelated sessions fail closed.
func (s *Server) initializeStandaloneRestoreSession(workspaceID, sessionID, chatSessionID, runtimeName string) error {
	s.sessionHostMu.Lock()
	defer s.sessionHostMu.Unlock()
	if _, exists := s.agentSessions.Get(workspaceID, sessionID); exists {
		return nil
	}
	if runtimeName != "cf-container" || !s.config.IsStandaloneMode() || s.config.WorkspaceID != workspaceID || s.config.ChatSessionID != chatSessionID || s.config.ProjectID == "" {
		return fmt.Errorf("session restore identity or state conflicts")
	}
	s.workspaceMu.RLock()
	runtime := s.workspaces[workspaceID]
	matchesProject := runtime != nil && runtime.ProjectID == s.config.ProjectID
	s.workspaceMu.RUnlock()
	if !matchesProject || len(s.agentSessions.List(workspaceID)) != 0 {
		return fmt.Errorf("standalone restore is not a fresh configured session")
	}
	if s.store == nil {
		return fmt.Errorf("session restore persistence is unavailable")
	}
	tabs, err := s.store.ListTabs(workspaceID)
	if err != nil || len(tabs) != 0 {
		return fmt.Errorf("persisted session requires reconnect before bootstrap retry")
	}
	_, _, err = s.agentSessions.CreateRoutedOnEmptyWorkspace(workspaceID, sessionID, s.config.ProjectID, chatSessionID)
	return err
}

func (s *Server) persistSessionRestoreFence(workspaceID, sessionID string) error {
	if s.store == nil {
		return fmt.Errorf("session restore persistence is unavailable")
	}
	tabs, err := s.store.ListTabs(workspaceID)
	if err != nil {
		return fmt.Errorf("verify session restore persistence: %w", err)
	}
	found := false
	for _, tab := range tabs {
		if tab.ID != sessionID {
			return fmt.Errorf("workspace contains another persisted tab; snapshot restore refused")
		}
		found = true
	}
	if found {
		return nil
	}
	session, exists := s.agentSessions.Get(workspaceID, sessionID)
	if !exists {
		return fmt.Errorf("session restore identity is unavailable")
	}
	if err := s.store.InsertTab(persistence.Tab{ID: sessionID, WorkspaceID: workspaceID, Type: "chat", Label: session.Label, AgentID: session.AgentType, AcpSessionID: session.AcpSessionID, SortOrder: len(tabs)}); err != nil {
		return fmt.Errorf("persist session restore fence: %w", err)
	}
	return nil
}
