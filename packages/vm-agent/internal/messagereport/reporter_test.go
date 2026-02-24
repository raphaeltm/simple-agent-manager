package messagereport

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// openTestDB creates a temp-file-backed SQLite database for testing.
// Using file-backed DBs avoids issues with :memory: databases being
// scoped to a single connection and not visible across goroutines.
func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?cache=shared&mode=rwc&_journal_mode=WAL", dbPath))
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	// Set WAL and busy timeout for concurrent access in tests.
	db.Exec("PRAGMA journal_mode=WAL")
	db.Exec("PRAGMA busy_timeout=5000")
	t.Cleanup(func() {
		db.Close()
		os.RemoveAll(dir)
	})
	return db
}

func testConfig(endpoint, workspaceID string) Config {
	return Config{
		BatchMaxWait:    50 * time.Millisecond, // fast for tests
		BatchMaxSize:    50,
		BatchMaxBytes:   65536,
		OutboxMaxSize:   100,
		RetryInitial:    10 * time.Millisecond,
		RetryMax:        50 * time.Millisecond,
		RetryMaxElapsed: 200 * time.Millisecond,
		HTTPTimeout:     5 * time.Second,
		Endpoint:        endpoint,
		WorkspaceID:     workspaceID,
		ProjectID:       "proj-1",
		SessionID:       "sess-1",
	}
}

func TestNew_ValidConfig(t *testing.T) {
	db := openTestDB(t)
	cfg := testConfig("http://localhost", "ws-1")
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r == nil {
		t.Fatal("expected non-nil reporter")
	}
	r.Shutdown()

	// Verify outbox table exists.
	var name string
	err = db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='message_outbox'").Scan(&name)
	if err != nil {
		t.Fatalf("outbox table not created: %v", err)
	}
}

func TestNew_NilDB(t *testing.T) {
	cfg := testConfig("http://localhost", "ws-1")
	_, err := New(nil, cfg)
	if err == nil {
		t.Fatal("expected error for nil db")
	}
}

func TestNew_EmptyProjectID(t *testing.T) {
	db := openTestDB(t)
	cfg := testConfig("http://localhost", "ws-1")
	cfg.ProjectID = ""
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r != nil {
		t.Fatal("expected nil reporter when projectID is empty")
	}
}

func TestNew_EmptySessionID(t *testing.T) {
	db := openTestDB(t)
	cfg := testConfig("http://localhost", "ws-1")
	cfg.SessionID = ""
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r != nil {
		t.Fatal("expected nil reporter when sessionID is empty")
	}
}

func TestEnqueue_InsertsMessage(t *testing.T) {
	db := openTestDB(t)
	cfg := testConfig("http://localhost", "ws-1")
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new reporter: %v", err)
	}
	defer r.Shutdown()

	msg := Message{
		MessageID: "msg-1",
		SessionID: "sess-1",
		Role:      "user",
		Content:   "hello",
		Timestamp: "2024-01-01T00:00:00Z",
	}
	if err := r.Enqueue(msg); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected 1 row, got %d", count)
	}

	var role, content string
	if err := db.QueryRow("SELECT role, content FROM message_outbox WHERE message_id = 'msg-1'").Scan(&role, &content); err != nil {
		t.Fatalf("query: %v", err)
	}
	if role != "user" || content != "hello" {
		t.Fatalf("unexpected row: role=%q content=%q", role, content)
	}
}

func TestEnqueue_DuplicateMessageID(t *testing.T) {
	db := openTestDB(t)
	cfg := testConfig("http://localhost", "ws-1")
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer r.Shutdown()

	msg := Message{MessageID: "dup-1", SessionID: "s", Role: "user", Content: "a", Timestamp: "2024-01-01T00:00:00Z"}
	_ = r.Enqueue(msg)
	_ = r.Enqueue(msg) // duplicate — should be silently ignored

	var count int
	db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&count)
	if count != 1 {
		t.Fatalf("expected 1 row after dup insert, got %d", count)
	}
}

