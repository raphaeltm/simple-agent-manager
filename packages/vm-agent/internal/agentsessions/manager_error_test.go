package agentsessions

import "testing"

func TestMarkErrorPersistsFailureDetails(t *testing.T) {
	m := NewManager()
	if _, _, err := m.Create("ws1", "s1", "Chat", ""); err != nil {
		t.Fatal(err)
	}
	if err := m.MarkError("ws1", "s1", "openai-codex", "install failed"); err != nil {
		t.Fatal(err)
	}
	session, ok := m.Get("ws1", "s1")
	if !ok {
		t.Fatal("session missing")
	}
	if session.Status != StatusError || session.AgentType != "openai-codex" || session.Error != "install failed" {
		t.Fatalf("unexpected failed session: %#v", session)
	}
}
