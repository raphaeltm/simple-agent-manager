package pty

import (
	"strings"
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

func TestOrphanSession_NoAutoCleanupWhenGraceDisabled(t *testing.T) {
	m := NewManager(ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		GracePeriod:  0,
		BufferSize:   1024,
	})

	session, err := m.CreateSession("user1", 24, 80)
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}
	defer m.CloseAllSessions()

	m.OrphanSession(session.ID)
	time.Sleep(150 * time.Millisecond)

	remaining := m.GetSession(session.ID)
	if remaining == nil {
		t.Fatal("expected orphaned session to remain when grace period is disabled")
	}

	remaining.mu.RLock()
	orphaned := remaining.IsOrphaned
	remaining.mu.RUnlock()
	if !orphaned {
		t.Fatal("expected session to stay orphaned until explicitly closed")
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

func TestGetActiveSessionsForUser(t *testing.T) {
	m := NewManager(ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		GracePeriod:  1 * time.Minute,
		BufferSize:   1024,
	})

	user1Session, err := m.CreateSession("user1", 24, 80)
	if err != nil {
		t.Fatalf("failed to create user1 session: %v", err)
	}
	_, err = m.CreateSession("user2", 24, 80)
	if err != nil {
		t.Fatalf("failed to create user2 session: %v", err)
	}
	defer m.CloseAllSessions()

	user1Sessions := m.GetActiveSessionsForUser("user1")
	if len(user1Sessions) != 1 {
		t.Fatalf("expected 1 session for user1, got %d", len(user1Sessions))
	}
	if user1Sessions[0].ID != user1Session.ID {
		t.Fatalf("expected session %s for user1, got %s", user1Session.ID, user1Sessions[0].ID)
	}

	user2Sessions := m.GetActiveSessionsForUser("user2")
	if len(user2Sessions) != 1 {
		t.Fatalf("expected 1 session for user2, got %d", len(user2Sessions))
	}
}

func TestCreateSessionWithID_UsesProvidedWorkDir(t *testing.T) {
	customDir := t.TempDir()
	m := NewManager(ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		WorkDir:      "/workspaces/default",
		GracePeriod:  1 * time.Minute,
		BufferSize:   1024,
	})

	session, err := m.CreateSessionWithID("sess-workdir", "user1", 24, 80, customDir)
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}
	defer m.CloseAllSessions()

	if session.Cmd == nil {
		t.Fatalf("expected session command to be initialized")
	}
	if session.Cmd.Dir != customDir {
		t.Fatalf("expected custom workdir, got %q", session.Cmd.Dir)
	}
}

func TestSetContainerUser_AffectsNewSessions(t *testing.T) {
	// This test would have caught the regression in 6f08afe where
	// server.New() was moved before bootstrap.Run() but the detected
	// container user was never propagated to the PTY manager.

	m := NewManager(ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		ContainerResolver: func() (string, error) {
			return "test-container-abc", nil
		},
		// ContainerUser is intentionally empty — simulates pre-bootstrap state
	})

	// Session created before SetContainerUser should have no -u flag
	session1, err := m.CreateSession("user1", 24, 80)
	if err != nil {
		t.Fatalf("CreateSession (before SetContainerUser) failed: %v", err)
	}
	defer m.CloseAllSessions()

	args1 := strings.Join(session1.Cmd.Args, " ")
	if strings.Contains(args1, " -u ") {
		t.Errorf("session before SetContainerUser should not have -u flag, got: %s", args1)
	}

	// Simulate bootstrap detecting the container user
	m.SetContainerUser("node")

	// Session created after SetContainerUser should include -u node
	session2, err := m.CreateSessionWithID("sess-after", "user1", 24, 80, "")
	if err != nil {
		t.Fatalf("CreateSession (after SetContainerUser) failed: %v", err)
	}

	args2 := strings.Join(session2.Cmd.Args, " ")
	if !strings.Contains(args2, "-u node") {
		t.Errorf("session after SetContainerUser should have '-u node', got: %s", args2)
	}
}

func TestSetContainerUser_DoesNotAffectExistingSessions(t *testing.T) {
	m := NewManager(ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		ContainerResolver: func() (string, error) {
			return "test-container-xyz", nil
		},
	})

	session1, err := m.CreateSession("user1", 24, 80)
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}
	defer m.CloseAllSessions()

	argsBefore := strings.Join(session1.Cmd.Args, " ")

	// Change user after session is created
	m.SetContainerUser("newuser")

	// Existing session's command should be unchanged
	argsAfter := strings.Join(session1.Cmd.Args, " ")
	if argsBefore != argsAfter {
		t.Errorf("SetContainerUser modified existing session args:\n  before: %s\n  after:  %s", argsBefore, argsAfter)
	}
}
