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
	sessions   map[string]*Session
	mu         sync.RWMutex
	cookieName string
	secure     bool
	ttl        time.Duration
}

// NewSessionManager creates a new session manager.
func NewSessionManager(cookieName string, secure bool, ttl time.Duration) *SessionManager {
	sm := &SessionManager{
		sessions:   make(map[string]*Session),
		cookieName: cookieName,
		secure:     secure,
		ttl:        ttl,
	}

	// Start cleanup goroutine
	go sm.cleanup()

	return sm
}

// CreateSession creates a new session for the given claims.
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
	sm.sessions[sessionID] = session
	sm.mu.Unlock()

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
func (sm *SessionManager) SetCookie(w http.ResponseWriter, session *Session) {
	http.SetCookie(w, &http.Cookie{
		Name:     sm.cookieName,
		Value:    session.ID,
		Path:     "/",
		Expires:  session.ExpiresAt,
		HttpOnly: true,
		Secure:   sm.secure,
		SameSite: http.SameSiteLaxMode,
	})
}

// ClearCookie clears the session cookie.
func (sm *SessionManager) ClearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sm.cookieName,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		HttpOnly: true,
		Secure:   sm.secure,
		SameSite: http.SameSiteLaxMode,
	})
}

// cleanup periodically removes expired sessions.
func (sm *SessionManager) cleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		sm.mu.Lock()
		now := time.Now()
		for id, session := range sm.sessions {
			if now.After(session.ExpiresAt) {
				delete(sm.sessions, id)
			}
		}
		sm.mu.Unlock()
	}
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
