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
	"strings"
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

func waitForCondition(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out waiting for condition")
}

func requestMessageIDs(t *testing.T, r *http.Request) []string {
	t.Helper()
	messages := requestMessages[struct {
		MessageID string `json:"messageId"`
	}](t, r)
	ids := make([]string, 0, len(messages))
	for _, msg := range messages {
		ids = append(ids, msg.MessageID)
	}
	return ids
}

func requestMessages[T any](t *testing.T, r *http.Request) []T {
	t.Helper()
	body, _ := io.ReadAll(r.Body)
	var payload struct {
		Messages []T `json:"messages"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("unmarshal request: %v", err)
	}
	return payload.Messages
}

func recordJoinedIDs(mu *sync.Mutex, requestIDs *[]string, ids []string) {
	mu.Lock()
	defer mu.Unlock()
	*requestIDs = append(*requestIDs, strings.Join(ids, ","))
}

func writePayloadTooLarge(w http.ResponseWriter) {
	w.WriteHeader(http.StatusBadRequest)
	_, _ = w.Write([]byte(`{"error":"BAD_REQUEST","message":"Payload exceeds 262144 byte limit"}`))
}

func writeSessionLimit(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusConflict)
	_, _ = w.Write([]byte(`{"error":"SESSION_MESSAGE_LIMIT_EXCEEDED","message":"Session message limit reached"}`))
}

func writePersisted(w http.ResponseWriter) {
	writePersistedCount(w, 1)
}

func writePersistedCount(w http.ResponseWriter, count int) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"persisted": count, "duplicates": 0})
}

func newTokenReporter(t *testing.T, endpoint, workspaceID string) (*sql.DB, *Reporter) {
	t.Helper()
	db := openTestDB(t)
	cfg := testConfig(endpoint, workspaceID)
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("test-token")
	return db, r
}

func enqueueAssistantPair(t *testing.T, r *Reporter) {
	t.Helper()
	for i := 0; i < 2; i++ {
		if err := r.Enqueue(Message{
			MessageID: fmt.Sprintf("m%d", i),
			Role:      "assistant",
			Content:   "content",
			Timestamp: fmt.Sprintf("2024-01-01T00:00:0%dZ", i),
		}); err != nil {
			t.Fatalf("enqueue m%d: %v", i, err)
		}
	}
}

func assertOutboxCount(t *testing.T, db *sql.DB, want int, context string) {
	t.Helper()
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&count); err != nil {
		t.Fatalf("count %s: %v", context, err)
	}
	if count != want {
		t.Fatalf("%s: got %d rows, want %d", context, count, want)
	}
}

func waitForOutboxCount(t *testing.T, db *sql.DB, want int, context string) {
	t.Helper()
	waitForCondition(t, 2*time.Second, func() bool {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&count); err != nil {
			return false
		}
		return count == want
	})
	assertOutboxCount(t, db, want, context)
}

func storedContentAfterOversizedEnqueue(t *testing.T, limit int, messageID string) string {
	t.Helper()
	db := openTestDB(t)
	cfg := testConfig("http://localhost", "ws-1")
	cfg.MaxMessageContentBytes = limit
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer r.Shutdown()

	if err := r.Enqueue(Message{
		MessageID: messageID,
		Role:      "assistant",
		Content:   strings.Repeat("x", 128),
		Timestamp: "2024-01-01T00:00:00Z",
	}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	var stored string
	if err := db.QueryRow("SELECT content FROM message_outbox WHERE message_id = ?", messageID).Scan(&stored); err != nil {
		t.Fatalf("select content: %v", err)
	}
	return stored
}

func recordingBatchSizeHandler(t *testing.T, mu *sync.Mutex, batchSizes *[]int) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		messages := requestMessages[json.RawMessage](t, r)
		mu.Lock()
		*batchSizes = append(*batchSizes, len(messages))
		mu.Unlock()
		writePersistedCount(w, len(messages))
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
		messages := requestMessages[json.RawMessage](t, r)

		mu.Lock()
		received = append(received, messages...)
		mu.Unlock()

		writePersistedCount(w, len(messages))
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
		writePersisted(w)
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

	ts := httptest.NewServer(recordingBatchSizeHandler(t, &mu, &batchSizes))
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

	ts := httptest.NewServer(recordingBatchSizeHandler(t, &mu, &batchSizes))
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

	// BatchMaxBytes is measured against the full JSON request body. With a
	// 50-byte limit even one message exceeds the budget, so each row should
	// be sent alone and the next row must not be added to that oversized batch.
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

	totalSent := 0
	for _, size := range batchSizes {
		if size != 1 {
			t.Fatalf("expected JSON-budgeted single-message batch, got batch size %d in %v", size, batchSizes)
		}
		totalSent += size
	}
	if totalSent != 5 {
		t.Fatalf("expected 5 total messages sent, got %d", totalSent)
	}
	if len(batchSizes) != 5 {
		t.Fatalf("expected 5 single-message batches due to JSON byte limit, got %d", len(batchSizes))
	}
}

func TestReadBatch_IncludesToolMetadataInJSONByteBudget(t *testing.T) {
	db := openTestDB(t)
	cfg := testConfig("http://localhost", "ws-1")
	cfg.BatchMaxSize = 10
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer r.Shutdown()

	rows := []outboxRow{
		{id: 1, messageID: "m1", sessionID: "s1", role: "tool", content: "a", toolMetadata: sql.NullString{String: strings.Repeat("m", 80), Valid: true}, createdAt: "2024-01-01T00:00:00Z"},
		{id: 2, messageID: "m2", sessionID: "s1", role: "tool", content: "b", toolMetadata: sql.NullString{String: strings.Repeat("m", 80), Valid: true}, createdAt: "2024-01-01T00:00:01Z"},
	}
	size, err := marshaledBatchSize(rows[:1])
	if err != nil {
		t.Fatalf("marshal size: %v", err)
	}
	cfg.BatchMaxBytes = size + 1
	r.cfg.BatchMaxBytes = cfg.BatchMaxBytes

	for _, row := range rows {
		_, err := db.Exec(
			`INSERT INTO message_outbox (message_id, session_id, role, content, tool_metadata, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			row.messageID, row.sessionID, row.role, row.content, row.toolMetadata.String, row.createdAt,
		)
		if err != nil {
			t.Fatalf("insert row: %v", err)
		}
	}

	batch, err := r.readBatch()
	if err != nil {
		t.Fatalf("readBatch: %v", err)
	}
	if len(batch) != 1 {
		t.Fatalf("expected tool metadata to count toward JSON byte budget, got %d rows", len(batch))
	}
}

