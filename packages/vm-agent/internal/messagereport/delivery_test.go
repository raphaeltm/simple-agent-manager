package messagereport

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeControlPlane enforces what POST /api/workspaces/:id/messages enforces,
// in the order the Worker checks it: the request-body limit, one session per
// batch, the session the workspace is linked to, and the per-message content
// limit. Messages for a declined session are answered 204, as the Worker does
// once a workspace or chat session stops accepting writes.
type fakeControlPlane struct {
	t                *testing.T
	payloadLimit     int
	contentLimit     int
	linkedSession    string
	declinedSessions map[string]bool

	mu           sync.Mutex
	requestBytes []int
	requests     [][]apiMessage
	persisted    []apiMessage
}

func newFakeControlPlane(t *testing.T, linkedSession string) (*fakeControlPlane, *httptest.Server) {
	t.Helper()
	cp := &fakeControlPlane{
		t:                t,
		payloadLimit:     256 * 1024,
		contentLimit:     100 * 1024,
		linkedSession:    linkedSession,
		declinedSessions: map[string]bool{},
	}
	server := httptest.NewServer(cp)
	t.Cleanup(server.Close)
	return cp, server
}

func (cp *fakeControlPlane) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	var payload struct {
		Messages []apiMessage `json:"messages"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		cp.t.Errorf("unmarshal request: %v", err)
		return
	}
	cp.mu.Lock()
	defer cp.mu.Unlock()
	cp.requestBytes = append(cp.requestBytes, len(body))
	cp.requests = append(cp.requests, payload.Messages)

	reject := func(message string) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = fmt.Fprintf(w, `{"error":"BAD_REQUEST","message":%q}`, message)
	}
	if len(body) > cp.payloadLimit {
		reject(fmt.Sprintf("Payload exceeds %d byte limit", cp.payloadLimit))
		return
	}
	session := payload.Messages[0].SessionID
	for _, msg := range payload.Messages {
		if msg.SessionID != session {
			reject("All messages in a batch must target the same sessionId")
			return
		}
	}
	if cp.declinedSessions[session] {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if session != cp.linkedSession {
		reject(fmt.Sprintf("Session mismatch: workspace is linked to session %s", cp.linkedSession))
		return
	}
	for _, msg := range payload.Messages {
		if len(msg.Content) > cp.contentLimit {
			reject(fmt.Sprintf("Individual message content exceeds %d byte limit", cp.contentLimit))
			return
		}
	}
	cp.persisted = append(cp.persisted, payload.Messages...)
	writePersistedCount(w, len(payload.Messages))
}

// seen is a copy of what the control plane has received so far.
type seen struct {
	requestBytes []int
	requests     [][]apiMessage
	persisted    []apiMessage
}

func (cp *fakeControlPlane) seen() seen {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return seen{
		requestBytes: append([]int(nil), cp.requestBytes...),
		requests:     append([][]apiMessage(nil), cp.requests...),
		persisted:    append([]apiMessage(nil), cp.persisted...),
	}
}

func (s seen) persistedIDs() string {
	ids := make([]string, 0, len(s.persisted))
	for _, msg := range s.persisted {
		ids = append(ids, msg.MessageID)
	}
	return strings.Join(ids, ",")
}

// productionShapedReporter uses the reporter's shipped limits, which match the
// control plane's, and never flushes on its own: tests flush explicitly.
func productionShapedReporter(t *testing.T, endpoint string) (*sql.DB, *Reporter) {
	t.Helper()
	db := openTestDB(t)
	cfg := testConfig(endpoint, "ws-1")
	defaults := DefaultConfig()
	cfg.BatchMaxBytes = defaults.BatchMaxBytes
	cfg.MaxMessageContentBytes = defaults.MaxMessageContentBytes
	cfg.BatchMaxWait = time.Hour
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	r.SetToken("test-token")
	t.Cleanup(r.Shutdown)
	return db, r
}

func enqueue(t *testing.T, r *Reporter, msg Message) {
	t.Helper()
	if msg.Timestamp == "" {
		msg.Timestamp = "2026-09-25T10:00:00Z"
	}
	if err := r.Enqueue(msg); err != nil {
		t.Fatalf("enqueue %s: %v", msg.MessageID, err)
	}
}

func TestDelivery_ToolMessageWithOversizedMetadataArrivesInOneRequest(t *testing.T) {
	cp, server := newFakeControlPlane(t, "sess-1")
	db, r := productionShapedReporter(t, server.URL)
	raw := toolMetadataJSON(t, "cat build.log", 400*1024)

	enqueue(t, r, Message{MessageID: "tool-1", Role: "tool", Content: "build output", ToolMetadata: raw})
	r.flush()

	got := cp.seen()
	if len(got.requests) != 1 {
		t.Fatalf("expected one request, got %d (sizes %v)", len(got.requests), got.requestBytes)
	}
	if got.persistedIDs() != "tool-1" {
		t.Fatalf("persisted %q, want tool-1", got.persistedIDs())
	}
	delivered := got.persisted[0]
	if delivered.Content != "build output" {
		t.Fatalf("content = %q, want it delivered whole", delivered.Content)
	}
	summary := decodeSummary(t, delivered.ToolMetadata)
	if summary.ToolCallID != "call-7" || summary.Title != "cat build.log" || !summary.ContentTruncated || summary.OriginalSizeBytes != len(raw) {
		t.Fatalf("tool metadata summary = %+v", summary)
	}
	assertOutboxCount(t, db, 0, "outbox after delivery")
}

func TestDelivery_ManyLargeMessagesAreSplitAcrossRequestsWithoutLoss(t *testing.T) {
	cp, server := newFakeControlPlane(t, "sess-1")
	db, r := productionShapedReporter(t, server.URL)
	var want []string
	for i := 0; i < 12; i++ {
		id := fmt.Sprintf("chunk-%02d", i)
		want = append(want, id)
		enqueue(t, r, Message{MessageID: id, Role: "assistant", Content: strings.Repeat("a", 60*1024)})
	}

	r.flush()

	got := cp.seen()
	if got.persistedIDs() != strings.Join(want, ",") {
		t.Fatalf("persisted %q, want %q", got.persistedIDs(), strings.Join(want, ","))
	}
	for _, size := range got.requestBytes {
		if size > cp.payloadLimit {
			t.Fatalf("sent a %d-byte request over the %d-byte limit", size, cp.payloadLimit)
		}
	}
	if len(got.requests) < 3 {
		t.Fatalf("720 KiB fit in %d requests under a 256 KiB limit", len(got.requests))
	}
	assertOutboxCount(t, db, 0, "outbox after delivery")
}

func TestDelivery_LeftoverRowsOfAnEarlierSessionDoNotSinkTheCurrentSession(t *testing.T) {
	cp, server := newFakeControlPlane(t, "sess-1")
	db, r := productionShapedReporter(t, server.URL)
	// A row the outbox still holds from the session the workspace ran before.
	if _, err := db.Exec(
		`INSERT INTO message_outbox (message_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
		"earlier-1", "sess-0", "assistant", "from the earlier session", "2026-09-25T09:59:59Z",
	); err != nil {
		t.Fatalf("seed earlier session row: %v", err)
	}
	enqueue(t, r, Message{MessageID: "current-1", Role: "assistant", Content: "first"})
	enqueue(t, r, Message{MessageID: "current-2", Role: "assistant", Content: "second"})

	r.flush()

	got := cp.seen()
	if got.persistedIDs() != "current-1,current-2" {
		t.Fatalf("persisted %q, want the current session's messages", got.persistedIDs())
	}
	for _, request := range got.requests {
		for _, msg := range request {
			if msg.SessionID != request[0].SessionID {
				t.Fatalf("a request mixed sessions: %+v", request)
			}
		}
	}
	assertOutboxCount(t, db, 0, "outbox after delivery")
}

func TestDelivery_DeclinedBatchIsDiscardedOnceAndTheReporterKeepsDelivering(t *testing.T) {
	cp, server := newFakeControlPlane(t, "sess-2")
	cp.declinedSessions["sess-1"] = true
	db, r := productionShapedReporter(t, server.URL)

	enqueue(t, r, Message{MessageID: "stopped-session", Role: "assistant", Content: "late output"})
	r.flush()
	r.flush()

	if sent := len(cp.seen().requests); sent != 1 {
		t.Fatalf("declined batch was sent %d times, want once", sent)
	}
	assertOutboxCount(t, db, 0, "outbox after a declined batch")

	r.SetSessionID("sess-2")
	enqueue(t, r, Message{MessageID: "next-session", Role: "assistant", Content: "new work"})
	r.flush()

	if got := cp.seen().persistedIDs(); got != "next-session" {
		t.Fatalf("persisted %q, want the next session's message", got)
	}
}
