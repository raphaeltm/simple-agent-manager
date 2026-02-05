// Package pty provides PTY session management.
package pty

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

// ContainerResolver returns the current devcontainer ID.
// Returns ("", nil) if container mode is disabled.
type ContainerResolver func() (string, error)

// Manager manages multiple PTY sessions.
type Manager struct {
	sessions           map[string]*Session
	mu                 sync.RWMutex
	defaultShell       string
	defaultRows        int
	defaultCols        int
	workDir            string
	onActivity         func() // Called when any session has activity
	containerResolver  ContainerResolver
	containerUser      string
}

// ManagerConfig holds configuration for the session manager.
type ManagerConfig struct {
	DefaultShell      string
	DefaultRows       int
	DefaultCols       int
	WorkDir           string
	OnActivity        func()
	ContainerResolver ContainerResolver
	ContainerUser     string
}

// NewManager creates a new session manager.
func NewManager(cfg ManagerConfig) *Manager {
	return &Manager{
		sessions:          make(map[string]*Session),
		defaultShell:      cfg.DefaultShell,
		defaultRows:       cfg.DefaultRows,
		defaultCols:       cfg.DefaultCols,
		workDir:           cfg.WorkDir,
		onActivity:        cfg.OnActivity,
		containerResolver: cfg.ContainerResolver,
		containerUser:     cfg.ContainerUser,
	}
}

// CreateSession creates a new PTY session.
func (m *Manager) CreateSession(userID string, rows, cols int) (*Session, error) {
	sessionID, err := generateSessionID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate session ID: %w", err)
	}

	if rows <= 0 {
		rows = m.defaultRows
	}
	if cols <= 0 {
		cols = m.defaultCols
	}

	// Resolve container ID if container mode is active
	var containerID string
	if m.containerResolver != nil {
		containerID, err = m.containerResolver()
		if err != nil {
			return nil, fmt.Errorf("devcontainer not available: %w", err)
		}
	}

	session, err := NewSession(SessionConfig{
		ID:            sessionID,
		UserID:        userID,
		Shell:         m.defaultShell,
		Rows:          rows,
		Cols:          cols,
		WorkDir:       m.workDir,
		ContainerID:   containerID,
		ContainerUser: m.containerUser,
		OnClose: func() {
			m.removeSession(sessionID)
		},
	})
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	m.sessions[sessionID] = session
	m.mu.Unlock()

	return session, nil
}

// GetSession retrieves a session by ID.
func (m *Manager) GetSession(sessionID string) *Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[sessionID]
}

// GetSessionsByUser retrieves all sessions for a user.
func (m *Manager) GetSessionsByUser(userID string) []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var sessions []*Session
	for _, s := range m.sessions {
		if s.UserID == userID {
			sessions = append(sessions, s)
		}
	}
	return sessions
}

// CloseSession closes a specific session.
func (m *Manager) CloseSession(sessionID string) error {
	m.mu.Lock()
	session, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("session not found: %s", sessionID)
	}
	delete(m.sessions, sessionID)
	m.mu.Unlock()

	return session.Close()
}

// CloseUserSessions closes all sessions for a user.
func (m *Manager) CloseUserSessions(userID string) error {
	sessions := m.GetSessionsByUser(userID)
	for _, s := range sessions {
		if err := m.CloseSession(s.ID); err != nil {
			return err
		}
	}
	return nil
}

// CloseAllSessions closes all sessions.
func (m *Manager) CloseAllSessions() {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()

	for _, s := range sessions {
		_ = s.Close()
	}
}

// removeSession removes a session from the manager.
func (m *Manager) removeSession(sessionID string) {
	m.mu.Lock()
	delete(m.sessions, sessionID)
	m.mu.Unlock()
}

// SessionCount returns the number of active sessions.
func (m *Manager) SessionCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.sessions)
}

// GetLastActivity returns the most recent activity time across all sessions.
func (m *Manager) GetLastActivity() time.Time {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var lastActive time.Time
	for _, s := range m.sessions {
		if t := s.GetLastActive(); t.After(lastActive) {
			lastActive = t
		}
	}
	return lastActive
}

// NotifyActivity notifies the manager of activity (called by sessions).
func (m *Manager) NotifyActivity() {
	if m.onActivity != nil {
		m.onActivity()
	}
}

// CleanupIdleSessions closes sessions that have been idle for longer than the given duration.
func (m *Manager) CleanupIdleSessions(maxIdle time.Duration) int {
	m.mu.RLock()
	var toClose []string
	for id, s := range m.sessions {
		if s.IdleTime() > maxIdle {
			toClose = append(toClose, id)
		}
	}
	m.mu.RUnlock()

	for _, id := range toClose {
		_ = m.CloseSession(id)
	}

	return len(toClose)
}

// generateSessionID generates a random session ID.
func generateSessionID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}