func TestFlush_SuccessfulPOST(t *testing.T) {
	var received []json.RawMessage
	var mu sync.Mutex

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Messages []json.RawMessage `json:"messages"`
		}
		json.Unmarshal(body, &payload)

		mu.Lock()
		received = append(received, payload.Messages...)
		mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"persisted": len(payload.Messages), "duplicates": 0})
	}))
	defer ts.Close()

	db := openTestDB(t)
	cfg := testConfig(ts.URL, "ws-1")
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("test-token")

	_ = r.Enqueue(Message{MessageID: "m1", SessionID: "s1", Role: "user", Content: "hello", Timestamp: "2024-01-01T00:00:00Z"})
	_ = r.Enqueue(Message{MessageID: "m2", SessionID: "s1", Role: "assistant", Content: "hi", Timestamp: "2024-01-01T00:00:01Z"})

	// Wait for flush tick.
	time.Sleep(150 * time.Millisecond)
	r.Shutdown()

	mu.Lock()
	defer mu.Unlock()
	if len(received) != 2 {
		t.Fatalf("expected 2 messages received, got %d", len(received))
	}

	// Outbox should be empty after successful send.
	var count int
	db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&count)
	if count != 0 {
		t.Fatalf("expected outbox empty after flush, got %d", count)
	}
}

func TestFlush_TransientError_Retries(t *testing.T) {
	var attempts int32

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&attempts, 1)
		if n <= 2 {
			w.WriteHeader(500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"persisted": 1, "duplicates": 0})
	}))
	defer ts.Close()

	db := openTestDB(t)
	cfg := testConfig(ts.URL, "ws-1")
	cfg.RetryInitial = 5 * time.Millisecond
	cfg.RetryMax = 20 * time.Millisecond
	cfg.RetryMaxElapsed = 2 * time.Second
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("test-token")

	_ = r.Enqueue(Message{MessageID: "m1", SessionID: "s1", Role: "user", Content: "test", Timestamp: "2024-01-01T00:00:00Z"})

	time.Sleep(300 * time.Millisecond)
	r.Shutdown()

	if atomic.LoadInt32(&attempts) < 3 {
		t.Fatalf("expected at least 3 attempts, got %d", atomic.LoadInt32(&attempts))
	}

	var count int
	db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&count)
	if count != 0 {
		t.Fatalf("expected outbox empty after retry success, got %d", count)
	}
}

func TestFlush_PermanentError_Discards(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400) // permanent error
	}))
	defer ts.Close()

	db := openTestDB(t)
	cfg := testConfig(ts.URL, "ws-1")
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("test-token")

	_ = r.Enqueue(Message{MessageID: "m1", SessionID: "s1", Role: "user", Content: "bad", Timestamp: "2024-01-01T00:00:00Z"})

	time.Sleep(150 * time.Millisecond)
	r.Shutdown()

	// Permanent errors should discard the batch.
	var count int
	db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&count)
	if count != 0 {
		t.Fatalf("expected outbox empty after permanent error, got %d", count)
	}
}

func TestOutbox_AtMaxSize_ReturnsError(t *testing.T) {
	db := openTestDB(t)
	cfg := testConfig("http://localhost", "ws-1")
	cfg.OutboxMaxSize = 5
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer r.Shutdown()

	for i := 0; i < 5; i++ {
		if err := r.Enqueue(Message{
			MessageID: fmt.Sprintf("m%d", i),
			SessionID: "s1",
			Role:      "user",
			Content:   "x",
			Timestamp: "2024-01-01T00:00:00Z",
		}); err != nil {
			t.Fatalf("enqueue %d: %v", i, err)
		}
	}

	// 6th should fail.
	err = r.Enqueue(Message{MessageID: "m5", SessionID: "s1", Role: "user", Content: "overflow", Timestamp: "2024-01-01T00:00:00Z"})
	if err == nil {
		t.Fatal("expected error when outbox full")
	}
}

func TestShutdown_FinalFlush(t *testing.T) {
	var received int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Messages []json.RawMessage `json:"messages"`
		}
		json.Unmarshal(body, &payload)
		atomic.AddInt32(&received, int32(len(payload.Messages)))
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"persisted": len(payload.Messages), "duplicates": 0})
	}))
	defer ts.Close()

	db := openTestDB(t)
	cfg := testConfig(ts.URL, "ws-1")
	cfg.BatchMaxWait = 10 * time.Second // very long — flush should only happen on shutdown
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("test-token")

	_ = r.Enqueue(Message{MessageID: "m1", SessionID: "s1", Role: "user", Content: "final", Timestamp: "2024-01-01T00:00:00Z"})

	// Shutdown triggers final flush.
	r.Shutdown()

	if atomic.LoadInt32(&received) != 1 {
		t.Fatalf("expected 1 message flushed on shutdown, got %d", atomic.LoadInt32(&received))
	}
}

