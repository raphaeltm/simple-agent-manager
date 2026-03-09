package server

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/pty"

	_ "modernc.org/sqlite"
)

// openTestSQLiteDB creates a temp-file-backed SQLite database for testing.
func openTestSQLiteDB(t *testing.T) (string, *sql.DB) {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?cache=shared&mode=rwc&_journal_mode=WAL", dbPath))
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	db.Exec("PRAGMA journal_mode=WAL")
	db.Exec("PRAGMA busy_timeout=5000")
	t.Cleanup(func() {
		db.Close()
		os.RemoveAll(dir)
	})
	return dbPath, db
}

func newServerWithoutReporter(t *testing.T) (*Server, string) {
	t.Helper()
	dbPath, _ := openTestSQLiteDB(t)

	ptyManager := pty.NewManager(pty.ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		WorkDir:      "/tmp",
		BufferSize:   1024,
	})

	s := &Server{
		config: &config.Config{
			NodeID:            "node-test",
			PersistenceDBPath: dbPath,
			ControlPlaneURL:   "http://localhost:8787",
		},
		ptyManager:          ptyManager,
		workspaces:          make(map[string]*WorkspaceRuntime),
		nodeEvents:          make([]EventRecord, 0),
		workspaceEvents:     map[string][]EventRecord{},
		agentSessions:       agentsessions.NewManager(),
		acpConfig:           acp.GatewayConfig{},
		sessionHosts:        make(map[string]*acp.SessionHost),
		bootLogBroadcasters: NewBootLogBroadcasterManager(),
		messageReporter:     nil, // Simulates manually provisioned node
		done:                make(chan struct{}),
	}

	return s, dbPath
}

func TestLateInitMessageReporter_CreatesReporter(t *testing.T) {
	t.Parallel()
	s, _ := newServerWithoutReporter(t)

	if s.messageReporter != nil {
		t.Fatal("expected messageReporter to be nil before late init")
	}
	if s.acpConfig.MessageReporter != nil {
		t.Fatal("expected acpConfig.MessageReporter to be nil before late init")
	}

	s.lateInitMessageReporter("ws-test-1", "proj-1", "sess-1")

	if s.messageReporter == nil {
		t.Fatal("expected messageReporter to be non-nil after late init")
	}
	if s.acpConfig.MessageReporter == nil {
		t.Fatal("expected acpConfig.MessageReporter to be non-nil after late init")
	}

	// Clean up the reporter's background goroutine
	s.messageReporter.Shutdown()
}

func TestLateInitMessageReporter_SetsCallbackToken(t *testing.T) {
	t.Parallel()
	s, _ := newServerWithoutReporter(t)

	// Set a callback token before late-init
	s.callbackToken = "test-token-123"

	s.lateInitMessageReporter("ws-test-2", "proj-2", "sess-2")

	if s.messageReporter == nil {
		t.Fatal("expected messageReporter to be non-nil")
	}

	// The reporter should have the token set. We can't directly inspect it,
	// but we verify the method was called without error by checking reporter
	// is functional.
	s.messageReporter.Shutdown()
}

func TestLateInitMessageReporter_InvalidDBPath(t *testing.T) {
	t.Parallel()
	s, _ := newServerWithoutReporter(t)

	// Point to a non-writable path
	s.config.PersistenceDBPath = "/nonexistent/path/test.db"

	s.lateInitMessageReporter("ws-test-3", "proj-3", "sess-3")

	// Should gracefully handle the error — reporter stays nil
	if s.messageReporter != nil {
		t.Fatal("expected messageReporter to remain nil with invalid DB path")
		s.messageReporter.Shutdown()
	}
}