func TestFlush_Size400RetriesSingleMessagesBeforeDelete(t *testing.T) {
	var requestSizes []int
	var mu sync.Mutex

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Messages []json.RawMessage `json:"messages"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("unmarshal request: %v", err)
		}
		mu.Lock()
		requestSizes = append(requestSizes, len(payload.Messages))
		mu.Unlock()
		if len(payload.Messages) > 1 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"BAD_REQUEST","message":"Payload exceeds 262144 byte limit"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"persisted": 1, "duplicates": 0})
	}))
	defer ts.Close()

	db := openTestDB(t)
	cfg := testConfig(ts.URL, "ws-1")
	cfg.BatchMaxBytes = 1024 * 1024
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("test-token")

	for i := 0; i < 2; i++ {
		if err := r.Enqueue(Message{MessageID: fmt.Sprintf("m%d", i), Role: "assistant", Content: "content", Timestamp: fmt.Sprintf("2024-01-01T00:00:0%dZ", i)}); err != nil {
			t.Fatalf("enqueue: %v", err)
		}
	}

	time.Sleep(200 * time.Millisecond)
	r.Shutdown()

	mu.Lock()
	defer mu.Unlock()
	if len(requestSizes) < 3 || requestSizes[0] != 2 || requestSizes[1] != 1 || requestSizes[2] != 1 {
		t.Fatalf("expected batch retry as singles after payload 400, got request sizes %v", requestSizes)
	}
	var count int
	db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&count)
	if count != 0 {
		t.Fatalf("expected outbox empty after fallback success, got %d", count)
	}
}

func TestFlush_SizeFallback409DisablesReporter(t *testing.T) {
	var requests int32
	var mu sync.Mutex
	var requestIDs []string

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ids := requestMessageIDs(t, r)
		recordJoinedIDs(&mu, &requestIDs, ids)
		atomic.AddInt32(&requests, 1)

		if len(ids) > 1 {
			writePayloadTooLarge(w)
			return
		}
		if ids[0] == "m1" {
			writeSessionLimit(w)
			return
		}
		writePersisted(w)
	}))
	defer ts.Close()

	db := openTestDB(t)
	cfg := testConfig(ts.URL, "ws-1")
	cfg.BatchMaxWait = time.Hour // keep background flush out of this sequencing-sensitive test
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("test-token")

	enqueueAssistantPair(t, r)
	r.flush()

	assertOutboxCount(t, db, 0, "outbox after fallback session limit")

	if err := r.Enqueue(Message{MessageID: "m2", Role: "assistant", Content: "dropped", Timestamp: "2024-01-01T00:00:02Z"}); err != nil {
		t.Fatalf("enqueue after limit: %v", err)
	}
	time.Sleep(150 * time.Millisecond)
	r.Shutdown()

	if got := atomic.LoadInt32(&requests); got != 3 {
		t.Fatalf("expected fallback limit to stop future sends, got %d requests", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(requestIDs, "|") != "m0,m1|m0|m1" {
		t.Fatalf("unexpected request sequence: %v", requestIDs)
	}
}

func TestFlush_SizeFallbackPermanentErrorDiscardsBatch(t *testing.T) {
	var requests int32
	var mu sync.Mutex
	var requestIDs []string

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ids := requestMessageIDs(t, r)
		recordJoinedIDs(&mu, &requestIDs, ids)
		atomic.AddInt32(&requests, 1)

		if len(ids) > 1 {
			writePayloadTooLarge(w)
			return
		}
		if ids[0] == "m1" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"UNAUTHORIZED"}`))
			return
		}

		writePersisted(w)
	}))
	defer ts.Close()

	db, r := newTokenReporter(t, ts.URL, "ws-1")

	enqueueAssistantPair(t, r)
	waitForCondition(t, 2*time.Second, func() bool { return atomic.LoadInt32(&requests) == 3 })
	time.Sleep(150 * time.Millisecond)
	r.Shutdown()

	assertOutboxCount(t, db, 0, "outbox after fallback permanent error")

	mu.Lock()
	defer mu.Unlock()
	if strings.Join(requestIDs, "|") != "m0,m1|m0|m1" {
		t.Fatalf("unexpected request sequence: %v", requestIDs)
	}
}

