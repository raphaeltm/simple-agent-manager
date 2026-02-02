// Package auth provides session cookie management for the VM Agent.
package auth

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"sync"
	"time"
)

// Session represents an authenticated user session.
type Session struct {
	ID        string
	UserID    string
	Claims    *Claims
	CreatedAt time.Time
	ExpiresAt time.Time
}

// SessionManager manages user sessions.
type SessionManager struct {
	sessions        map[string]*Session
	sessionOrder    []string // For LRU eviction
	mu              sync.RWMutex
	cookieName      string
	secure          bool
	ttl             time.Duration
	cleanupInterval time.Duration
	maxSessions     int
	stopCleanup     chan struct{}
}

// SessionManagerConfig holds configuration for the session manager.
type SessionManagerConfig struct {
	CookieName      string
	Secure          bool
	TTL             time.Duration
	CleanupInterval time.Duration
	MaxSessions     int
}

// NewSessionManager creates a new session manager.
func NewSessionManager(cookieName string, secure bool, ttl time.Duration) *SessionManager {
	return NewSessionManagerWithConfig(SessionManagerConfig{
		CookieName:      cookieName,
		Secure:          secure,
		TTL:             ttl,
		CleanupInterval: 1 * time.Minute, // Default 1 minute
		MaxSessions:     100,             // Default 100 sessions
	})
}

// NewSessionManagerWithConfig creates a new session manager with full configuration.
func NewSessionManagerWithConfig(cfg SessionManagerConfig) *SessionManager {
	sm := &SessionManager{
		sessions:        make(map[string]*Session),
		sessionOrder:    make([]string, 0),
		cookieName:      cfg.CookieName,
		secure:          cfg.Secure,
		ttl:             cfg.TTL,
		cleanupInterval: cfg.CleanupInterval,
		maxSessions:     cfg.MaxSessions,
		stopCleanup:     make(chan struct{}),
	}

	// Start cleanup goroutine
	go sm.cleanup()

	return sm
}

// CreateSession creates a new session for the given claims.
// Implements LRU eviction when max sessions is reached.
func (sm *SessionManager) CreateSession(claims *Claims) (*Session, error) {
	sessionID, err := generateSessionID()
	if err != nil {
		return nil, err
	}

	now := time.Now()
	session := &Session{
		ID:        sessionID,
		UserID:    claims.Subject,
		Claims:    claims,
		CreatedAt: now,
		ExpiresAt: now.Add(sm.ttl),
	}

	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Evict oldest sessions if at capacity (LRU eviction)
	for len(sm.sessions) >= sm.maxSessions && len(sm.sessionOrder) > 0 {
		oldestID := sm.sessionOrder[0]
		sm.sessionOrder = sm.sessionOrder[1:]
		delete(sm.sessions, oldestID)
	}

	sm.sessions[sessionID] = session
	sm.sessionOrder = append(sm.sessionOrder, sessionID)

	return session, nil
}

// GetSession retrieves a session by ID.
func (sm *SessionManager) GetSession(sessionID string) *Session {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	session, ok := sm.sessions[sessionID]
	if !ok {
		return nil
	}

	// Check if expired
	if time.Now().After(session.ExpiresAt) {
		return nil
	}

	return session
}

// GetSessionFromRequest retrieves a session from the request cookie.
func (sm *SessionManager) GetSessionFromRequest(r *http.Request) *Session {
	cookie, err := r.Cookie(sm.cookieName)
	if err != nil {
		return nil
	}
	return sm.GetSession(cookie.Value)
}

// DeleteSession removes a session.
func (sm *SessionManager) DeleteSession(sessionID string) {
	sm.mu.Lock()
	delete(sm.sessions, sessionID)
	sm.mu.Unlock()
}

// SetCookie sets the session cookie on the response.
// Uses SameSite=Strict as required by the constitution for security.
func (sm *SessionManager) SetCookie(w http.ResponseWriter, session *Session) {
	http.SetCookie(w, &http.Cookie{
		Name:     sm.cookieName,
		Value:    session.ID,
		Path:     "/",
		Expires:  session.ExpiresAt,
		HttpOnly: true,
		Secure:   sm.secure,
		SameSite: http.SameSiteStrictMode,
	})
}

// ClearCookie clears the session cookie.
// Uses SameSite=Strict as required by the constitution for security.
func (sm *SessionManager) ClearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sm.cookieName,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		HttpOnly: true,
		Secure:   sm.secure,
		SameSite: http.SameSiteStrictMode,
	})
}

// cleanup periodically removes expired sessions.
func (sm *SessionManager) cleanup() {
	ticker := time.NewTicker(sm.cleanupInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			sm.mu.Lock()
			now := time.Now()
			// Build new order list excluding expired sessions
			newOrder := make([]string, 0, len(sm.sessionOrder))
			for _, id := range sm.sessionOrder {
				session, exists := sm.sessions[id]
				if exists && now.After(session.ExpiresAt) {
					delete(sm.sessions, id)
				} else if exists {
					newOrder = append(newOrder, id)
				}
			}
			sm.sessionOrder = newOrder
			sm.mu.Unlock()
		case <-sm.stopCleanup:
			return
		}
	}
}

// Stop stops the cleanup goroutine.
func (sm *SessionManager) Stop() {
	close(sm.stopCleanup)
}

// generateSessionID generates a random session ID.
func generateSessionID() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

// ActiveSessions returns the number of active sessions.
func (sm *SessionManager) ActiveSessions() int {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return len(sm.sessions)
}
