package agentsessions

import (
	"testing"
	"time"
)

func TestCreate(t *testing.T) {
	m := NewManager()
	s, idem, err := m.Create("ws1", "s1", "Chat 1", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if idem {
		t.Fatal("expected non-idempotent hit")
	}
	if s.ID != "s1" || s.Label != "Chat 1" || s.Status != StatusRunning {
		t.Fatalf("unexpected session: %+v", s)
	}
}

func TestCreateIdempotency(t *testing.T) {
	m := NewManager()
	s1, _, err := m.Create("ws1", "s1", "Chat 1", "key1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	s2, idem, err := m.Create("ws1", "s2", "Chat 2", "key1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !idem {
		t.Fatal("expected idempotent hit")
	}
	if s2.ID != s1.ID {
		t.Fatalf("expected same session ID, got %s vs %s", s1.ID, s2.ID)
	}
}

func TestCreateDuplicate(t *testing.T) {
	m := NewManager()
	_, _, err := m.Create("ws1", "s1", "Chat 1", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	_, _, err = m.Create("ws1", "s1", "Chat 2", "")
	if err == nil {
		t.Fatal("expected error for duplicate session")
	}
}

func TestListSortedOldestFirst(t *testing.T) {
	m := NewManager()

	// Create sessions with explicit time gaps
	s1, _, _ := m.Create("ws1", "s1", "Chat 1", "")
	_ = s1

	// Manually set creation times to ensure deterministic ordering
	m.mu.Lock()
	ws := m.workspaceSessions["ws1"]

	now := time.Now().UTC()
	sess1 := ws["s1"]
	sess1.CreatedAt = now.Add(-2 * time.Second)
	ws["s1"] = sess1
	m.mu.Unlock()

	m.Create("ws1", "s2", "Chat 2", "")
	m.mu.Lock()
	sess2 := m.workspaceSessions["ws1"]["s2"]
	sess2.CreatedAt = now.Add(-1 * time.Second)
	m.workspaceSessions["ws1"]["s2"] = sess2
	m.mu.Unlock()

	m.Create("ws1", "s3", "Chat 3", "")
	m.mu.Lock()
	sess3 := m.workspaceSessions["ws1"]["s3"]
	sess3.CreatedAt = now
	m.workspaceSessions["ws1"]["s3"] = sess3
	m.mu.Unlock()

	sessions := m.List("ws1")
	if len(sessions) != 3 {
		t.Fatalf("expected 3 sessions, got %d", len(sessions))
	}

	// Oldest first
	if sessions[0].ID != "s1" {
		t.Errorf("expected first session to be s1 (oldest), got %s", sessions[0].ID)
	}
	if sessions[1].ID != "s2" {
		t.Errorf("expected second session to be s2, got %s", sessions[1].ID)
	}
	if sessions[2].ID != "s3" {
		t.Errorf("expected third session to be s3 (newest), got %s", sessions[2].ID)
	}
}

func TestListEmptyWorkspace(t *testing.T) {
	m := NewManager()
	sessions := m.List("nonexistent")
	if len(sessions) != 0 {
		t.Fatalf("expected empty list, got %d sessions", len(sessions))
	}
}

func TestStop(t *testing.T) {
	m := NewManager()
	m.Create("ws1", "s1", "Chat 1", "")

	stopped, err := m.Stop("ws1", "s1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stopped.Status != StatusStopped {
		t.Fatalf("expected stopped status, got %s", stopped.Status)
	}
	if stopped.StoppedAt == nil {
		t.Fatal("expected StoppedAt to be set")
	}
}

func TestStopIdempotent(t *testing.T) {
	m := NewManager()
	m.Create("ws1", "s1", "Chat 1", "")
	m.Stop("ws1", "s1")

	// Stopping again should return same result without error
	stopped, err := m.Stop("ws1", "s1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stopped.Status != StatusStopped {
		t.Fatalf("expected stopped status, got %s", stopped.Status)
	}
}

func TestUpdateAcpSessionID(t *testing.T) {
	m := NewManager()
	m.Create("ws1", "s1", "Chat 1", "")

	err := m.UpdateAcpSessionID("ws1", "s1", "acp-session-abc123", "claude-code")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	session, ok := m.Get("ws1", "s1")
	if !ok {
		t.Fatal("session not found after update")
	}
	if session.AcpSessionID != "acp-session-abc123" {
		t.Errorf("expected AcpSessionID 'acp-session-abc123', got %q", session.AcpSessionID)
	}
	if session.AgentType != "claude-code" {
		t.Errorf("expected AgentType 'claude-code', got %q", session.AgentType)
	}
}

func TestUpdateAcpSessionIDNotFound(t *testing.T) {
	m := NewManager()

	// Non-existent workspace
	err := m.UpdateAcpSessionID("ws-nonexistent", "s1", "acp-123", "claude-code")
	if err == nil {
		t.Fatal("expected error for non-existent workspace")
	}

	// Non-existent session
	m.Create("ws1", "s1", "Chat 1", "")
	err = m.UpdateAcpSessionID("ws1", "s-nonexistent", "acp-123", "claude-code")
	if err == nil {
		t.Fatal("expected error for non-existent session")
	}
}

func TestRemoveWorkspace(t *testing.T) {
	m := NewManager()
	m.Create("ws1", "s1", "Chat 1", "")
	m.RemoveWorkspace("ws1")

	sessions := m.List("ws1")
	if len(sessions) != 0 {
		t.Fatalf("expected empty list after remove, got %d", len(sessions))
	}
}

func TestSuspend(t *testing.T) {
	m := NewManager()
	m.Create("ws1", "s1", "Chat 1", "")

	suspended, err := m.Suspend("ws1", "s1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if suspended.Status != StatusSuspended {
		t.Fatalf("expected suspended status, got %s", suspended.Status)
	}
	if suspended.SuspendedAt == nil {
		t.Fatal("expected SuspendedAt to be set")
	}
}

func TestSuspendFromError(t *testing.T) {
	m := NewManager()
	m.Create("ws1", "s1", "Chat 1", "")

	// Manually set status to error to test suspend from error state
	m.mu.Lock()
	sess := m.workspaceSessions["ws1"]["s1"]
	sess.Status = StatusError
	m.workspaceSessions["ws1"]["s1"] = sess
	m.mu.Unlock()

	suspended, err := m.Suspend("ws1", "s1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if suspended.Status != StatusSuspended {
		t.Fatalf("expected suspended status, got %s", suspended.Status)
	}
}

func TestSuspendInvalidTransition(t *testing.T) {
	m := NewManager()
	m.Create("ws1", "s1", "Chat 1", "")
	m.Stop("ws1", "s1")

	_, err := m.Suspend("ws1", "s1")
	if err == nil {
		t.Fatal("expected error suspending a stopped session")
	}
}

func TestSuspendPreservesAcpSessionID(t *testing.T) {
	m := NewManager()
	m.Create("ws1", "s1", "Chat 1", "")
	_ = m.UpdateAcpSessionID("ws1", "s1", "acp-123", "claude-code")

	suspended, err := m.Suspend("ws1", "s1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if suspended.AcpSessionID != "acp-123" {
		t.Errorf("expected AcpSessionID preserved, got %q", suspended.AcpSessionID)
	}
	if suspended.AgentType != "claude-code" {
		t.Errorf("expected AgentType preserved, got %q", suspended.AgentType)
	}
}

func TestResume(t *testing.T) {
	m := NewManager()
	m.Create("ws1", "s1", "Chat 1", "")
	m.Suspend("ws1", "s1")

	resumed, err := m.Resume("ws1", "s1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resumed.Status != StatusRunning {
		t.Fatalf("expected running status, got %s", resumed.Status)
	}
	if resumed.SuspendedAt != nil {
		t.Fatal("expected SuspendedAt to be cleared")
	}
}

func TestResumeInvalidTransition(t *testing.T) {
	m := NewManager()
	m.Create("ws1", "s1", "Chat 1", "")

	// Can't resume a running session
	_, err := m.Resume("ws1", "s1")
	if err == nil {
		t.Fatal("expected error resuming a running session")
	}

	// Can't resume a stopped session
	m.Stop("ws1", "s1")
	_, err = m.Resume("ws1", "s1")
	if err == nil {
		t.Fatal("expected error resuming a stopped session")
	}
}

func TestResumePreservesAcpSessionID(t *testing.T) {
	m := NewManager()
	m.Create("ws1", "s1", "Chat 1", "")
	_ = m.UpdateAcpSessionID("ws1", "s1", "acp-456", "claude-code")
	m.Suspend("ws1", "s1")

	resumed, err := m.Resume("ws1", "s1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resumed.AcpSessionID != "acp-456" {
		t.Errorf("expected AcpSessionID preserved after resume, got %q", resumed.AcpSessionID)
	}
}

func TestUpdateLastPrompt(t *testing.T) {
	m := NewManager()
	m.Create("ws1", "s1", "Chat 1", "")

	err := m.UpdateLastPrompt("ws1", "s1", "Help me fix this bug")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	session, ok := m.Get("ws1", "s1")
	if !ok {
		t.Fatal("session not found")
	}
	if session.LastPrompt != "Help me fix this bug" {
		t.Errorf("expected LastPrompt 'Help me fix this bug', got %q", session.LastPrompt)
	}
}

func TestUpdateLastPromptNotFound(t *testing.T) {
	m := NewManager()

	err := m.UpdateLastPrompt("ws1", "s1", "test")
	if err == nil {
		t.Fatal("expected error for non-existent workspace")
	}

	m.Create("ws1", "s1", "Chat 1", "")
	err = m.UpdateLastPrompt("ws1", "s-nonexistent", "test")
	if err == nil {
		t.Fatal("expected error for non-existent session")
	}
}

func TestSuspendResumeRoundTrip(t *testing.T) {
	m := NewManager()
	m.Create("ws1", "s1", "Chat 1", "")
	_ = m.UpdateAcpSessionID("ws1", "s1", "acp-rt", "claude-code")
	_ = m.UpdateLastPrompt("ws1", "s1", "my last prompt")

	// Suspend
	m.Suspend("ws1", "s1")
	s, _ := m.Get("ws1", "s1")
	if s.Status != StatusSuspended {
		t.Fatalf("expected suspended, got %s", s.Status)
	}

	// Resume
	m.Resume("ws1", "s1")
	s, _ = m.Get("ws1", "s1")
	if s.Status != StatusRunning {
		t.Fatalf("expected running, got %s", s.Status)
	}
	if s.AcpSessionID != "acp-rt" {
		t.Errorf("AcpSessionID lost during round-trip, got %q", s.AcpSessionID)
	}
	if s.LastPrompt != "my last prompt" {
		t.Errorf("LastPrompt lost during round-trip, got %q", s.LastPrompt)
	}
}
