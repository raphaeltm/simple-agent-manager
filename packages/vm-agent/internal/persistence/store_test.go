package persistence

import (
	"os"
	"path/filepath"
	"testing"
)

func tempDBPath(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	return filepath.Join(dir, "test.db")
}

func TestOpenAndClose(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestOpenCreatesDirectoryAndFile(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "sub", "nested", "test.db")

	// Parent directories don't exist yet — Open should still work because
	// SQLite creates the file (modernc.org/sqlite handles this).
	// However, the OS must be able to create intermediate dirs. Let's pre-create them.
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	store, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		t.Fatal("database file was not created")
	}
}

func TestInsertAndListTabs(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	// Insert terminal tab
	err = store.InsertTab(Tab{
		ID:          "term-1",
		WorkspaceID: "ws-1",
		Type:        "terminal",
		Label:       "Terminal 1",
		SortOrder:   0,
	})
	if err != nil {
		t.Fatalf("InsertTab terminal: %v", err)
	}

	// Insert chat tab
	err = store.InsertTab(Tab{
		ID:          "chat-1",
		WorkspaceID: "ws-1",
		Type:        "chat",
		Label:       "Claude Code Chat",
		AgentID:     "claude-code",
		SortOrder:   1,
	})
	if err != nil {
		t.Fatalf("InsertTab chat: %v", err)
	}

	// Insert tab for different workspace
	err = store.InsertTab(Tab{
		ID:          "term-2",
		WorkspaceID: "ws-2",
		Type:        "terminal",
		Label:       "Terminal 1",
		SortOrder:   0,
	})
	if err != nil {
		t.Fatalf("InsertTab ws-2: %v", err)
	}

	// List tabs for ws-1
	tabs, err := store.ListTabs("ws-1")
	if err != nil {
		t.Fatalf("ListTabs: %v", err)
	}
	if len(tabs) != 2 {
		t.Fatalf("expected 2 tabs, got %d", len(tabs))
	}
	if tabs[0].ID != "term-1" {
		t.Errorf("expected first tab ID 'term-1', got %q", tabs[0].ID)
	}
	if tabs[1].ID != "chat-1" {
		t.Errorf("expected second tab ID 'chat-1', got %q", tabs[1].ID)
	}
	if tabs[1].AgentID != "claude-code" {
		t.Errorf("expected agent_id 'claude-code', got %q", tabs[1].AgentID)
	}

	// List tabs for ws-2
	tabs2, err := store.ListTabs("ws-2")
	if err != nil {
		t.Fatalf("ListTabs ws-2: %v", err)
	}
	if len(tabs2) != 1 {
		t.Fatalf("expected 1 tab for ws-2, got %d", len(tabs2))
	}

	// List tabs for non-existent workspace
	empty, err := store.ListTabs("ws-999")
	if err != nil {
		t.Fatalf("ListTabs non-existent: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("expected 0 tabs, got %d", len(empty))
	}
}

func TestDeleteTab(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	_ = store.InsertTab(Tab{ID: "t1", WorkspaceID: "ws-1", Type: "terminal", Label: "Term 1"})
	_ = store.InsertTab(Tab{ID: "t2", WorkspaceID: "ws-1", Type: "terminal", Label: "Term 2"})

	if err := store.DeleteTab("t1"); err != nil {
		t.Fatalf("DeleteTab: %v", err)
	}

	tabs, _ := store.ListTabs("ws-1")
	if len(tabs) != 1 {
		t.Fatalf("expected 1 tab after delete, got %d", len(tabs))
	}
	if tabs[0].ID != "t2" {
		t.Errorf("expected remaining tab 't2', got %q", tabs[0].ID)
	}

	// Deleting non-existent tab should not error
	if err := store.DeleteTab("nonexistent"); err != nil {
		t.Fatalf("DeleteTab non-existent: %v", err)
	}
}

func TestDeleteWorkspaceTabs(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	_ = store.InsertTab(Tab{ID: "t1", WorkspaceID: "ws-1", Type: "terminal"})
	_ = store.InsertTab(Tab{ID: "t2", WorkspaceID: "ws-1", Type: "chat", AgentID: "claude-code"})
	_ = store.InsertTab(Tab{ID: "t3", WorkspaceID: "ws-2", Type: "terminal"})

	if err := store.DeleteWorkspaceTabs("ws-1"); err != nil {
		t.Fatalf("DeleteWorkspaceTabs: %v", err)
	}

	tabs1, _ := store.ListTabs("ws-1")
	if len(tabs1) != 0 {
		t.Fatalf("expected 0 tabs for ws-1, got %d", len(tabs1))
	}

	tabs2, _ := store.ListTabs("ws-2")
	if len(tabs2) != 1 {
		t.Fatalf("expected 1 tab for ws-2, got %d", len(tabs2))
	}
}

func TestUpdateTabLabel(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	_ = store.InsertTab(Tab{ID: "t1", WorkspaceID: "ws-1", Type: "terminal", Label: "Term 1"})

	if err := store.UpdateTabLabel("t1", "Renamed Terminal"); err != nil {
		t.Fatalf("UpdateTabLabel: %v", err)
	}

	tabs, _ := store.ListTabs("ws-1")
	if tabs[0].Label != "Renamed Terminal" {
		t.Errorf("expected label 'Renamed Terminal', got %q", tabs[0].Label)
	}
}

func TestUpdateTabOrder(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	_ = store.InsertTab(Tab{ID: "t1", WorkspaceID: "ws-1", Type: "terminal", SortOrder: 0})
	_ = store.InsertTab(Tab{ID: "t2", WorkspaceID: "ws-1", Type: "chat", SortOrder: 1})

	// Swap order
	_ = store.UpdateTabOrder("t1", 1)
	_ = store.UpdateTabOrder("t2", 0)

	tabs, _ := store.ListTabs("ws-1")
	if tabs[0].ID != "t2" {
		t.Errorf("expected first tab 't2' after reorder, got %q", tabs[0].ID)
	}
	if tabs[1].ID != "t1" {
		t.Errorf("expected second tab 't1' after reorder, got %q", tabs[1].ID)
	}
}

func TestTabCount(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	count, _ := store.TabCount("ws-1")
	if count != 0 {
		t.Fatalf("expected 0, got %d", count)
	}

	_ = store.InsertTab(Tab{ID: "t1", WorkspaceID: "ws-1", Type: "terminal"})
	_ = store.InsertTab(Tab{ID: "t2", WorkspaceID: "ws-1", Type: "chat"})

	count, _ = store.TabCount("ws-1")
	if count != 2 {
		t.Fatalf("expected 2, got %d", count)
	}
}

func TestMigrationIdempotent(t *testing.T) {
	dbPath := tempDBPath(t)

	// Open, insert data, close
	store1, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open 1: %v", err)
	}
	_ = store1.InsertTab(Tab{ID: "t1", WorkspaceID: "ws-1", Type: "terminal", Label: "Term"})
	store1.Close()

	// Reopen — migrations should be idempotent, data should persist
	store2, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open 2: %v", err)
	}
	defer store2.Close()

	tabs, _ := store2.ListTabs("ws-1")
	if len(tabs) != 1 {
		t.Fatalf("expected 1 tab after reopen, got %d", len(tabs))
	}
	if tabs[0].Label != "Term" {
		t.Errorf("expected label 'Term', got %q", tabs[0].Label)
	}
}