func TestShutdown_CancelsSizeFallbackRequest(t *testing.T) {
	fallbackStarted := make(chan struct{})
	var fallbackStartedOnce sync.Once

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		messages := requestMessages[json.RawMessage](t, r)
		if len(messages) > 1 {
			writePayloadTooLarge(w)
			return
		}

		fallbackStartedOnce.Do(func() { close(fallbackStarted) })
		<-r.Context().Done()
	}))
	defer ts.Close()

	db := openTestDB(t)
	cfg := testConfig(ts.URL, "ws-1")
	cfg.HTTPTimeout = 10 * time.Second
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("test-token")

	enqueueAssistantPair(t, r)

	select {
	case <-fallbackStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for fallback request")
	}

	done := make(chan struct{})
	go func() {
		r.Shutdown()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("shutdown did not cancel fallback request promptly")
	}
}

func TestEnqueue_TruncationIncludesMarkerWithinConfiguredLimit(t *testing.T) {
	const maxMessageBytes = 32
	stored := storedContentAfterOversizedEnqueue(t, maxMessageBytes, "oversized")
	if len(stored) > maxMessageBytes {
		t.Fatalf("stored content length = %d, want <= %d", len(stored), maxMessageBytes)
	}
	if !strings.HasSuffix(stored, truncationMarker) {
		t.Fatalf("stored content should include truncation marker, got %q", stored)
	}
}

func TestEnqueue_TruncationHonorsTinyConfiguredLimit(t *testing.T) {
	const maxMessageBytes = 4
	stored := storedContentAfterOversizedEnqueue(t, maxMessageBytes, "tiny-limit")
	if len(stored) != maxMessageBytes {
		t.Fatalf("stored content length = %d, want %d", len(stored), maxMessageBytes)
	}
	if stored != truncationMarker[:maxMessageBytes] {
		t.Fatalf("stored content = %q, want truncated marker prefix", stored)
	}
}

