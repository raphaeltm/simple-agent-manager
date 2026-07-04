package session

import (
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/workspace/harness/features"
	"github.com/workspace/harness/llm"
)

func tempDB(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	s, err := NewStore(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestCreateAndLoadSession(t *testing.T) {
	s := tempDB(t)

	sess, err := s.CreateSession("sess-1", Config{
		SystemPrompt: "You are helpful.",
		WorkDir:      "/tmp/work",
		Model:        "gpt-4",
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if sess.ID != "sess-1" {
		t.Errorf("expected ID sess-1, got %q", sess.ID)
	}
	if sess.Status != "active" {
		t.Errorf("expected status active, got %q", sess.Status)
	}
	if sess.SystemPrompt != "You are helpful." {
		t.Errorf("unexpected system prompt: %q", sess.SystemPrompt)
	}
	if sess.TotalTurns != 0 {
		t.Errorf("expected 0 turns, got %d", sess.TotalTurns)
	}

	loaded, err := s.LoadSession("sess-1")
	if err != nil {
		t.Fatalf("LoadSession: %v", err)
	}
	if loaded.WorkDir != "/tmp/work" {
		t.Errorf("expected WorkDir /tmp/work, got %q", loaded.WorkDir)
	}
	if loaded.Model != "gpt-4" {
		t.Errorf("expected Model gpt-4, got %q", loaded.Model)
	}
}

func TestAppendAndLoadMessages(t *testing.T) {
	s := tempDB(t)
	s.CreateSession("sess-1", Config{})

	// Turn 1: user message + assistant with tool calls.
	msgs := []llm.Message{
		{Role: llm.RoleUser, Content: "Hello"},
		{
			Role:    llm.RoleAssistant,
			Content: "Let me check.",
			ToolCalls: []llm.ToolCall{
				{ID: "tc-1", Name: "read_file", Params: map[string]any{"path": "main.go"}},
			},
		},
		{
			Role:       llm.RoleTool,
			ToolResult: &llm.ToolResult{CallID: "tc-1", Content: "package main", IsError: false},
		},
	}
	if err := s.AppendMessages("sess-1", 1, msgs); err != nil {
		t.Fatalf("AppendMessages turn 1: %v", err)
	}

	// Turn 2: assistant final.
	msgs2 := []llm.Message{
		{Role: llm.RoleAssistant, Content: "Done!"},
	}
	if err := s.AppendMessages("sess-1", 2, msgs2); err != nil {
		t.Fatalf("AppendMessages turn 2: %v", err)
	}

	loaded, err := s.LoadMessages("sess-1")
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}
	if len(loaded) != 4 {
		t.Fatalf("expected 4 messages, got %d", len(loaded))
	}

	// Verify user message.
	if loaded[0].Role != llm.RoleUser || loaded[0].Content != "Hello" {
		t.Errorf("message 0: unexpected %+v", loaded[0])
	}

	// Verify assistant with tool calls.
	if loaded[1].Role != llm.RoleAssistant || len(loaded[1].ToolCalls) != 1 {
		t.Errorf("message 1: expected 1 tool call, got %+v", loaded[1])
	}
	if loaded[1].ToolCalls[0].Name != "read_file" {
		t.Errorf("tool call name: %q", loaded[1].ToolCalls[0].Name)
	}

	// Verify tool result.
	if loaded[2].ToolResult == nil || loaded[2].ToolResult.Content != "package main" {
		t.Errorf("message 2: unexpected tool result %+v", loaded[2])
	}

	// Verify final message.
	if loaded[3].Content != "Done!" {
		t.Errorf("message 3: expected Done!, got %q", loaded[3].Content)
	}

	// Verify total_turns updated.
	sess, _ := s.LoadSession("sess-1")
	if sess.TotalTurns != 2 {
		t.Errorf("expected 2 total_turns, got %d", sess.TotalTurns)
	}
}

func TestListSessions(t *testing.T) {
	s := tempDB(t)

	s.CreateSession("a", Config{})
	s.CreateSession("b", Config{})
	s.CreateSession("c", Config{})

	list, err := s.ListSessions(2)
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(list))
	}
	// Most recent first.
	if list[0].ID != "c" {
		t.Errorf("expected first session c, got %q", list[0].ID)
	}
}

func TestUpdateStatus(t *testing.T) {
	s := tempDB(t)
	s.CreateSession("sess-1", Config{})

	if err := s.UpdateStatus("sess-1", "completed"); err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}
	sess, _ := s.LoadSession("sess-1")
	if sess.Status != "completed" {
		t.Errorf("expected completed, got %q", sess.Status)
	}
}

func TestSaveAndLoadFeatures(t *testing.T) {
	s := tempDB(t)
	s.CreateSession("sess-1", Config{})

	list, err := features.New([]features.Feature{{
		ID:           "gate",
		Behavior:     "Gate completion",
		Verification: []string{"go test ./..."},
	}})
	if err != nil {
		t.Fatalf("features.New: %v", err)
	}
	if err := list.Start("gate"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := s.SaveFeatures("sess-1", list); err != nil {
		t.Fatalf("SaveFeatures: %v", err)
	}

	loaded, err := s.LoadFeatures("sess-1")
	if err != nil {
		t.Fatalf("LoadFeatures: %v", err)
	}
	snapshot := loaded.Snapshot()
	if len(snapshot) != 1 {
		t.Fatalf("expected 1 feature, got %d", len(snapshot))
	}
	if snapshot[0].ID != "gate" || snapshot[0].Status != features.StatusInProgress {
		t.Fatalf("unexpected feature state: %+v", snapshot[0])
	}
}

func TestConcurrentAccess(t *testing.T) {
	s := tempDB(t)
	s.CreateSession("s1", Config{})
	s.CreateSession("s2", Config{})

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		for i := 1; i <= 10; i++ {
			if err := s.AppendMessages("s1", i, []llm.Message{{Role: llm.RoleUser, Content: "msg"}}); err != nil {
				t.Errorf("s1 turn %d: %v", i, err)
			}
		}
	}()
	go func() {
		defer wg.Done()
		for i := 1; i <= 10; i++ {
			if err := s.AppendMessages("s2", i, []llm.Message{{Role: llm.RoleUser, Content: "msg"}}); err != nil {
				t.Errorf("s2 turn %d: %v", i, err)
			}
		}
	}()

	wg.Wait()

	m1, _ := s.LoadMessages("s1")
	m2, _ := s.LoadMessages("s2")
	if len(m1) != 10 || len(m2) != 10 {
		t.Errorf("expected 10 messages each, got s1=%d s2=%d", len(m1), len(m2))
	}
}

func TestNewStore_CreatesDirectory(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "sub", "nested", "test.db")

	s, err := NewStore(dbPath)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	defer s.Close()

	if _, err := os.Stat(dbPath); err != nil {
		t.Errorf("expected db file to exist: %v", err)
	}
}