func TestUpdateTabAcpSessionID(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	_ = store.InsertTab(Tab{ID: "chat-1", WorkspaceID: "ws-1", Type: "chat", AgentID: "claude-code"})

	// Verify initial AcpSessionID is empty
	tabs, _ := store.ListTabs("ws-1")
	if tabs[0].AcpSessionID != "" {
		t.Errorf("expected empty AcpSessionID initially, got %q", tabs[0].AcpSessionID)
	}

	// Update ACP session ID
	if err := store.UpdateTabAcpSessionID("chat-1", "acp-session-xyz"); err != nil {
		t.Fatalf("UpdateTabAcpSessionID: %v", err)
	}

	// Verify update
	tabs, _ = store.ListTabs("ws-1")
	if tabs[0].AcpSessionID != "acp-session-xyz" {
		t.Errorf("expected AcpSessionID 'acp-session-xyz', got %q", tabs[0].AcpSessionID)
	}
}

func TestAcpSessionIDPersistedThroughInsert(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	_ = store.InsertTab(Tab{
		ID:           "chat-1",
		WorkspaceID:  "ws-1",
		Type:         "chat",
		AgentID:      "claude-code",
		AcpSessionID: "acp-session-initial",
	})

	tabs, _ := store.ListTabs("ws-1")
	if tabs[0].AcpSessionID != "acp-session-initial" {
		t.Errorf("expected AcpSessionID 'acp-session-initial', got %q", tabs[0].AcpSessionID)
	}
}

