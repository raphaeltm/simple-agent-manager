// Package pty provides PTY session management.
package pty

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
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
	containerResolver  ContainerResolver
	containerUser      string
	maxSessionsPerUser int           // Maximum sessions allowed per user (0 = unlimited)
	gracePeriod        time.Duration // How long orphaned sessions survive before cleanup (0 = disabled)
	bufferSize         int           // Output ring buffer capacity per session in bytes
}

// ManagerConfig holds configuration for the session manager.
type ManagerConfig struct {
	DefaultShell       string
	DefaultRows        int
	DefaultCols        int
	WorkDir            string
	ContainerResolver  ContainerResolver
	ContainerUser      string
	MaxSessionsPerUser int           // Maximum sessions allowed per user (0 = unlimited)
	GracePeriod        time.Duration // How long orphaned sessions survive before cleanup (0 = disabled)
	BufferSize         int           // Output ring buffer capacity per session in bytes
}

// NewManager creates a new session manager.
func NewManager(cfg ManagerConfig) *Manager {
	gracePeriod := cfg.GracePeriod
	if gracePeriod < 0 {
		gracePeriod = 0
	}
	bufferSize := cfg.BufferSize
	if bufferSize <= 0 {
		bufferSize = 262144 // 256 KB
	}
	return &Manager{
		sessions:           make(map[string]*Session),
		defaultShell:       cfg.DefaultShell,
		defaultRows:        cfg.DefaultRows,
		defaultCols:        cfg.DefaultCols,
		workDir:            cfg.WorkDir,
		containerResolver:  cfg.ContainerResolver,
		containerUser:      cfg.ContainerUser,
		maxSessionsPerUser: cfg.MaxSessionsPerUser,
		gracePeriod:        gracePeriod,
		bufferSize:         bufferSize,
	}
}

// CreateSession creates a new PTY session.
func (m *Manager) CreateSession(userID string, rows, cols int) (*Session, error) {
	sessionID, err := generateSessionID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate session ID: %w", err)
	}

	return m.CreateSessionWithID(sessionID, userID, rows, cols)
}

