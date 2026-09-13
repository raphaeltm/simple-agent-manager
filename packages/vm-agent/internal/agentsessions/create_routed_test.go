package agentsessions

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

func TestCreateRoutedConcurrentRetryPreservesSession(t *testing.T) {
	m := NewManager()
	var created atomic.Int32
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() {
			_, hit, err := m.CreateRouted("ws", "session", "Original", "", "project", "chat")
			if err != nil {
				t.Error(err)
			} else if !hit {
				created.Add(1)
			}
		})
	}
	wg.Wait()
	if created.Load() != 1 || len(m.List("ws")) != 1 {
		t.Fatalf("created %d sessions", created.Load())
	}
	if err := m.UpdateAcpSessionID("ws", "session", "saved-harness", "claude-code"); err != nil {
		t.Fatal(err)
	}
	// Display edits must not destroy immutable creation provenance.
	m.mu.Lock()
	session := m.workspaceSessions["ws"]["session"]
	session.Label = "Renamed"
	m.workspaceSessions["ws"]["session"] = session
	m.mu.Unlock()
	retry, hit, err := m.CreateRouted("ws", "session", "Original", "", "project", "chat")
	if err != nil || !hit || retry.AcpSessionID != "saved-harness" || retry.Label != "Renamed" {
		t.Fatalf("retry lost original session: %+v, hit=%v, err=%v", retry, hit, err)
	}
}

func TestCreateRoutedRejectsConflictingIdentity(t *testing.T) {
	for _, change := range []string{"label", "project", "chat", "key-session", "stopped", "suspended", "legacy"} {
		t.Run(change, func(t *testing.T) {
			m := NewManager()
			var err error
			if change == "legacy" {
				_, _, err = m.Create("ws", "session", "Original", "key")
			} else {
				_, _, err = m.CreateRouted("ws", "session", "Original", "key", "project", "chat")
			}
			if err != nil {
				t.Fatal(err)
			}
			id, label, project, chat := "session", "Original", "project", "chat"
			switch change {
			case "label":
				label = "Different"
			case "project":
				project = "different"
			case "chat":
				chat = "different"
			case "key-session":
				id = "different"
			case "stopped":
				_, err = m.Stop("ws", id)
			case "suspended":
				_, err = m.Suspend("ws", id)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := m.CreateRouted("ws", id, label, "key", project, chat); err == nil {
				t.Fatal("conflicting retry was accepted")
			}
		})
	}
}

func TestCreateRoutedOnEmptyWorkspaceHasSingleWinner(t *testing.T) {
	m := NewManager()
	var admitted atomic.Int32
	var wg sync.WaitGroup
	for i := range 16 {
		wg.Go(func() {
			if _, _, err := m.CreateRoutedOnEmptyWorkspace("ws", fmt.Sprintf("session-%d", i), "project", "chat"); err == nil {
				admitted.Add(1)
			}
		})
	}
	wg.Wait()
	if admitted.Load() != 1 || len(m.List("ws")) != 1 {
		t.Fatalf("admitted %d standalone claims", admitted.Load())
	}
	m = NewManager()
	if _, _, err := m.Create("ws", "normal", "Normal", ""); err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.CreateRoutedOnEmptyWorkspace("ws", "restore", "project", "chat"); err == nil {
		t.Fatal("restore adopted a workspace with a normal session")
	}
}
