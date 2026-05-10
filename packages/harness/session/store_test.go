package session

import (
	"path/filepath"
	"sync"
	"testing"

	"github.com/workspace/harness/llm"
)

func tempStore(t *testing.T) *Store {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	s, err := NewStore(dbPath)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestCreateLoadSessionRoundTrip(t *testing.T) {
	s := tempStore(t)

	cfg := SessionConfig{
		SystemPrompt: "You are a coding assistant.",
		Model:        "gpt-4o",
		Provider:     "openai",
		WorkDir:      "/tmp/work",
		MaxTurns:     10,
		UserPrompt:   "Fix the bug in main.go",
	}

	created, err := s.CreateSession("sess-001", cfg)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if created.ID != "sess-001" {
		t.Errorf("ID = %q, want %q", created.ID, "sess-001")
	}
	if created.Status != StatusActive {
		t.Errorf("Status = %q, want %q", created.Status, StatusActive)
	}

	loaded, err := s.LoadSession("sess-001")
	if err != nil {
		t.Fatalf("LoadSession: %v", err)
	}

	if loaded.ID != created.ID {
		t.Errorf("loaded ID = %q, want %q", loaded.ID, created.ID)
	}
	if loaded.Config.SystemPrompt != cfg.SystemPrompt {
		t.Errorf("loaded SystemPrompt = %q, want %q", loaded.Config.SystemPrompt, cfg.SystemPrompt)
	}
	if loaded.Config.Model != cfg.Model {
		t.Errorf("loaded Model = %q, want %q", loaded.Config.Model, cfg.Model)
	}
	if loaded.Config.UserPrompt != cfg.UserPrompt {
		t.Errorf("loaded UserPrompt = %q, want %q", loaded.Config.UserPrompt, cfg.UserPrompt)
	}
	if loaded.Config.MaxTurns != cfg.MaxTurns {
		t.Errorf("loaded MaxTurns = %d, want %d", loaded.Config.MaxTurns, cfg.MaxTurns)
	}
}

func TestLoadSessionNotFound(t *testing.T) {
	s := tempStore(t)

	_, err := s.LoadSession("nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent session")
	}
}

func TestAppendLoadMessagesWithToolCalls(t *testing.T) {
	s := tempStore(t)

	if _, err := s.CreateSession("sess-tc", SessionConfig{}); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	messages := []llm.Message{
		{Role: llm.RoleUser, Content: "Fix the bug"},
		{
			Role:    llm.RoleAssistant,
			Content: "I'll read the file first.",
			ToolCalls: []llm.ToolCall{
				{ID: "call-1", Name: "read_file", Params: map[string]any{"path": "main.go"}},
			},
		},
		{
			Role:       llm.RoleTool,
			ToolResult: &llm.ToolResult{CallID: "call-1", Content: "package main\n\nfunc main() {}", IsError: false},
		},
	}

	if err := s.AppendMessages("sess-tc", 1, messages); err != nil {
		t.Fatalf("AppendMessages: %v", err)
	}

	loaded, err := s.LoadMessages("sess-tc")
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}

	if len(loaded) != 3 {
		t.Fatalf("loaded %d messages, want 3", len(loaded))
	}

	// Check user message.
	if loaded[0].Role != llm.RoleUser || loaded[0].Content != "Fix the bug" {
		t.Errorf("msg[0] = %+v, want user/Fix the bug", loaded[0])
	}

	// Check assistant message with tool calls.
	if loaded[1].Role != llm.RoleAssistant {
		t.Errorf("msg[1].Role = %q, want assistant", loaded[1].Role)
	}
	if len(loaded[1].ToolCalls) != 1 {
		t.Fatalf("msg[1] has %d tool calls, want 1", len(loaded[1].ToolCalls))
	}
	tc := loaded[1].ToolCalls[0]
	if tc.ID != "call-1" || tc.Name != "read_file" {
		t.Errorf("tool call = %+v, want call-1/read_file", tc)
	}
	if tc.Params["path"] != "main.go" {
		t.Errorf("tool call path = %v, want main.go", tc.Params["path"])
	}

	// Check tool result message.
	if loaded[2].Role != llm.RoleTool || loaded[2].ToolResult == nil {
		t.Fatalf("msg[2] = %+v, want tool with result", loaded[2])
	}
	if loaded[2].ToolResult.CallID != "call-1" {
		t.Errorf("tool result CallID = %q, want call-1", loaded[2].ToolResult.CallID)
	}
	if loaded[2].ToolResult.Content != "package main\n\nfunc main() {}" {
		t.Errorf("tool result Content = %q", loaded[2].ToolResult.Content)
	}
}