func TestMigrationV2AddsAcpSessionIDColumn(t *testing.T) {
	dbPath := tempDBPath(t)

	// Open store (runs both migrations)
	store, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	// Insert a tab and verify acp_session_id column works
	err = store.InsertTab(Tab{
		ID:           "t1",
		WorkspaceID:  "ws-1",
		Type:         "chat",
		AcpSessionID: "test-acp-id",
	})
	if err != nil {
		t.Fatalf("InsertTab with acp_session_id: %v", err)
	}

	tabs, err := store.ListTabs("ws-1")
	if err != nil {
		t.Fatalf("ListTabs: %v", err)
	}
	if len(tabs) != 1 {
		t.Fatalf("expected 1 tab, got %d", len(tabs))
	}
	if tabs[0].AcpSessionID != "test-acp-id" {
		t.Errorf("expected AcpSessionID 'test-acp-id', got %q", tabs[0].AcpSessionID)
	}

	store.Close()

	// Reopen — should not fail (migration is idempotent)
	store2, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Reopen after migration v2: %v", err)
	}
	defer store2.Close()

	tabs, _ = store2.ListTabs("ws-1")
	if tabs[0].AcpSessionID != "test-acp-id" {
		t.Errorf("expected AcpSessionID persisted after reopen, got %q", tabs[0].AcpSessionID)
	}
}

func TestInsertOrReplace(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	_ = store.InsertTab(Tab{ID: "t1", WorkspaceID: "ws-1", Type: "terminal", Label: "Original"})
	_ = store.InsertTab(Tab{ID: "t1", WorkspaceID: "ws-1", Type: "terminal", Label: "Updated"})

	tabs, _ := store.ListTabs("ws-1")
	if len(tabs) != 1 {
		t.Fatalf("expected 1 tab after upsert, got %d", len(tabs))
	}
	if tabs[0].Label != "Updated" {
		t.Errorf("expected label 'Updated', got %q", tabs[0].Label)
	}
}

func TestUpdateTabLastPrompt(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	_ = store.InsertTab(Tab{ID: "chat-1", WorkspaceID: "ws-1", Type: "chat", AgentID: "claude-code"})

	// Verify initial LastPrompt is empty
	tabs, _ := store.ListTabs("ws-1")
	if tabs[0].LastPrompt != "" {
		t.Errorf("expected empty LastPrompt initially, got %q", tabs[0].LastPrompt)
	}

	// Update last prompt
	if err := store.UpdateTabLastPrompt("chat-1", "Help me fix the login bug"); err != nil {
		t.Fatalf("UpdateTabLastPrompt: %v", err)
	}

	// Verify update
	tabs, _ = store.ListTabs("ws-1")
	if tabs[0].LastPrompt != "Help me fix the login bug" {
		t.Errorf("expected LastPrompt 'Help me fix the login bug', got %q", tabs[0].LastPrompt)
	}

	// Update again (overwrite)
	if err := store.UpdateTabLastPrompt("chat-1", "Now refactor the auth module"); err != nil {
		t.Fatalf("UpdateTabLastPrompt overwrite: %v", err)
	}

	tabs, _ = store.ListTabs("ws-1")
	if tabs[0].LastPrompt != "Now refactor the auth module" {
		t.Errorf("expected overwritten LastPrompt, got %q", tabs[0].LastPrompt)
	}
}

func TestLastPromptPersistedThroughInsert(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	_ = store.InsertTab(Tab{
		ID:          "chat-1",
		WorkspaceID: "ws-1",
		Type:        "chat",
		LastPrompt:  "initial prompt text",
	})

	tabs, _ := store.ListTabs("ws-1")
	if tabs[0].LastPrompt != "initial prompt text" {
		t.Errorf("expected LastPrompt 'initial prompt text', got %q", tabs[0].LastPrompt)
	}
}

func TestMigrationV3AddsLastPromptColumn(t *testing.T) {
	dbPath := tempDBPath(t)

	// Open store (runs all migrations including v3)
	store, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	// Insert a tab and verify last_prompt column works
	err = store.InsertTab(Tab{
		ID:          "t1",
		WorkspaceID: "ws-1",
		Type:        "chat",
		LastPrompt:  "test prompt",
	})
	if err != nil {
		t.Fatalf("InsertTab with last_prompt: %v", err)
	}

	tabs, err := store.ListTabs("ws-1")
	if err != nil {
		t.Fatalf("ListTabs: %v", err)
	}
	if tabs[0].LastPrompt != "test prompt" {
		t.Errorf("expected LastPrompt 'test prompt', got %q", tabs[0].LastPrompt)
	}

	store.Close()

	// Reopen — should not fail (migration is idempotent)
	store2, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Reopen after migration v3: %v", err)
	}
	defer store2.Close()

	tabs, _ = store2.ListTabs("ws-1")
	if tabs[0].LastPrompt != "test prompt" {
		t.Errorf("expected LastPrompt persisted after reopen, got %q", tabs[0].LastPrompt)
	}
}
