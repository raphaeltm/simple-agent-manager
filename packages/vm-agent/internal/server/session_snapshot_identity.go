package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
)

// bindHibernateRequestRuntime persists the callback token and chat binding a hibernate
// request carries. A freshly-woken container never ran create-workspace, so its
// runtime.CallbackToken (used by the message reporter and the snapshot callbacks) is unset
// until the control plane delivers one here.
//
// Both writes bump the runtime's UpdatedAt, and an eviction records itself only while
// UpdatedAt still equals the runtime version it stopped (markWorkspaceEvicted). So they run
// under the workspace lifecycle lock, and not at all while an eviction is finalizing.
func (s *Server) bindHibernateRequestRuntime(ctx context.Context, workspaceID, chatSessionID, workspaceCallbackToken string) (int, error) {
	lock := s.workspaceLifecycleLock(workspaceID)
	if err := lock.Lock(ctx); err != nil {
		return http.StatusRequestTimeout, errors.New("workspace lifecycle operation canceled")
	}
	defer lock.Unlock()
	if err := s.requireWorkspaceNotEvicting(workspaceID); err != nil {
		return http.StatusConflict, err
	}
	if wsToken := strings.TrimSpace(workspaceCallbackToken); wsToken != "" {
		s.upsertWorkspaceRuntime(workspaceID, "", "", "", wsToken, workspaceRuntimeOpts{ChatSessionID: chatSessionID})
	}
	s.recordWorkspaceChatSessionID(workspaceID, chatSessionID)
	return 0, nil
}

func (s *Server) recordWorkspaceChatSessionID(workspaceID, chatSessionID string) {
	chatSessionID = strings.TrimSpace(chatSessionID)
	if workspaceID == "" || chatSessionID == "" {
		return
	}

	var updated *WorkspaceRuntime
	s.workspaceMu.Lock()
	if rt, ok := s.workspaces[workspaceID]; ok && rt != nil && strings.TrimSpace(rt.ChatSessionID) != chatSessionID {
		rt.ChatSessionID = chatSessionID
		rt.UpdatedAt = nowUTC()
		copy := *rt
		updated = &copy
	}
	s.workspaceMu.Unlock()
	if updated != nil && updated.Repository != "" {
		s.persistWorkspaceMetadata(updated)
	}
}

func (s *Server) populateSnapshotHarnessIdentity(manifest *snapshotManifest, workspaceID, sessionID, capturedAcpSessionID, capturedAgentType string) {
	if manifest == nil {
		return
	}
	if s.agentSessions != nil {
		if session, exists := s.agentSessions.Get(workspaceID, sessionID); exists {
			if acpSessionID := strings.TrimSpace(session.AcpSessionID); acpSessionID != "" {
				manifest.AcpSessionID = acpSessionID
			}
			if agentType := strings.TrimSpace(session.AgentType); agentType != "" {
				manifest.AgentType = agentType
			}
		}
	}
	if strings.TrimSpace(manifest.AcpSessionID) == "" {
		manifest.AcpSessionID = strings.TrimSpace(capturedAcpSessionID)
	}
	if strings.TrimSpace(manifest.AgentType) == "" {
		manifest.AgentType = strings.TrimSpace(capturedAgentType)
	}
}