func TestListSessionsOrdering(t *testing.T) {
	s := tempStore(t)

	// Create sessions in order.
	if _, err := s.CreateSession("sess-a", SessionConfig{UserPrompt: "first"}); err != nil {
		t.Fatalf("CreateSession a: %v", err)
	}
	if _, err := s.CreateSession("sess-b", SessionConfig{UserPrompt: "second"}); err != nil {
		t.Fatalf("CreateSession b: %v", err)
	}

	// Append a message to sess-a so its updated_at becomes more recent.
	if err := s.AppendMessages("sess-a", 1, []llm.Message{
		{Role: llm.RoleUser, Content: "hello"},
	}); err != nil {
		t.Fatalf("AppendMessages: %v", err)
	}

	summaries, err := s.ListSessions()
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}

	if len(summaries) != 2 {
		t.Fatalf("got %d summaries, want 2", len(summaries))
	}

	// sess-a should be first (most recently updated).
	if summaries[0].ID != "sess-a" {
		t.Errorf("first session = %q, want sess-a", summaries[0].ID)
	}
	if summaries[0].MessageCount != 1 {
		t.Errorf("sess-a message count = %d, want 1", summaries[0].MessageCount)
	}
	if summaries[0].UserPrompt != "first" {
		t.Errorf("sess-a user prompt = %q, want first", summaries[0].UserPrompt)
	}
	if summaries[1].ID != "sess-b" {
		t.Errorf("second session = %q, want sess-b", summaries[1].ID)
	}
	if summaries[1].MessageCount != 0 {
		t.Errorf("sess-b message count = %d, want 0", summaries[1].MessageCount)
	}
}

func TestUpdateStatus(t *testing.T) {
	s := tempStore(t)

	if _, err := s.CreateSession("sess-st", SessionConfig{}); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if err := s.UpdateStatus("sess-st", StatusCompleted); err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}

	sess, err := s.LoadSession("sess-st")
	if err != nil {
		t.Fatalf("LoadSession: %v", err)
	}
	if sess.Status != StatusCompleted {
		t.Errorf("status = %q, want %q", sess.Status, StatusCompleted)
	}

	// Update nonexistent session should error.
	if err := s.UpdateStatus("nonexistent", StatusError); err == nil {
		t.Error("expected error for nonexistent session")
	}
}

func TestMessageOrderingAcrossTurns(t *testing.T) {
	s := tempStore(t)

	if _, err := s.CreateSession("sess-ord", SessionConfig{}); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Turn 1: user + assistant.
	turn1 := []llm.Message{
		{Role: llm.RoleUser, Content: "turn 1 user"},
		{Role: llm.RoleAssistant, Content: "turn 1 assistant"},
	}
	if err := s.AppendMessages("sess-ord", 1, turn1); err != nil {
		t.Fatalf("AppendMessages turn 1: %v", err)
	}

	// Turn 2: user + assistant.
	turn2 := []llm.Message{
		{Role: llm.RoleUser, Content: "turn 2 user"},
		{Role: llm.RoleAssistant, Content: "turn 2 assistant"},
	}
	if err := s.AppendMessages("sess-ord", 2, turn2); err != nil {
		t.Fatalf("AppendMessages turn 2: %v", err)
	}

	loaded, err := s.LoadMessages("sess-ord")
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}

	if len(loaded) != 4 {
		t.Fatalf("loaded %d messages, want 4", len(loaded))
	}

	expected := []string{"turn 1 user", "turn 1 assistant", "turn 2 user", "turn 2 assistant"}
	for i, want := range expected {
		if loaded[i].Content != want {
			t.Errorf("msg[%d].Content = %q, want %q", i, loaded[i].Content, want)
		}
	}
}

func TestConcurrentAccess(t *testing.T) {
	s := tempStore(t)

	if _, err := s.CreateSession("sess-conc", SessionConfig{}); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	var wg sync.WaitGroup
	errs := make(chan error, 10)

	for i := range 10 {
		wg.Add(1)
		go func(turn int) {
			defer wg.Done()
			msgs := []llm.Message{
				{Role: llm.RoleUser, Content: "concurrent message"},
			}
			if err := s.AppendMessages("sess-conc", turn, msgs); err != nil {
				errs <- err
			}
		}(i + 1)
	}

	wg.Wait()
	close(errs)

	for err := range errs {
		t.Errorf("concurrent append error: %v", err)
	}

	loaded, err := s.LoadMessages("sess-conc")
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}
	if len(loaded) != 10 {
		t.Errorf("loaded %d messages, want 10", len(loaded))
	}
}
