package pty

import (
	"testing"
	"time"
)

func TestOrphanSession_SetsStateCorrectly(t *testing.T) {
	m := NewManager(ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		GracePeriod:  1 * time.Minute,
		BufferSize:   1024,
	})

	session, err := m.CreateSession("user1", 24, 80)
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}
	defer m.CloseAllSessions()

	m.OrphanSession(session.ID)

	session.mu.RLock()
	isOrphaned := session.IsOrphaned
	orphanedAt := session.OrphanedAt
	writer := session.attachedWriter
	session.mu.RUnlock()

	if !isOrphaned {
		t.Fatal("expected session to be orphaned")
	}
	if orphanedAt.IsZero() {
		t.Fatal("expected orphanedAt to be set")
	}
	if writer != nil {
		t.Fatal("expected attachedWriter to be nil after orphan")
	}
}

func TestReattachSession_CancelsTimerAndClearsState(t *testing.T) {
	m := NewManager(ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		GracePeriod:  5 * time.Second,
		BufferSize:   1024,
	})

	session, err := m.CreateSession("user1", 24, 80)
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}
	defer m.CloseAllSessions()

	m.OrphanSession(session.ID)

	// Reattach should succeed
	reattached, err := m.ReattachSession(session.ID)
	if err != nil {
		t.Fatalf("failed to reattach session: %v", err)
	}
	if reattached.ID != session.ID {
		t.Fatalf("expected session ID %s, got %s", session.ID, reattached.ID)
	}

	reattached.mu.RLock()
	isOrphaned := reattached.IsOrphaned
	orphanedAt := reattached.OrphanedAt
	reattached.mu.RUnlock()

	if isOrphaned {
		t.Fatal("expected session to NOT be orphaned after reattach")
	}
	if !orphanedAt.IsZero() {
		t.Fatal("expected orphanedAt to be cleared after reattach")
	}
}

func TestReattachSession_ReturnsErrorForNonexistent(t *testing.T) {
	m := NewManager(ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		GracePeriod:  1 * time.Minute,
		BufferSize:   1024,
	})

	_, err := m.ReattachSession("nonexistent-id")
	if err == nil {
		t.Fatal("expected error for nonexistent session")
	}
}

func TestGetActiveSessions_ReturnsCorrectStatuses(t *testing.T) {
	m := NewManager(ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		GracePeriod:  1 * time.Minute,
		BufferSize:   1024,
	})

	session1, err := m.CreateSession("user1", 24, 80)
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}
	defer m.CloseAllSessions()

	session2, err := m.CreateSession("user1", 24, 80)
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}

	// Mark session2 as process exited
	session2.mu.Lock()
	session2.ProcessExited = true
	session2.ExitCode = 0
	session2.mu.Unlock()

	infos := m.GetActiveSessions()
	if len(infos) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(infos))
	}

	statusMap := make(map[string]string)
	for _, info := range infos {
		statusMap[info.ID] = info.Status
	}

	if statusMap[session1.ID] != "running" {
		t.Fatalf("expected session1 status 'running', got '%s'", statusMap[session1.ID])
	}
	if statusMap[session2.ID] != "exited" {
		t.Fatalf("expected session2 status 'exited', got '%s'", statusMap[session2.ID])
	}
}

func TestOrphanTimer_CleansUpAfterGracePeriod(t *testing.T) {
	gracePeriod := 100 * time.Millisecond
	m := NewManager(ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		GracePeriod:  gracePeriod,
		BufferSize:   1024,
	})

	session, err := m.CreateSession("user1", 24, 80)
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}
	sessionID := session.ID

	m.OrphanSession(sessionID)

	// Wait for grace period + some buffer
	time.Sleep(gracePeriod + 100*time.Millisecond)

	// Session should be cleaned up
	if m.GetSession(sessionID) != nil {
		t.Fatal("expected session to be cleaned up after grace period")
	}
	if m.SessionCount() != 0 {
		t.Fatalf("expected 0 sessions, got %d", m.SessionCount())
	}
}

func TestSetSessionName(t *testing.T) {
	m := NewManager(ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		GracePeriod:  1 * time.Minute,
		BufferSize:   1024,
	})

	session, err := m.CreateSession("user1", 24, 80)
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}
	defer m.CloseAllSessions()

	if err := m.SetSessionName(session.ID, "my-terminal"); err != nil {
		t.Fatalf("failed to set session name: %v", err)
	}

	session.mu.RLock()
	name := session.Name
	session.mu.RUnlock()

	if name != "my-terminal" {
		t.Fatalf("expected name 'my-terminal', got '%s'", name)
	}

	// Test nonexistent session
	if err := m.SetSessionName("nonexistent", "name"); err == nil {
		t.Fatal("expected error for nonexistent session")
	}
}

func TestOrphanSessions_BatchOrphan(t *testing.T) {
	m := NewManager(ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		GracePeriod:  1 * time.Minute,
		BufferSize:   1024,
	})

	s1, err := m.CreateSession("user1", 24, 80)
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}
	s2, err := m.CreateSession("user1", 24, 80)
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}
	defer m.CloseAllSessions()

	m.OrphanSessions([]string{s1.ID, s2.ID})

	s1.mu.RLock()
	s1Orphaned := s1.IsOrphaned
	s1.mu.RUnlock()

	s2.mu.RLock()
	s2Orphaned := s2.IsOrphaned
	s2.mu.RUnlock()

	if !s1Orphaned || !s2Orphaned {
		t.Fatal("expected both sessions to be orphaned")
	}
}

func TestReattachSession_RaceWithTimer(t *testing.T) {
	gracePeriod := 200 * time.Millisecond
	m := NewManager(ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		GracePeriod:  gracePeriod,
		BufferSize:   1024,
	})

	session, err := m.CreateSession("user1", 24, 80)
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}
	sessionID := session.ID
	defer m.CloseAllSessions()

	m.OrphanSession(sessionID)

	// Reattach before grace period expires
	time.Sleep(50 * time.Millisecond)
	reattached, err := m.ReattachSession(sessionID)
	if err != nil {
		t.Fatalf("failed to reattach: %v", err)
	}

	// Wait past original grace period
	time.Sleep(gracePeriod + 50*time.Millisecond)

	// Session should still exist (timer was cancelled)
	if m.GetSession(reattached.ID) == nil {
		t.Fatal("expected session to survive after reattach cancelled timer")
	}
}

func TestGetOrphanedSessionCount(t *testing.T) {
	m := NewManager(ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		GracePeriod:  1 * time.Minute,
		BufferSize:   1024,
	})

	s1, err := m.CreateSession("user1", 24, 80)
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}
	s2, err := m.CreateSession("user1", 24, 80)
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}
	defer m.CloseAllSessions()

	if m.GetOrphanedSessionCount() != 0 {
		t.Fatalf("expected 0 orphaned, got %d", m.GetOrphanedSessionCount())
	}

	m.OrphanSession(s1.ID)
	if m.GetOrphanedSessionCount() != 1 {
		t.Fatalf("expected 1 orphaned, got %d", m.GetOrphanedSessionCount())
	}

	m.OrphanSession(s2.ID)
	if m.GetOrphanedSessionCount() != 2 {
		t.Fatalf("expected 2 orphaned, got %d", m.GetOrphanedSessionCount())
	}

	// Reattach one
	_, err = m.ReattachSession(s1.ID)
	if err != nil {
		t.Fatalf("reattach error: %v", err)
	}
	if m.GetOrphanedSessionCount() != 1 {
		t.Fatalf("expected 1 orphaned after reattach, got %d", m.GetOrphanedSessionCount())
	}
}