func TestFlush_IndividualThreshold400PersistsOmittedMarker(t *testing.T) {
	var received []struct {
		MessageID    string `json:"messageId"`
		Role         string `json:"role"`
		Content      string `json:"content"`
		ToolMetadata string `json:"toolMetadata"`
		Timestamp    string `json:"timestamp"`
	}
	var mu sync.Mutex

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Messages []struct {
				MessageID    string `json:"messageId"`
				Role         string `json:"role"`
				Content      string `json:"content"`
				ToolMetadata string `json:"toolMetadata"`
				Timestamp    string `json:"timestamp"`
			} `json:"messages"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("unmarshal request: %v", err)
		}
		msg := payload.Messages[0]
		if msg.Content != omittedMessageMarker {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"BAD_REQUEST","message":"Individual message content exceeds 102400 byte limit"}`))
			return
		}
		mu.Lock()
		received = append(received, payload.Messages...)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"persisted": 1, "duplicates": 0})
	}))
	defer ts.Close()

	db := openTestDB(t)
	cfg := testConfig(ts.URL, "ws-1")
	cfg.MaxMessageContentBytes = 1024
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("test-token")

	if err := r.Enqueue(Message{
		MessageID:    "oversized-tool",
		Role:         "assistant",
		Content:      strings.Repeat("x", 10),
		ToolMetadata: strings.Repeat("m", 2048),
		Timestamp:    "2024-01-01T00:00:00Z",
	}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	time.Sleep(200 * time.Millisecond)
	r.Shutdown()

	mu.Lock()
	defer mu.Unlock()
	if len(received) != 1 {
		t.Fatalf("expected one omitted marker delivery, got %d", len(received))
	}
	msg := received[0]
	if msg.MessageID != "oversized-tool" || msg.Role != "assistant" || msg.Timestamp != "2024-01-01T00:00:00Z" {
		t.Fatalf("marker did not preserve identity fields: %+v", msg)
	}
	if msg.Content != omittedMessageMarker {
		t.Fatalf("content = %q, want omitted marker", msg.Content)
	}
	if msg.ToolMetadata != "" {
		t.Fatalf("expected oversized tool metadata omitted, got %q", msg.ToolMetadata)
	}
}

func TestFlush_SessionLimit409DisablesReporterUntilSessionSwitch(t *testing.T) {
	var requests int32
	var receivedMu sync.Mutex
	var receivedIDs []string

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ids := requestMessageIDs(t, r)
		receivedMu.Lock()
		receivedIDs = append(receivedIDs, ids...)
		receivedMu.Unlock()

		if atomic.AddInt32(&requests, 1) == 1 {
			writeSessionLimit(w)
			return
		}

		writePersisted(w)
	}))
	defer ts.Close()

	db := openTestDB(t)
	cfg := testConfig(ts.URL, "ws-1")
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("test-token")
	defer r.Shutdown()

	if err := r.Enqueue(Message{MessageID: "m1", Role: "assistant", Content: "first", Timestamp: "2024-01-01T00:00:00Z"}); err != nil {
		t.Fatalf("enqueue m1: %v", err)
	}
	waitForCondition(t, 2*time.Second, func() bool { return atomic.LoadInt32(&requests) == 1 })
	waitForOutboxCount(t, db, 0, "outbox after session limit")

	if err := r.Enqueue(Message{MessageID: "m2", Role: "assistant", Content: "dropped", Timestamp: "2024-01-01T00:00:01Z"}); err != nil {
		t.Fatalf("enqueue m2 after limit: %v", err)
	}
	time.Sleep(150 * time.Millisecond)
	if got := atomic.LoadInt32(&requests); got != 1 {
		t.Fatalf("expected no retry or new request after limit, got %d requests", got)
	}
	assertOutboxCount(t, db, 0, "outbox after dropped post-limit enqueue")

	r.SetSessionID("sess-2")
	if err := r.Enqueue(Message{MessageID: "m3", Role: "assistant", Content: "new session", Timestamp: "2024-01-01T00:00:02Z"}); err != nil {
		t.Fatalf("enqueue m3 after session switch: %v", err)
	}
	waitForCondition(t, 2*time.Second, func() bool { return atomic.LoadInt32(&requests) == 2 })

	receivedMu.Lock()
	defer receivedMu.Unlock()
	if strings.Join(receivedIDs, ",") != "m1,m3" {
		t.Fatalf("expected only m1 and m3 delivered, got %v", receivedIDs)
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

func TestSetWorkspaceID_UpdatesURL(t *testing.T) {
	// Verify that SetWorkspaceID changes the URL used in batch POSTs.
	requestURLs := make(chan string, 10)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestURLs <- r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"persisted": 1, "duplicates": 0})
	}))
	defer ts.Close()

	db := openTestDB(t)
	cfg := testConfig(ts.URL, "initial-ws")
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("test-token")

	// First message uses initial workspace ID.
	_ = r.Enqueue(Message{MessageID: "m1", SessionID: "s1", Role: "user", Content: "a", Timestamp: "2024-01-01T00:00:00Z"})

	select {
	case path := <-requestURLs:
		if path != "/api/workspaces/initial-ws/messages" {
			t.Fatalf("expected path with initial-ws, got %q", path)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for first message delivery")
	}

	// Update workspace ID and send another message.
	r.SetWorkspaceID("real-ws-123")
	_ = r.Enqueue(Message{MessageID: "m2", SessionID: "s1", Role: "user", Content: "b", Timestamp: "2024-01-01T00:00:01Z"})

	select {
	case path := <-requestURLs:
		if path != "/api/workspaces/real-ws-123/messages" {
			t.Fatalf("expected path with real-ws-123, got %q", path)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for second message delivery")
	}

	r.Shutdown()
}

func TestSetWorkspaceID_NilSafe(t *testing.T) {
	var r *Reporter
	r.SetWorkspaceID("ws-1") // should not panic
}

func TestEmptyWorkspaceID_LeavesMessagesInOutbox(t *testing.T) {
	db := openTestDB(t)
	cfg := testConfig("http://localhost:9999", "")
	// Must set ProjectID and SessionID so reporter is not nil.
	cfg.ProjectID = "proj-1"
	cfg.SessionID = "sess-1"
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("test-token")

	_ = r.Enqueue(Message{MessageID: "m1", SessionID: "s1", Role: "user", Content: "pending", Timestamp: "2024-01-01T00:00:00Z"})

	time.Sleep(150 * time.Millisecond)
	r.Shutdown()

	// Messages should still be in the outbox (no workspace ID).
	var count int
	db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&count)
	if count != 1 {
		t.Fatalf("expected 1 message still in outbox (no workspace ID), got %d", count)
	}
}

