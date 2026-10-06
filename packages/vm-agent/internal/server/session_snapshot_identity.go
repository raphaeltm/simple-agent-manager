package server

import "strings"

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