func TestNilReporter_NilSafe(t *testing.T) {
	var r *Reporter

	// All methods should be safe on nil receiver.
	r.SetToken("token")
	if err := r.Enqueue(Message{}); err != nil {
		t.Fatalf("nil enqueue should return nil, got %v", err)
	}
	r.Shutdown() // should not panic
}

func TestSetToken_UpdatesAuth(t *testing.T) {
	// Track auth headers per request using a channel for synchronization.
	authHeaders := make(chan string, 10)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeaders <- r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"persisted": 1, "duplicates": 0})
	}))
	defer ts.Close()

	db := openTestDB(t)
	cfg := testConfig(ts.URL, "ws-1")
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("token-v1")

	_ = r.Enqueue(Message{MessageID: "m1", SessionID: "s1", Role: "user", Content: "a", Timestamp: "2024-01-01T00:00:00Z"})

	// Wait for the first flush to deliver the message.
	select {
	case got := <-authHeaders:
		if got != "Bearer token-v1" {
			t.Fatalf("expected 'Bearer token-v1', got %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for first message delivery")
	}

	// Update token and enqueue another message.
	r.SetToken("token-v2")
	_ = r.Enqueue(Message{MessageID: "m2", SessionID: "s1", Role: "user", Content: "b", Timestamp: "2024-01-01T00:00:01Z"})

	select {
	case got := <-authHeaders:
		if got != "Bearer token-v2" {
			t.Fatalf("expected 'Bearer token-v2', got %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for second message delivery")
	}

	r.Shutdown()
}

func TestBatchMaxSize_RespectedInFlush(t *testing.T) {
	var batchSizes []int
	var mu sync.Mutex

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Messages []json.RawMessage `json:"messages"`
		}
		json.Unmarshal(body, &payload)
		mu.Lock()
		batchSizes = append(batchSizes, len(payload.Messages))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"persisted": len(payload.Messages), "duplicates": 0})
	}))
	defer ts.Close()

	db := openTestDB(t)
	cfg := testConfig(ts.URL, "ws-1")
	cfg.BatchMaxSize = 3
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("test-token")

	for i := 0; i < 7; i++ {
		_ = r.Enqueue(Message{
			MessageID: fmt.Sprintf("m%d", i),
			SessionID: "s1",
			Role:      "user",
			Content:   "x",
			Timestamp: fmt.Sprintf("2024-01-01T00:00:%02dZ", i),
		})
	}

	time.Sleep(200 * time.Millisecond)
	r.Shutdown()

	mu.Lock()
	defer mu.Unlock()

	// Should have sent in batches of 3, 3, 1.
	totalSent := 0
	for _, size := range batchSizes {
		if size > 3 {
			t.Fatalf("batch exceeded max size: %d", size)
		}
		totalSent += size
	}
	if totalSent != 7 {
		t.Fatalf("expected 7 total messages sent, got %d", totalSent)
	}
}

func TestBatchMaxBytes_RespectedInFlush(t *testing.T) {
	var batchSizes []int
	var mu sync.Mutex

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Messages []json.RawMessage `json:"messages"`
		}
		json.Unmarshal(body, &payload)
		mu.Lock()
		batchSizes = append(batchSizes, len(payload.Messages))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"persisted": len(payload.Messages), "duplicates": 0})
	}))
	defer ts.Close()

	db := openTestDB(t)
	cfg := testConfig(ts.URL, "ws-1")
	cfg.BatchMaxSize = 100 // high limit
	cfg.BatchMaxBytes = 50 // very small byte limit
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("test-token")

	// Each message content is ~30 bytes, so BatchMaxBytes=50 should yield ~1-2 per batch.
	for i := 0; i < 5; i++ {
		_ = r.Enqueue(Message{
			MessageID: fmt.Sprintf("m%d", i),
			SessionID: "s1",
			Role:      "user",
			Content:   "this is a thirty char message!",
			Timestamp: fmt.Sprintf("2024-01-01T00:00:%02dZ", i),
		})
	}

	time.Sleep(500 * time.Millisecond)
	r.Shutdown()

	mu.Lock()
	defer mu.Unlock()

	// Each batch should have at most 2 messages (first is always included,
	// second may fit if content of first + second <= 50).
	totalSent := 0
	for _, size := range batchSizes {
		totalSent += size
	}
	if totalSent != 5 {
		t.Fatalf("expected 5 total messages sent, got %d", totalSent)
	}
	// There should be multiple batches (at least 3 for 5 messages with ~30 bytes each and 50 byte limit).
	if len(batchSizes) < 2 {
		t.Fatalf("expected multiple batches due to byte limit, got %d", len(batchSizes))
	}
}