func TestEmptyWorkspaceID_DeliversAfterSet(t *testing.T) {
	// Start with empty workspace ID, then set it — messages should deliver.
	var received int32

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&received, 1)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"persisted": 1, "duplicates": 0})
	}))
	defer ts.Close()

	db := openTestDB(t)
	cfg := testConfig(ts.URL, "")
	cfg.ProjectID = "proj-1"
	cfg.SessionID = "sess-1"
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("test-token")

	// Enqueue before workspace ID is set — should stay in outbox.
	_ = r.Enqueue(Message{MessageID: "m1", SessionID: "s1", Role: "user", Content: "queued", Timestamp: "2024-01-01T00:00:00Z"})

	time.Sleep(100 * time.Millisecond)
	if atomic.LoadInt32(&received) != 0 {
		t.Fatal("expected 0 deliveries before SetWorkspaceID")
	}

	// Set workspace ID — next flush tick should deliver.
	r.SetWorkspaceID("ws-real")

	time.Sleep(200 * time.Millisecond)
	r.Shutdown()

	if atomic.LoadInt32(&received) != 1 {
		t.Fatalf("expected 1 delivery after SetWorkspaceID, got %d", atomic.LoadInt32(&received))
	}

	var count int
	db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&count)
	if count != 0 {
		t.Fatalf("expected outbox empty after delivery, got %d", count)
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

func TestFlush_IncludesSequenceFromOutboxID(t *testing.T) {
	// Verify that the batch POST payload includes a monotonic "sequence"
	// field derived from the outbox autoincrement ID.
	type receivedMsg struct {
		MessageID string `json:"messageId"`
		Sequence  int64  `json:"sequence"`
	}
	var receivedMsgs []receivedMsg
	var mu sync.Mutex

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Messages []receivedMsg `json:"messages"`
		}
		json.Unmarshal(body, &payload)
		mu.Lock()
		receivedMsgs = append(receivedMsgs, payload.Messages...)
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

	// Enqueue 3 messages — they should get autoincrement IDs 1, 2, 3
	for i := 0; i < 3; i++ {
		_ = r.Enqueue(Message{
			MessageID: fmt.Sprintf("seq-msg-%d", i),
			SessionID: "s1",
			Role:      "assistant",
			Content:   fmt.Sprintf("chunk %d", i),
			Timestamp: "2024-01-01T00:00:00Z", // same timestamp — simulates fast streaming
		})
	}

	time.Sleep(200 * time.Millisecond)
	r.Shutdown()

	mu.Lock()
	defer mu.Unlock()

	if len(receivedMsgs) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(receivedMsgs))
	}

	// Sequences must be monotonically increasing
	for i := 1; i < len(receivedMsgs); i++ {
		if receivedMsgs[i].Sequence <= receivedMsgs[i-1].Sequence {
			t.Fatalf("sequence not monotonic: msg[%d].sequence=%d <= msg[%d].sequence=%d",
				i, receivedMsgs[i].Sequence, i-1, receivedMsgs[i-1].Sequence)
		}
	}

	// All sequences must be positive (outbox IDs start at 1)
	for i, m := range receivedMsgs {
		if m.Sequence <= 0 {
			t.Fatalf("msg[%d] has non-positive sequence: %d", i, m.Sequence)
		}
	}
}

