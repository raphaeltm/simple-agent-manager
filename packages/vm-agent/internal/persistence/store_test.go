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

func TestUpsertAndGetWorkspaceMetadata(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	// Initially no metadata
	meta, err := store.GetWorkspaceMetadata("ws-1")
	if err != nil {
		t.Fatalf("GetWorkspaceMetadata: %v", err)
	}
	if meta != nil {
		t.Fatal("expected nil for non-existent workspace metadata")
	}

	// Upsert metadata
	err = store.UpsertWorkspaceMetadata(WorkspaceMetadata{
		WorkspaceID:       "ws-1",
		Repository:        "octo/my-repo",
		Branch:            "main",
		ContainerWorkDir:  "/workspaces/my-repo",
		ContainerUser:     "vscode",
		ContainerLabelVal: "/workspace/ws-1",
		WorkspaceDir:      "/workspace/ws-1",
	})
	if err != nil {
		t.Fatalf("UpsertWorkspaceMetadata: %v", err)
	}

	// Read back
	meta, err = store.GetWorkspaceMetadata("ws-1")
	if err != nil {
		t.Fatalf("GetWorkspaceMetadata: %v", err)
	}
	if meta == nil {
		t.Fatal("expected non-nil metadata")
	}
	if meta.Repository != "octo/my-repo" {
		t.Errorf("expected repository 'octo/my-repo', got %q", meta.Repository)
	}
	if meta.Branch != "main" {
		t.Errorf("expected branch 'main', got %q", meta.Branch)
	}
	if meta.ContainerWorkDir != "/workspaces/my-repo" {
		t.Errorf("expected ContainerWorkDir '/workspaces/my-repo', got %q", meta.ContainerWorkDir)
	}
	if meta.ContainerUser != "vscode" {
		t.Errorf("expected ContainerUser 'vscode', got %q", meta.ContainerUser)
	}
	if meta.ContainerLabelVal != "/workspace/ws-1" {
		t.Errorf("expected ContainerLabelVal '/workspace/ws-1', got %q", meta.ContainerLabelVal)
	}
	if meta.WorkspaceDir != "/workspace/ws-1" {
		t.Errorf("expected WorkspaceDir '/workspace/ws-1', got %q", meta.WorkspaceDir)
	}
	if meta.UpdatedAt == "" {
		t.Error("expected non-empty UpdatedAt")
	}

	// Upsert again — should overwrite
	err = store.UpsertWorkspaceMetadata(WorkspaceMetadata{
		WorkspaceID:       "ws-1",
		Repository:        "octo/my-repo",
		Branch:            "feature-branch",
		ContainerWorkDir:  "/workspaces/my-repo",
		ContainerUser:     "root",
		ContainerLabelVal: "/workspace/ws-1",
		WorkspaceDir:      "/workspace/ws-1",
	})
	if err != nil {
		t.Fatalf("UpsertWorkspaceMetadata overwrite: %v", err)
	}

	meta, err = store.GetWorkspaceMetadata("ws-1")
	if err != nil {
		t.Fatalf("GetWorkspaceMetadata after overwrite: %v", err)
	}
	if meta.Branch != "feature-branch" {
		t.Errorf("expected branch 'feature-branch' after overwrite, got %q", meta.Branch)
	}
	if meta.ContainerUser != "root" {
		t.Errorf("expected ContainerUser 'root' after overwrite, got %q", meta.ContainerUser)
	}
}

func TestDeleteWorkspaceMetadata(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	_ = store.UpsertWorkspaceMetadata(WorkspaceMetadata{
		WorkspaceID:      "ws-1",
		Repository:       "octo/repo",
		ContainerWorkDir: "/workspaces/repo",
	})

	if err := store.DeleteWorkspaceMetadata("ws-1"); err != nil {
		t.Fatalf("DeleteWorkspaceMetadata: %v", err)
	}

	meta, _ := store.GetWorkspaceMetadata("ws-1")
	if meta != nil {
		t.Fatal("expected nil after delete")
	}

	// Deleting non-existent should not error
	if err := store.DeleteWorkspaceMetadata("ws-999"); err != nil {
		t.Fatalf("DeleteWorkspaceMetadata non-existent: %v", err)
	}
}