// CreateSessionWithID creates a new PTY session with a specific ID.
// This is used for multi-terminal support where the client generates the session ID.
func (m *Manager) CreateSessionWithID(sessionID, userID string, rows, cols int) (*Session, error) {
	// Check if session already exists
	m.mu.RLock()
	if _, exists := m.sessions[sessionID]; exists {
		m.mu.RUnlock()
		return nil, fmt.Errorf("session already exists: %s", sessionID)
	}
	m.mu.RUnlock()

	// Check session limit for user
	if m.maxSessionsPerUser > 0 {
		currentCount := m.SessionCountForUser(userID)
		if currentCount >= m.maxSessionsPerUser {
			return nil, fmt.Errorf("maximum sessions reached for user %s: %d", userID, m.maxSessionsPerUser)
		}
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
		var err error
		containerID, err = m.containerResolver()
		if err != nil {
			return nil, fmt.Errorf("devcontainer not available: %w", err)
		}
	}

	session, err := NewSession(SessionConfig{
		ID:               sessionID,
		UserID:           userID,
		Shell:            m.defaultShell,
		Rows:             rows,
		Cols:             cols,
		WorkDir:          m.workDir,
		ContainerID:      containerID,
		ContainerUser:    m.containerUser,
		OutputBufferSize: m.bufferSize,
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

// SessionCountForUser returns the number of active sessions for a specific user.
func (m *Manager) SessionCountForUser(userID string) int {
	m.mu.RLock()
	defer m.mu.RUnlock()

	count := 0
	for _, s := range m.sessions {
		if s.UserID == userID {
			count++
		}
	}
	return count
}

// GetAllSessions returns all active sessions.
// Used for multi-terminal session listing.
func (m *Manager) GetAllSessions() map[string]*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()

	// Create a copy to avoid race conditions
	sessionsCopy := make(map[string]*Session)
	for k, v := range m.sessions {
		sessionsCopy[k] = v
	}
	return sessionsCopy
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

// OrphanSession marks a session as orphaned and starts a cleanup timer.
// Called when a WebSocket disconnects to keep the session alive temporarily.
func (m *Manager) OrphanSession(sessionID string) {
	m.mu.Lock()
	session, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return
	}

	session.mu.Lock()
	session.IsOrphaned = true
	session.OrphanedAt = time.Now()
	session.attachedWriter = nil

	// Stop any prior orphan timer before creating a new one.
	if session.orphanTimer != nil {
		session.orphanTimer.Stop()
		session.orphanTimer = nil
	}
	session.mu.Unlock()

	if m.gracePeriod > 0 {
		// Start orphan timer — cleanup after grace period.
		session.orphanTimer = time.AfterFunc(m.gracePeriod, func() {
			m.cleanupOrphanedSession(sessionID)
		})
		log.Printf("Session %s orphaned, will cleanup in %v", sessionID, m.gracePeriod)
	} else {
		log.Printf("Session %s orphaned, automatic cleanup disabled", sessionID)
	}
	m.mu.Unlock()
}

// OrphanSessions marks multiple sessions as orphaned in batch.
func (m *Manager) OrphanSessions(sessionIDs []string) {
	for _, id := range sessionIDs {
		m.OrphanSession(id)
	}
}

// ReattachSession reattaches to an orphaned session, cancelling the cleanup timer.
// Returns the session if successful, error if session not found or already exited.
func (m *Manager) ReattachSession(sessionID string) (*Session, error) {
	m.mu.Lock()
	session, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return nil, fmt.Errorf("session not found: %s", sessionID)
	}

	session.mu.Lock()

	// Stop the orphan timer if it exists
	if session.orphanTimer != nil {
		session.orphanTimer.Stop()
		session.orphanTimer = nil
	}

	// Clear orphan state
	session.IsOrphaned = false
	session.OrphanedAt = time.Time{}
	session.mu.Unlock()
	m.mu.Unlock()

	log.Printf("Session %s reattached", sessionID)
	return session, nil
}

// GetActiveSessions returns info about all non-closed sessions.
func (m *Manager) GetActiveSessions() []SessionInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()

	infos := make([]SessionInfo, 0, len(m.sessions))
	for _, s := range m.sessions {
		infos = append(infos, s.Info())
	}
	return infos
}

// GetActiveSessionsForUser returns info about all non-closed sessions for a user.
func (m *Manager) GetActiveSessionsForUser(userID string) []SessionInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()

	infos := make([]SessionInfo, 0, len(m.sessions))
	for _, s := range m.sessions {
		if s.UserID == userID {
			infos = append(infos, s.Info())
		}
	}
	return infos
}

// SetSessionName updates the display name for a session.
func (m *Manager) SetSessionName(sessionID, name string) error {
	m.mu.RLock()
	session, ok := m.sessions[sessionID]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	session.mu.Lock()
	session.Name = name
	session.mu.Unlock()
	return nil
}

// cleanupOrphanedSession is called by the orphan timer to remove a session.
func (m *Manager) cleanupOrphanedSession(sessionID string) {
	m.mu.Lock()
	session, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return
	}

	// Only cleanup if still orphaned (could have been reattached in the meantime)
	session.mu.RLock()
	stillOrphaned := session.IsOrphaned
	session.mu.RUnlock()

	if !stillOrphaned {
		m.mu.Unlock()
		return
	}

	delete(m.sessions, sessionID)
	m.mu.Unlock()

	log.Printf("Cleaning up orphaned session %s", sessionID)
	_ = session.Close()
}

// GetOrphanedSessionCount returns the number of currently orphaned sessions.
func (m *Manager) GetOrphanedSessionCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()

	count := 0
	for _, s := range m.sessions {
		s.mu.RLock()
		if s.IsOrphaned {
			count++
		}
		s.mu.RUnlock()
	}
	return count
}

// generateSessionID generates a random session ID.
func generateSessionID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}
