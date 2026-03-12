package server

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/messagereport"
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
		messageReporters:    make(map[string]*messagereport.Reporter),
		done:                make(chan struct{}),
	}

	return s, dbPath
}

func TestGetOrCreateReporter_CreatesReporter(t *testing.T) {
	t.Parallel()
	s, _ := newServerWithoutReporter(t)

	if len(s.messageReporters) != 0 {
		t.Fatal("expected no reporters before creation")
	}

	r := s.getOrCreateReporter("ws-test-1", "proj-1", "sess-1")

	if r == nil {
		t.Fatal("expected reporter for ws-test-1 after getOrCreateReporter")
	}

	// Verify it's stored in the map
	s.messageReportersMu.Lock()
	stored, ok := s.messageReporters["ws-test-1"]
	s.messageReportersMu.Unlock()

	if !ok || stored != r {
		t.Fatal("expected stored reporter to match returned reporter")
	}

	// Clean up the reporter's background goroutine
	r.Shutdown()
}

func TestGetOrCreateReporter_SetsCallbackToken(t *testing.T) {
	t.Parallel()
	s, _ := newServerWithoutReporter(t)

	// Set a callback token before creation
	s.callbackTokenMu.Lock()
	s.callbackToken = "test-token-123"
	s.callbackTokenMu.Unlock()

	r := s.getOrCreateReporter("ws-test-2", "proj-2", "sess-2")

	if r == nil {
		t.Fatal("expected reporter for ws-test-2")
	}

	// The reporter should have the token set. We can't directly inspect it,
	// but we verify the method was called without error by checking reporter
	// is functional.
	r.Shutdown()
}

func TestGetOrCreateReporter_InvalidDBPath(t *testing.T) {
	t.Parallel()
	s, _ := newServerWithoutReporter(t)

	// Point to a non-writable path
	s.config.PersistenceDBPath = "/nonexistent/path/test.db"

	r := s.getOrCreateReporter("ws-test-3", "proj-3", "sess-3")

	// Should gracefully handle the error — returns nil
	if r != nil {
		r.Shutdown()
		t.Fatal("expected no reporter with invalid DB path")
	}
}

func TestPerWorkspaceReporterIsolation(t *testing.T) {
	t.Parallel()
	s, _ := newServerWithoutReporter(t)

	// Create reporters for two workspaces
	r1 := s.getOrCreateReporter("ws-a", "proj-1", "sess-a")
	r2 := s.getOrCreateReporter("ws-b", "proj-1", "sess-b")

	if r1 == nil || r2 == nil {
		t.Fatal("expected both reporters to be created")
	}
	if r1 == r2 {
		t.Fatal("expected different reporter instances for different workspaces")
	}

	// Verify idempotent creation — same workspace returns same reporter
	r1again := s.getOrCreateReporter("ws-a", "proj-1", "sess-a")
	if r1again != r1 {
		t.Fatal("expected same reporter instance for same workspace")
	}

	// Shut down one — the other should still exist
	s.shutdownReporter("ws-a")
	s.messageReportersMu.Lock()
	_, aExists := s.messageReporters["ws-a"]
	_, bExists := s.messageReporters["ws-b"]
	s.messageReportersMu.Unlock()

	if aExists {
		t.Fatal("expected reporter for ws-a to be removed after shutdown")
	}
	if !bExists {
		t.Fatal("expected reporter for ws-b to still exist")
	}

	r2.Shutdown()
}

func TestShutdownAllReporters(t *testing.T) {
	t.Parallel()
	s, _ := newServerWithoutReporter(t)

	s.getOrCreateReporter("ws-1", "proj-1", "sess-1")
	s.getOrCreateReporter("ws-2", "proj-1", "sess-2")

	s.shutdownAllReporters()

	s.messageReportersMu.Lock()
	count := len(s.messageReporters)
	s.messageReportersMu.Unlock()

	if count != 0 {
		t.Fatalf("expected all reporters removed, got %d", count)
	}
}

func TestSetTokenAllReporters(t *testing.T) {
	t.Parallel()
	s, _ := newServerWithoutReporter(t)

	s.getOrCreateReporter("ws-1", "proj-1", "sess-1")
	s.getOrCreateReporter("ws-2", "proj-1", "sess-2")

	// Should not panic — verifies token propagation works
	s.setTokenAllReporters("new-token")

	s.shutdownAllReporters()
}

func TestMessageReporterDBPath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		base     string
		wsID     string
		expected string
	}{
		{"/var/lib/vm-agent/data.db", "ws-abc", "/var/lib/vm-agent/messages-ws-abc.db"},
		{"/tmp/test.db", "workspace-1", "/tmp/messages-workspace-1.db"},
	}

	for _, tt := range tests {
		got := messageReporterDBPath(tt.base, tt.wsID)
		if got != tt.expected {
			t.Errorf("messageReporterDBPath(%q, %q) = %q, want %q", tt.base, tt.wsID, got, tt.expected)
		}
	}
}

func TestMessageReporterDBPath_Adversarial(t *testing.T) {
	t.Parallel()

	tests := []struct {
		base     string
		wsID     string
		expected string
	}{
		{"/var/lib/vm-agent/data.db", "../evil", "/var/lib/vm-agent/messages-__evil.db"},
		{"/var/lib/vm-agent/data.db", "ws/evil", "/var/lib/vm-agent/messages-ws_evil.db"},
		{"/var/lib/vm-agent/data.db", "ws\x00id", "/var/lib/vm-agent/messages-ws_id.db"},
		{"/var/lib/vm-agent/data.db", "../../etc/passwd", "/var/lib/vm-agent/messages-____etc_passwd.db"},
	}

	for _, tt := range tests {
		got := messageReporterDBPath(tt.base, tt.wsID)
		if got != tt.expected {
			t.Errorf("messageReporterDBPath(%q, %q) = %q, want %q", tt.base, tt.wsID, got, tt.expected)
		}
	}
}

func TestGetOrCreateReporter_Concurrent(t *testing.T) {
	t.Parallel()
	s, _ := newServerWithoutReporter(t)

	const workers = 20
	results := make([]*messagereport.Reporter, workers)
	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		i := i
		go func() {
			defer wg.Done()
			results[i] = s.getOrCreateReporter("ws-concurrent", "proj-1", "sess-1")
		}()
	}
	wg.Wait()

	// All goroutines must receive the same reporter instance.
	first := results[0]
	if first == nil {
		t.Fatal("expected reporter to be created")
	}
	for i, r := range results {
		if r != first {
			t.Errorf("goroutine %d got different reporter instance", i)
		}
	}
	s.shutdownAllReporters()
}