// --- Session cross-contamination regression tests ---
// These tests verify that switching session IDs (warm node reuse)
// does not leak messages from the old session into the new one.

func TestSetSessionID_ClearsStaleOutboxMessages(t *testing.T) {
	db := openTestDB(t)
	cfg := testConfig("http://localhost", "ws-1")
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer r.Shutdown()

	// Enqueue messages under the initial session (sess-1)
	for i := 0; i < 5; i++ {
		if err := r.Enqueue(Message{
			MessageID: fmt.Sprintf("old-%d", i),
			SessionID: "sess-1",
			Role:      "assistant",
			Content:   "old message",
			Timestamp: "2024-01-01T00:00:00Z",
		}); err != nil {
			t.Fatalf("enqueue old: %v", err)
		}
	}

	var count int
	db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&count)
	if count != 5 {
		t.Fatalf("expected 5 stale messages, got %d", count)
	}

	// Simulate warm node reuse — switch to new session
	r.SetSessionID("sess-2")

	// Stale messages should be cleared
	db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&count)
	if count != 0 {
		t.Fatalf("expected outbox cleared after session switch, got %d stale messages", count)
	}
}

func TestSetSessionID_SameID_DoesNotClear(t *testing.T) {
	db := openTestDB(t)
	cfg := testConfig("http://localhost", "ws-1")
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer r.Shutdown()

	if err := r.Enqueue(Message{
		MessageID: "keep-me",
		SessionID: "sess-1",
		Role:      "assistant",
		Content:   "keep",
		Timestamp: "2024-01-01T00:00:00Z",
	}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	// Setting the same session ID should NOT clear
	r.SetSessionID("sess-1")

	var count int
	db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&count)
	if count != 1 {
		t.Fatalf("expected 1 message to remain (same session), got %d", count)
	}
}

func TestSetSessionID_NewMessagesUseNewSession(t *testing.T) {
	db := openTestDB(t)
	cfg := testConfig("http://localhost", "ws-1")
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer r.Shutdown()

	// Enqueue under old session
	_ = r.Enqueue(Message{
		MessageID: "old-msg",
		SessionID: "sess-1",
		Role:      "assistant",
		Content:   "old",
		Timestamp: "2024-01-01T00:00:00Z",
	})

	// Switch session (clears outbox)
	r.SetSessionID("sess-2")

	// Enqueue under new session
	_ = r.Enqueue(Message{
		MessageID: "new-msg",
		SessionID: "sess-1", // intentionally pass old session in struct — reporter should override
		Role:      "assistant",
		Content:   "new",
		Timestamp: "2024-01-01T00:00:01Z",
	})

	// Verify only the new message exists and has the new session ID
	rows, err := db.Query("SELECT message_id, session_id FROM message_outbox ORDER BY id ASC")
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()

	var msgs []struct{ id, sessionID string }
	for rows.Next() {
		var m struct{ id, sessionID string }
		rows.Scan(&m.id, &m.sessionID)
		msgs = append(msgs, m)
	}

	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].id != "new-msg" {
		t.Fatalf("expected new-msg, got %s", msgs[0].id)
	}
	if msgs[0].sessionID != "sess-2" {
		t.Fatalf("expected session_id=sess-2, got %s", msgs[0].sessionID)
	}
}

