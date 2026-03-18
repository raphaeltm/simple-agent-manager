package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newTestSessionManager() *SessionManager {
	return NewSessionManagerWithConfig(SessionManagerConfig{
		CookieName:      "vm_session",
		Secure:          false,
		TTL:             1 * time.Hour,
		CleanupInterval: 1 * time.Hour, // long interval so cleanup doesn't interfere
		MaxSessions:     100,
		CookieDomain:    ".example.com",
	})
}

func TestWorkspaceCookieName(t *testing.T) {
	sm := newTestSessionManager()
	defer sm.Stop()

	name := sm.workspaceCookieName("ws-abc123")
	if name != "vm_session_ws-abc123" {
		t.Errorf("expected vm_session_ws-abc123, got %s", name)
	}
}

func TestGetSessionForWorkspace_ScopedCookie(t *testing.T) {
	sm := newTestSessionManager()
	defer sm.Stop()

	claims := &Claims{Workspace: "ws-AAA"}
	sessionA, err := sm.CreateSession(claims)
	if err != nil {
		t.Fatal(err)
	}

	claimsB := &Claims{Workspace: "ws-BBB"}
	sessionB, err := sm.CreateSession(claimsB)
	if err != nil {
		t.Fatal(err)
	}

	// Simulate a request with workspace-scoped cookie for ws-AAA
	req := httptest.NewRequest("GET", "/test", nil)
	req.AddCookie(&http.Cookie{Name: sm.workspaceCookieName("ws-AAA"), Value: sessionA.ID})
	// Also add legacy cookie pointing to ws-BBB (simulating the collision)
	req.AddCookie(&http.Cookie{Name: "vm_session", Value: sessionB.ID})

	// When looking for ws-AAA, should find the scoped cookie
	got := sm.GetSessionForWorkspace(req, "ws-AAA")
	if got == nil {
		t.Fatal("expected session for ws-AAA")
	}
	if got.ID != sessionA.ID {
		t.Errorf("expected session %s, got %s", sessionA.ID, got.ID)
	}

	// When looking for ws-BBB, should fall back to legacy cookie
	got = sm.GetSessionForWorkspace(req, "ws-BBB")
	if got == nil {
		t.Fatal("expected session for ws-BBB from legacy cookie")
	}
	if got.ID != sessionB.ID {
		t.Errorf("expected session %s, got %s", sessionB.ID, got.ID)
	}
}

func TestGetSessionForWorkspace_BothScopedCookies(t *testing.T) {
	sm := newTestSessionManager()
	defer sm.Stop()

	claimsA := &Claims{Workspace: "ws-AAA"}
	sessionA, _ := sm.CreateSession(claimsA)

	claimsB := &Claims{Workspace: "ws-BBB"}
	sessionB, _ := sm.CreateSession(claimsB)

	// Request has scoped cookies for both workspaces
	req := httptest.NewRequest("GET", "/test", nil)
	req.AddCookie(&http.Cookie{Name: sm.workspaceCookieName("ws-AAA"), Value: sessionA.ID})
	req.AddCookie(&http.Cookie{Name: sm.workspaceCookieName("ws-BBB"), Value: sessionB.ID})

	// Each workspace should find its own scoped cookie
	gotA := sm.GetSessionForWorkspace(req, "ws-AAA")
	if gotA == nil || gotA.ID != sessionA.ID {
		t.Error("expected to find scoped session for ws-AAA")
	}

	gotB := sm.GetSessionForWorkspace(req, "ws-BBB")
	if gotB == nil || gotB.ID != sessionB.ID {
		t.Error("expected to find scoped session for ws-BBB")
	}
}

func TestSetCookieForWorkspace_SetsBothCookies(t *testing.T) {
	sm := newTestSessionManager()
	defer sm.Stop()

	claims := &Claims{Workspace: "ws-AAA"}
	session, _ := sm.CreateSession(claims)

	recorder := httptest.NewRecorder()
	sm.SetCookieForWorkspace(recorder, session, "ws-AAA")

	cookies := recorder.Result().Cookies()
	names := make(map[string]bool)
	for _, c := range cookies {
		names[c.Name] = true
	}

	if !names["vm_session_ws-AAA"] {
		t.Error("expected workspace-scoped cookie vm_session_ws-AAA")
	}
	if !names["vm_session"] {
		t.Error("expected legacy cookie vm_session")
	}
}

func TestClearCookieForWorkspace(t *testing.T) {
	sm := newTestSessionManager()
	defer sm.Stop()

	recorder := httptest.NewRecorder()
	sm.ClearCookieForWorkspace(recorder, "ws-AAA")

	cookies := recorder.Result().Cookies()
	names := make(map[string]bool)
	for _, c := range cookies {
		names[c.Name] = true
		if c.Value != "" {
			t.Errorf("expected empty value for cleared cookie %s", c.Name)
		}
	}

	if !names["vm_session_ws-AAA"] {
		t.Error("expected workspace-scoped cookie to be cleared")
	}
	if !names["vm_session"] {
		t.Error("expected legacy cookie to be cleared")
	}
}

func TestGetSessionForWorkspace_NoWorkspaceID(t *testing.T) {
	sm := newTestSessionManager()
	defer sm.Stop()

	claims := &Claims{Workspace: "ws-AAA"}
	session, _ := sm.CreateSession(claims)

	req := httptest.NewRequest("GET", "/test", nil)
	req.AddCookie(&http.Cookie{Name: "vm_session", Value: session.ID})

	// With empty workspaceID, should fall back to legacy cookie
	got := sm.GetSessionForWorkspace(req, "")
	if got == nil || got.ID != session.ID {
		t.Error("expected to find session via legacy cookie when workspaceID is empty")
	}
}

func TestGetSessionForWorkspace_ExpiredScopedCookie(t *testing.T) {
	sm := newTestSessionManager()
	defer sm.Stop()

	claims := &Claims{Workspace: "ws-AAA"}
	session, _ := sm.CreateSession(claims)
	// Expire the session
	session.ExpiresAt = time.Now().Add(-1 * time.Hour)

	claimsLegacy := &Claims{Workspace: "ws-AAA"}
	legacySession, _ := sm.CreateSession(claimsLegacy)

	req := httptest.NewRequest("GET", "/test", nil)
	req.AddCookie(&http.Cookie{Name: sm.workspaceCookieName("ws-AAA"), Value: session.ID})
	req.AddCookie(&http.Cookie{Name: "vm_session", Value: legacySession.ID})

	// Scoped cookie session is expired, should fall back to legacy
	got := sm.GetSessionForWorkspace(req, "ws-AAA")
	if got == nil || got.ID != legacySession.ID {
		t.Error("expected to fall back to legacy cookie when scoped session is expired")
	}
}