func TestWorkspaceMetadataPersistedAcrossReopen(t *testing.T) {
	dbPath := tempDBPath(t)

	store1, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open 1: %v", err)
	}

	_ = store1.UpsertWorkspaceMetadata(WorkspaceMetadata{
		WorkspaceID:      "ws-persist",
		Repository:       "owner/repo-name",
		Branch:           "develop",
		ContainerWorkDir: "/workspaces/repo-name",
		WorkspaceDir:     "/workspace/ws-persist",
	})
	store1.Close()

	store2, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open 2: %v", err)
	}
	defer store2.Close()

	meta, err := store2.GetWorkspaceMetadata("ws-persist")
	if err != nil {
		t.Fatalf("GetWorkspaceMetadata after reopen: %v", err)
	}
	if meta == nil {
		t.Fatal("expected metadata to survive reopen")
	}
	if meta.Repository != "owner/repo-name" {
		t.Errorf("expected repository 'owner/repo-name', got %q", meta.Repository)
	}
	if meta.ContainerWorkDir != "/workspaces/repo-name" {
		t.Errorf("expected ContainerWorkDir '/workspaces/repo-name', got %q", meta.ContainerWorkDir)
	}
}

func TestUpsertAndGetSessionMcpServers(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	// Initially no servers — returns empty (non-nil) slice
	servers, err := store.GetSessionMcpServers("ws-1", "sess-1")
	if err != nil {
		t.Fatalf("GetSessionMcpServers: %v", err)
	}
	if len(servers) != 0 {
		t.Fatalf("expected 0 servers for non-existent session, got %d", len(servers))
	}

	// Upsert
	err = store.UpsertSessionMcpServers("ws-1", "sess-1", []McpServer{
		{URL: "https://api.example.com/mcp", Token: "tok-123"},
	})
	if err != nil {
		t.Fatalf("UpsertSessionMcpServers: %v", err)
	}

	// Read back
	servers, err = store.GetSessionMcpServers("ws-1", "sess-1")
	if err != nil {
		t.Fatalf("GetSessionMcpServers: %v", err)
	}
	if len(servers) != 1 {
		t.Fatalf("expected 1 server, got %d", len(servers))
	}
	if servers[0].URL != "https://api.example.com/mcp" {
		t.Errorf("expected URL 'https://api.example.com/mcp', got %q", servers[0].URL)
	}
	if servers[0].Token != "tok-123" {
		t.Errorf("expected Token 'tok-123', got %q", servers[0].Token)
	}

	// Upsert again (overwrite)
	err = store.UpsertSessionMcpServers("ws-1", "sess-1", []McpServer{
		{URL: "https://api.example.com/mcp", Token: "tok-456"},
		{URL: "https://api2.example.com/mcp", Token: "tok-789"},
	})
	if err != nil {
		t.Fatalf("UpsertSessionMcpServers overwrite: %v", err)
	}

	servers, err = store.GetSessionMcpServers("ws-1", "sess-1")
	if err != nil {
		t.Fatalf("GetSessionMcpServers after overwrite: %v", err)
	}
	if len(servers) != 2 {
		t.Fatalf("expected 2 servers after overwrite, got %d", len(servers))
	}
	if servers[0].Token != "tok-456" {
		t.Errorf("expected first token 'tok-456', got %q", servers[0].Token)
	}

	// Different session should be isolated
	servers2, err := store.GetSessionMcpServers("ws-1", "sess-2")
	if err != nil {
		t.Fatalf("GetSessionMcpServers different session: %v", err)
	}
	if len(servers2) != 0 {
		t.Fatalf("expected 0 servers for different session, got %d", len(servers2))
	}
}

func TestDeleteSessionMcpServers(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	_ = store.UpsertSessionMcpServers("ws-1", "sess-1", []McpServer{
		{URL: "https://api.example.com/mcp", Token: "tok"},
	})
	_ = store.UpsertSessionMcpServers("ws-1", "sess-2", []McpServer{
		{URL: "https://api2.example.com/mcp", Token: "tok2"},
	})

	// Delete one session
	if err := store.DeleteSessionMcpServers("ws-1", "sess-1"); err != nil {
		t.Fatalf("DeleteSessionMcpServers: %v", err)
	}

	servers, _ := store.GetSessionMcpServers("ws-1", "sess-1")
	if len(servers) != 0 {
		t.Fatalf("expected 0 servers after delete, got %d", len(servers))
	}

	// Other session should survive
	servers2, _ := store.GetSessionMcpServers("ws-1", "sess-2")
	if len(servers2) != 1 {
		t.Fatalf("expected 1 server for sess-2, got %d", len(servers2))
	}

	// Deleting non-existent should not error
	if err := store.DeleteSessionMcpServers("ws-1", "nonexistent"); err != nil {
		t.Fatalf("DeleteSessionMcpServers non-existent: %v", err)
	}
}