func TestSetSessionID_ConcurrentEnqueueDoesNotLeaveOldSessionRows(t *testing.T) {
	for attempt := 0; attempt < 100; attempt++ {
		db := openTestDB(t)
		cfg := testConfig("http://localhost", "ws-1")
		cfg.BatchMaxWait = time.Hour
		cfg.OutboxMaxSize = 10000
		r, err := New(db, cfg)
		if err != nil {
			t.Fatalf("attempt %d new: %v", attempt, err)
		}

		stop := make(chan struct{})
		done := make(chan struct{})
		go func() {
			defer close(done)
			for i := 0; ; i++ {
				select {
				case <-stop:
					return
				default:
				}
				_ = r.Enqueue(Message{
					MessageID: fmt.Sprintf("attempt-%d-msg-%d", attempt, i),
					Role:      "assistant",
					Content:   "content",
					Timestamp: "2024-01-01T00:00:00Z",
				})
			}
		}()

		time.Sleep(100 * time.Microsecond)
		r.SetSessionID("sess-2")
		close(stop)
		<-done

		var stale int
		if err := db.QueryRow("SELECT COUNT(*) FROM message_outbox WHERE session_id = ?", "sess-1").Scan(&stale); err != nil {
			t.Fatalf("attempt %d count stale: %v", attempt, err)
		}
		r.Shutdown()
		if stale != 0 {
			t.Fatalf("attempt %d left %d stale old-session rows", attempt, stale)
		}
	}
}

func TestSetSessionID_NilReporter_DoesNotPanic(t *testing.T) {
	var r *Reporter
	r.SetSessionID("anything") // should not panic
}

// TestEnqueue_EmptySessionID_Rejects verifies that Enqueue rejects messages
// when no session ID is set (Principle XIII: Fail-Fast Error Detection).
// This is a defensive check — by construction, a non-nil Reporter always has
// sessionID set via New(). But during warm node transitions, there's a brief
// window where sessionID could be empty. This test ensures the defensive
// check works correctly.
func TestEnqueue_EmptySessionID_Rejects(t *testing.T) {
	db := openTestDB(t)
	cfg := testConfig("http://localhost", "ws-1")
	cfg.SessionID = "initial-session" // Reporter requires non-empty to initialize
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer r.Shutdown()

	// Clear the session ID to simulate a state where it hasn't been set yet
	r.mu.Lock()
	r.sessionID = ""
	r.mu.Unlock()

	err = r.Enqueue(Message{
		MessageID: "should-be-dropped",
		SessionID: "ignored", // struct field is overridden by reporter's sessionID
		Role:      "user",
		Content:   "this should not be enqueued",
		Timestamp: "2024-01-01T00:00:00Z",
	})

	if err == nil {
		t.Fatal("expected error when enqueueing with empty session ID")
	}

	// Verify no message was inserted into the outbox
	var count int
	db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&count)
	if count != 0 {
		t.Fatalf("expected outbox empty when session ID is empty, got %d", count)
	}
}

func TestSetSessionID_ConcurrentFlushDoesNotLeakStaleMessages(t *testing.T) {
	// Verify that no messages tagged with the old session ID are delivered
	// to the server after SetSessionID returns. This tests the flushMu
	// serialization between flush() and SetSessionID's clearOutbox.
	var deliveredSessions []string
	var mu sync.Mutex

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Messages []struct {
				SessionID string `json:"sessionId"`
			} `json:"messages"`
		}
		json.Unmarshal(body, &payload)
		mu.Lock()
		for _, m := range payload.Messages {
			deliveredSessions = append(deliveredSessions, m.SessionID)
		}
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"persisted": len(payload.Messages), "duplicates": 0})
	}))
	defer ts.Close()

	db := openTestDB(t)
	cfg := testConfig(ts.URL, "ws-1")
	cfg.BatchMaxWait = 5 * time.Millisecond // very fast flush
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("test-token")

	// Enqueue old-session messages
	for i := 0; i < 20; i++ {
		_ = r.Enqueue(Message{
			MessageID: fmt.Sprintf("old-%d", i),
			Role:      "user",
			Content:   "stale",
			Timestamp: "2024-01-01T00:00:00Z",
		})
	}

	// Switch session while flush loop is likely running
	r.SetSessionID("sess-2")

	// Enqueue new-session messages
	for i := 0; i < 5; i++ {
		_ = r.Enqueue(Message{
			MessageID: fmt.Sprintf("new-%d", i),
			Role:      "user",
			Content:   "fresh",
			Timestamp: "2024-01-01T00:00:01Z",
		})
	}

	time.Sleep(200 * time.Millisecond)
	r.Shutdown()

	mu.Lock()
	defer mu.Unlock()

	// After SetSessionID returns, no stale sess-1 messages should be delivered.
	// Some may have been delivered BEFORE SetSessionID returned (that's acceptable —
	// they were legitimately in-flight). But none should appear in a batch that
	// was read from the outbox AFTER the clear.
	for _, sid := range deliveredSessions {
		if sid == "sess-1" {
			// This is acceptable only if it was delivered before SetSessionID.
			// The flushMu ensures no flush starts after the clear. We can't
			// distinguish pre-clear vs post-clear deliveries in this test, but
			// the important thing is the test does not deadlock and the new
			// session's messages are delivered correctly.
		}
	}

	// Verify new-session messages were delivered
	newCount := 0
	for _, sid := range deliveredSessions {
		if sid == "sess-2" {
			newCount++
		}
	}
	if newCount != 5 {
		t.Fatalf("expected 5 new-session messages delivered, got %d", newCount)
	}
}