func TestConcurrentEnqueue(t *testing.T) {
	db := openTestDB(t)
	cfg := testConfig("http://localhost", "ws-1")
	cfg.OutboxMaxSize = 1000
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer r.Shutdown()

	var wg sync.WaitGroup
	n := 50
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			_ = r.Enqueue(Message{
				MessageID: fmt.Sprintf("concurrent-%d", i),
				SessionID: "s1",
				Role:      "user",
				Content:   "test",
				Timestamp: "2024-01-01T00:00:00Z",
			})
		}(i)
	}
	wg.Wait()

	var count int
	db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&count)
	if count != n {
		t.Fatalf("expected %d rows after concurrent enqueue, got %d", n, count)
	}
}

func TestNoToken_LeavesMessagesInOutbox(t *testing.T) {
	db := openTestDB(t)
	cfg := testConfig("http://localhost:9999", "ws-1") // unreachable endpoint
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	// Do NOT call SetToken — token remains empty.

	_ = r.Enqueue(Message{MessageID: "m1", SessionID: "s1", Role: "user", Content: "pending", Timestamp: "2024-01-01T00:00:00Z"})

	time.Sleep(150 * time.Millisecond)
	r.Shutdown()

	// Messages should still be in the outbox (no token, so no send attempt).
	var count int
	db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&count)
	if count != 1 {
		t.Fatalf("expected 1 message still in outbox (no token), got %d", count)
	}
}

func TestToolMetadata_PersistedAndSent(t *testing.T) {
	var receivedToolMeta string
	var mu sync.Mutex

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Messages []struct {
				ToolMetadata string `json:"toolMetadata"`
			} `json:"messages"`
		}
		json.Unmarshal(body, &payload)
		if len(payload.Messages) > 0 {
			mu.Lock()
			receivedToolMeta = payload.Messages[0].ToolMetadata
			mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"persisted": 1, "duplicates": 0})
	}))
	defer ts.Close()

	db := openTestDB(t)
	cfg := testConfig(ts.URL, "ws-1")
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("test-token")

	_ = r.Enqueue(Message{
		MessageID:    "m1",
		SessionID:    "s1",
		Role:         "tool",
		Content:      "result",
		ToolMetadata: `{"name":"Read","target":"/foo","status":"success"}`,
		Timestamp:    "2024-01-01T00:00:00Z",
	})

	time.Sleep(150 * time.Millisecond)
	r.Shutdown()

	mu.Lock()
	defer mu.Unlock()
	if receivedToolMeta != `{"name":"Read","target":"/foo","status":"success"}` {
		t.Fatalf("unexpected tool metadata: %q", receivedToolMeta)
	}
}

func TestEnqueue_AutoTimestamp(t *testing.T) {
	db := openTestDB(t)
	cfg := testConfig("http://localhost", "ws-1")
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer r.Shutdown()

	_ = r.Enqueue(Message{MessageID: "auto-ts", SessionID: "s1", Role: "user", Content: "x"})

	var createdAt string
	db.QueryRow("SELECT created_at FROM message_outbox WHERE message_id = 'auto-ts'").Scan(&createdAt)
	if createdAt == "" {
		t.Fatal("expected auto-generated timestamp")
	}
	if _, err := time.Parse(time.RFC3339Nano, createdAt); err != nil {
		t.Fatalf("expected RFC3339 timestamp, got %q: %v", createdAt, err)
	}
}
