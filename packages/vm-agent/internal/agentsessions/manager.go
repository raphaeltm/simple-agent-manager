package agentsessions

import (
	"fmt"
	"sort"
	"sync"
	"time"
)

type Status string

const (
	StatusRunning   Status = "running"
	StatusSuspended Status = "suspended"
	StatusStopped   Status = "stopped"
	StatusError     Status = "error"
)

type Session struct {
	ID           string     `json:"id"`
	WorkspaceID  string     `json:"workspaceId"`
	Status       Status     `json:"status"`
	Label        string     `json:"label,omitempty"`
	AgentType    string     `json:"agentType,omitempty"`
	AcpSessionID string     `json:"acpSessionId,omitempty"`
	LastPrompt   string     `json:"lastPrompt,omitempty"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
	StoppedAt    *time.Time `json:"stoppedAt,omitempty"`
	SuspendedAt  *time.Time `json:"suspendedAt,omitempty"`
	Error        string     `json:"errorMessage,omitempty"`
}

type Manager struct {
	mu                sync.RWMutex
	workspaceSessions map[string]map[string]Session
	idempotency       map[string]string
}

func NewManager() *Manager {
	return &Manager{
		workspaceSessions: make(map[string]map[string]Session),
		idempotency:       make(map[string]string),
	}
}

func (m *Manager) Create(workspaceID, sessionID, label, idempotencyKey string) (Session, bool, error) {
	if workspaceID == "" {
		return Session{}, false, fmt.Errorf("workspace ID is required")
	}
	if sessionID == "" {
		return Session{}, false, fmt.Errorf("session ID is required")
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if idempotencyKey != "" {
		if existingID, ok := m.idempotency[m.idempotencyKey(workspaceID, idempotencyKey)]; ok {
			if ws, ok := m.workspaceSessions[workspaceID]; ok {
				if session, ok := ws[existingID]; ok {
					return session, true, nil
				}
			}
		}
	}

	if _, ok := m.workspaceSessions[workspaceID]; !ok {
		m.workspaceSessions[workspaceID] = make(map[string]Session)
	}

	if _, exists := m.workspaceSessions[workspaceID][sessionID]; exists {
		return Session{}, false, fmt.Errorf("session already exists: %s", sessionID)
	}

	now := time.Now().UTC()
	session := Session{
		ID:          sessionID,
		WorkspaceID: workspaceID,
		Status:      StatusRunning,
		Label:       label,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	m.workspaceSessions[workspaceID][sessionID] = session
	if idempotencyKey != "" {
		m.idempotency[m.idempotencyKey(workspaceID, idempotencyKey)] = sessionID
	}
	return session, false, nil
}

func (m *Manager) Stop(workspaceID, sessionID string) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	workspaceMap, ok := m.workspaceSessions[workspaceID]
	if !ok {
		return Session{}, fmt.Errorf("workspace not found: %s", workspaceID)
	}

	session, ok := workspaceMap[sessionID]
	if !ok {
		return Session{}, fmt.Errorf("session not found: %s", sessionID)
	}

	if session.Status == StatusStopped {
		return session, nil
	}

	now := time.Now().UTC()
	session.Status = StatusStopped
	session.UpdatedAt = now
	session.StoppedAt = &now
	workspaceMap[sessionID] = session
	return session, nil
}

// Suspend transitions a session to suspended status. The AcpSessionID is
// preserved so the session can later be resumed via LoadSession.
func (m *Manager) Suspend(workspaceID, sessionID string) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	workspaceMap, ok := m.workspaceSessions[workspaceID]
	if !ok {
		return Session{}, fmt.Errorf("workspace not found: %s", workspaceID)
	}

	session, ok := workspaceMap[sessionID]
	if !ok {
		return Session{}, fmt.Errorf("session not found: %s", sessionID)
	}

	if session.Status != StatusRunning && session.Status != StatusError {
		return Session{}, fmt.Errorf("session cannot be suspended from status %s", session.Status)
	}

	now := time.Now().UTC()
	session.Status = StatusSuspended
	session.SuspendedAt = &now
	session.UpdatedAt = now
	session.Error = ""
	workspaceMap[sessionID] = session
	return session, nil
}

// Resume transitions a session from suspended back to running.
func (m *Manager) Resume(workspaceID, sessionID string) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	workspaceMap, ok := m.workspaceSessions[workspaceID]
	if !ok {
		return Session{}, fmt.Errorf("workspace not found: %s", workspaceID)
	}

	session, ok := workspaceMap[sessionID]
	if !ok {
		return Session{}, fmt.Errorf("session not found: %s", sessionID)
	}

	if session.Status != StatusSuspended {
		return Session{}, fmt.Errorf("session cannot be resumed from status %s", session.Status)
	}

	now := time.Now().UTC()
	session.Status = StatusRunning
	session.SuspendedAt = nil
	session.UpdatedAt = now
	workspaceMap[sessionID] = session
	return session, nil
}

// UpdateLastPrompt stores the last user message for discoverability in session history.
func (m *Manager) UpdateLastPrompt(workspaceID, sessionID, lastPrompt string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	workspaceMap, ok := m.workspaceSessions[workspaceID]
	if !ok {
		return fmt.Errorf("workspace not found: %s", workspaceID)
	}

	session, ok := workspaceMap[sessionID]
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	session.LastPrompt = lastPrompt
	session.UpdatedAt = time.Now().UTC()
	workspaceMap[sessionID] = session
	return nil
}

func (m *Manager) List(workspaceID string) []Session {
	m.mu.RLock()
	defer m.mu.RUnlock()

	workspaceMap, ok := m.workspaceSessions[workspaceID]
	if !ok {
		return []Session{}
	}

	result := make([]Session, 0, len(workspaceMap))
	for _, session := range workspaceMap {
		result = append(result, session)
	}

	// Sort oldest first so tab ordering matches creation order
	sort.Slice(result, func(i, j int) bool {
		return result[i].CreatedAt.Before(result[j].CreatedAt)
	})

	return result
}

func (m *Manager) Get(workspaceID, sessionID string) (Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	workspaceMap, ok := m.workspaceSessions[workspaceID]
	if !ok {
		return Session{}, false
	}

	session, ok := workspaceMap[sessionID]
	return session, ok
}

// UpdateAcpSessionID updates the ACP session ID and agent type for a session.
// Called after a successful NewSession or LoadSession to track the ACP session
// for reconnection with LoadSession.
func (m *Manager) UpdateAcpSessionID(workspaceID, sessionID, acpSessionID, agentType string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	workspaceMap, ok := m.workspaceSessions[workspaceID]
	if !ok {
		return fmt.Errorf("workspace not found: %s", workspaceID)
	}

	session, ok := workspaceMap[sessionID]
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	session.AcpSessionID = acpSessionID
	session.AgentType = agentType
	session.UpdatedAt = time.Now().UTC()
	workspaceMap[sessionID] = session
	return nil
}

func (m *Manager) RemoveWorkspace(workspaceID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.workspaceSessions, workspaceID)
}

func (m *Manager) idempotencyKey(workspaceID, key string) string {
	return workspaceID + ":" + key
}