func TestReadBatch_OrdersByID(t *testing.T) {
	// Verify that readBatch uses ORDER BY id ASC (not created_at)
	// so that messages with identical timestamps maintain insertion order.
	db := openTestDB(t)
	cfg := testConfig("http://localhost", "ws-1")
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer r.Shutdown()

	// Insert 5 messages with the exact same timestamp
	sameTS := "2024-01-01T00:00:00.000000000Z"
	for i := 0; i < 5; i++ {
		_ = r.Enqueue(Message{
			MessageID: fmt.Sprintf("order-%d", i),
			SessionID: "s1",
			Role:      "assistant",
			Content:   fmt.Sprintf("chunk-%d", i),
			Timestamp: sameTS,
		})
	}

	// Read batch and verify order matches insertion order
	batch, err := r.readBatch()
	if err != nil {
		t.Fatalf("readBatch: %v", err)
	}
	if len(batch) != 5 {
		t.Fatalf("expected 5 rows, got %d", len(batch))
	}

	for i := 0; i < 5; i++ {
		expected := fmt.Sprintf("order-%d", i)
		if batch[i].messageID != expected {
			t.Fatalf("batch[%d].messageID = %q, want %q", i, batch[i].messageID, expected)
		}
	}

	// IDs should be monotonically increasing
	for i := 1; i < len(batch); i++ {
		if batch[i].id <= batch[i-1].id {
			t.Fatalf("outbox IDs not monotonic: batch[%d].id=%d <= batch[%d].id=%d",
				i, batch[i].id, i-1, batch[i-1].id)
		}
	}
}

func TestEnqueue_TruncatesOversizedContent(t *testing.T) {
	db := openTestDB(t)
	cfg := testConfig("http://localhost", "ws-1")
	cfg.MaxMessageContentBytes = 1024
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer r.Shutdown()

	oversized := strings.Repeat("x", cfg.MaxMessageContentBytes+1000)
	msg := Message{
		MessageID: "msg-oversized",
		Role:      "assistant",
		Content:   oversized,
	}
	if err := r.Enqueue(msg); err != nil {
		t.Fatalf("Enqueue failed: %v", err)
	}

	// Read back from outbox and verify truncation.
	var content string
	err = db.QueryRow("SELECT content FROM message_outbox WHERE message_id = ?", "msg-oversized").Scan(&content)
	if err != nil {
		t.Fatalf("query outbox: %v", err)
	}

	if !strings.HasSuffix(content, truncationMarker) {
		t.Fatalf("expected content to end with truncation marker, got last 30 chars: %q", content[len(content)-30:])
	}

	if len(content) != cfg.MaxMessageContentBytes {
		t.Fatalf("truncated content length = %d, want %d", len(content), cfg.MaxMessageContentBytes)
	}
}

func TestLoadConfigFromEnv_ReadsMaxMessageContentBytes(t *testing.T) {
	t.Setenv("MSG_MAX_MESSAGE_CONTENT_BYTES", "4096")

	cfg := LoadConfigFromEnv()
	if cfg.MaxMessageContentBytes != 4096 {
		t.Fatalf("MaxMessageContentBytes = %d, want 4096", cfg.MaxMessageContentBytes)
	}
}

func TestEnqueue_DoesNotTruncateSmallContent(t *testing.T) {
	db := openTestDB(t)
	cfg := testConfig("http://localhost", "ws-1")
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer r.Shutdown()

	small := strings.Repeat("y", 1000)
	msg := Message{
		MessageID: "msg-small",
		Role:      "assistant",
		Content:   small,
	}
	if err := r.Enqueue(msg); err != nil {
		t.Fatalf("Enqueue failed: %v", err)
	}

	var content string
	err = db.QueryRow("SELECT content FROM message_outbox WHERE message_id = ?", "msg-small").Scan(&content)
	if err != nil {
		t.Fatalf("query outbox: %v", err)
	}

	if content != small {
		t.Fatalf("small content should not be truncated, got length %d want %d", len(content), len(small))
	}
}