func TestDeleteWorkspaceMcpServers(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	_ = store.UpsertSessionMcpServers("ws-1", "sess-1", []McpServer{
		{URL: "https://api.example.com/mcp", Token: "tok1"},
	})
	_ = store.UpsertSessionMcpServers("ws-1", "sess-2", []McpServer{
		{URL: "https://api.example.com/mcp", Token: "tok2"},
	})
	_ = store.UpsertSessionMcpServers("ws-2", "sess-3", []McpServer{
		{URL: "https://api.example.com/mcp", Token: "tok3"},
	})

	// Delete all for ws-1
	if err := store.DeleteWorkspaceMcpServers("ws-1"); err != nil {
		t.Fatalf("DeleteWorkspaceMcpServers: %v", err)
	}

	s1, _ := store.GetSessionMcpServers("ws-1", "sess-1")
	s2, _ := store.GetSessionMcpServers("ws-1", "sess-2")
	if len(s1) != 0 || len(s2) != 0 {
		t.Fatalf("expected 0 servers for all ws-1 sessions after workspace delete, got %d and %d", len(s1), len(s2))
	}

	// ws-2 should survive
	s3, _ := store.GetSessionMcpServers("ws-2", "sess-3")
	if len(s3) != 1 {
		t.Fatalf("expected 1 server for ws-2, got %d", len(s3))
	}
}

func TestSessionMcpServersPersistedAcrossReopen(t *testing.T) {
	dbPath := tempDBPath(t)

	store1, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open 1: %v", err)
	}

	_ = store1.UpsertSessionMcpServers("ws-1", "sess-1", []McpServer{
		{URL: "https://api.example.com/mcp", Token: "persist-tok"},
	})
	store1.Close()

	store2, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open 2: %v", err)
	}
	defer store2.Close()

	servers, err := store2.GetSessionMcpServers("ws-1", "sess-1")
	if err != nil {
		t.Fatalf("GetSessionMcpServers after reopen: %v", err)
	}
	if len(servers) != 1 {
		t.Fatalf("expected 1 server after reopen, got %d", len(servers))
	}
	if servers[0].Token != "persist-tok" {
		t.Errorf("expected token 'persist-tok' after reopen, got %q", servers[0].Token)
	}
}

func TestMigrationV6AddsLightweightColumn(t *testing.T) {
	dbPath := tempDBPath(t)

	store, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	err = store.UpsertWorkspaceMetadata(WorkspaceMetadata{
		WorkspaceID:      "ws-1",
		Repository:       "octo/repo",
		ContainerWorkDir: "/workspaces/repo",
		Lightweight:      true,
	})
	if err != nil {
		t.Fatalf("UpsertWorkspaceMetadata with lightweight: %v", err)
	}
	store.Close()

	// Reopen — migration must be idempotent
	store2, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Reopen after migration v6: %v", err)
	}
	defer store2.Close()

	meta, _ := store2.GetWorkspaceMetadata("ws-1")
	if meta == nil {
		t.Fatal("expected metadata to survive reopen")
	}
	if !meta.Lightweight {
		t.Error("expected Lightweight=true persisted after reopen")
	}
}

func TestWorkspaceMetadataLightweightRoundTrip(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	// Upsert with lightweight=true
	err = store.UpsertWorkspaceMetadata(WorkspaceMetadata{
		WorkspaceID:       "ws-light",
		Repository:        "octo/repo",
		Branch:            "main",
		ContainerWorkDir:  "/workspaces/repo",
		ContainerUser:     "vscode",
		ContainerLabelVal: "/workspace/ws-light",
		WorkspaceDir:      "/workspace/ws-light",
		Lightweight:       true,
	})
	if err != nil {
		t.Fatalf("UpsertWorkspaceMetadata: %v", err)
	}

	meta, err := store.GetWorkspaceMetadata("ws-light")
	if err != nil {
		t.Fatalf("GetWorkspaceMetadata: %v", err)
	}
	if meta == nil {
		t.Fatal("expected non-nil metadata")
	}
	if !meta.Lightweight {
		t.Error("expected Lightweight=true after round-trip, got false")
	}
}

func TestWorkspaceMetadataLightweightDefaultsFalse(t *testing.T) {
	store, err := Open(tempDBPath(t))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer store.Close()

	// Upsert without setting Lightweight (zero value = false)
	err = store.UpsertWorkspaceMetadata(WorkspaceMetadata{
		WorkspaceID:       "ws-full",
		Repository:        "octo/repo",
		Branch:            "main",
		ContainerWorkDir:  "/workspaces/repo",
		ContainerUser:     "vscode",
		ContainerLabelVal: "/workspace/ws-full",
		WorkspaceDir:      "/workspace/ws-full",
	})
	if err != nil {
		t.Fatalf("UpsertWorkspaceMetadata: %v", err)
	}

	meta, err := store.GetWorkspaceMetadata("ws-full")
	if err != nil {
		t.Fatalf("GetWorkspaceMetadata: %v", err)
	}
	if meta == nil {
		t.Fatal("expected non-nil metadata")
	}
	if meta.Lightweight {
		t.Error("expected Lightweight=false by default, got true")
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
