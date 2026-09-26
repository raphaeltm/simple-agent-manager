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

// acceptedRoles are the message roles the control plane accepts.
var acceptedRoles = map[string]bool{
	"user": true, "assistant": true, "system": true, "tool": true, "thinking": true, "plan": true,
}

// fakeControlPlane enforces what POST /api/workspaces/:id/messages enforces, in
// the order the Worker checks it (apps/api/src/routes/workspaces/runtime.ts):
// the request-body limit; each message's role and content limit, and one
// session per batch; the session the workspace is linked to; and last,
// ProjectData declining a session that no longer accepts writes, which the
// Worker answers with 204. Its limits start at the Worker's defaults, which the
// reporter's defaults mirror.
type fakeControlPlane struct {
	t                *testing.T
	payloadLimit     int
	contentLimit     int
	declinedSessions map[string]bool

	mu            sync.Mutex
	linkedSession string
	requestBytes  []int
	requests      [][]apiMessage
	persisted     []apiMessage
}

func newFakeControlPlane(t *testing.T, linkedSession string) (*fakeControlPlane, *httptest.Server) {
	t.Helper()
	defaults := DefaultConfig()
	cp := &fakeControlPlane{
		t:                t,
		payloadLimit:     defaults.BatchMaxBytes,
		contentLimit:     defaults.MaxMessageContentBytes,
		declinedSessions: map[string]bool{},
		linkedSession:    linkedSession,
	}
	server := httptest.NewServer(cp)
	t.Cleanup(server.Close)
	return cp, server
}

// link points the workspace at session, as the control plane does when a
// workspace is reused for another chat.
func (cp *fakeControlPlane) link(session string) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	cp.linkedSession = session
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
		if !acceptedRoles[msg.Role] {
			reject(fmt.Sprintf("Invalid role %q", msg.Role))
			return
		}
		// Counted in bytes, never fewer than the UTF-16 units the Worker counts.
		if len(msg.Content) > cp.contentLimit {
			reject(fmt.Sprintf("Individual message content exceeds %d byte limit", cp.contentLimit))
			return
		}
		if msg.SessionID != session {
			reject("All messages in a batch must target the same sessionId")
			return
		}
	}
	if session != cp.linkedSession {
		reject(fmt.Sprintf("Session mismatch: workspace is linked to session %s, but messages target session %s", cp.linkedSession, session))
		return
	}
	if cp.declinedSessions[session] {
		w.WriteHeader(http.StatusNoContent)
		return
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
	// Four 60 KiB messages fit one 256 KiB request and five do not.
	if len(got.requests) != 3 {
		t.Fatalf("sent twelve 60 KiB messages in %d requests, want 3", len(got.requests))
	}
	assertOutboxCount(t, db, 0, "outbox after delivery")
}

func TestDelivery_LeftoverRowsOfAnEarlierSessionAreSettledWithoutSinkingTheCurrentSession(t *testing.T) {
	cp, server := newFakeControlPlane(t, "sess-1")
	db, r := productionShapedReporter(t, server.URL)
	// Rows the outbox still holds from the session the workspace ran before,
	// as after a restart that found the workspace linked to a new session.
	for i := 0; i < 3; i++ {
		if _, err := db.Exec(
			`INSERT INTO message_outbox (message_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
			fmt.Sprintf("earlier-%d", i), "sess-0", "assistant", "from the earlier session", "2026-09-25T09:59:59Z",
		); err != nil {
			t.Fatalf("seed earlier session row: %v", err)
		}
	}
	enqueue(t, r, Message{MessageID: "current-1", Role: "assistant", Content: "first"})
	enqueue(t, r, Message{MessageID: "current-2", Role: "assistant", Content: "second"})

	r.flush()

	got := cp.seen()
	if got.persistedIDs() != "current-1,current-2" {
		t.Fatalf("persisted %q, want the current session's messages", got.persistedIDs())
	}
	// One refused request settles the earlier session, one delivers the current.
	if len(got.requests) != 2 {
		t.Fatalf("sent %d requests, want 2", len(got.requests))
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

func TestDelivery_ADeclinedSessionIsSettledInOneRequestAndTheReporterKeepsDelivering(t *testing.T) {
	cp, server := newFakeControlPlane(t, "sess-1")
	cp.declinedSessions["sess-1"] = true
	db, r := productionShapedReporter(t, server.URL)
	// Five 90 KiB messages take three requests to deliver.
	for i := 0; i < 5; i++ {
		enqueue(t, r, Message{MessageID: fmt.Sprintf("late-%d", i), Role: "assistant", Content: strings.Repeat("a", 90*1024)})
	}

	r.flush()
	r.flush()

	if sent := len(cp.seen().requests); sent != 1 {
		t.Fatalf("the declined session took %d requests to settle, want 1", sent)
	}
	assertOutboxCount(t, db, 0, "outbox after the session was declined")

	cp.link("sess-2")
	r.SetSessionID("sess-2")
	enqueue(t, r, Message{MessageID: "next-session", Role: "assistant", Content: "new work"})
	r.flush()

	if got := cp.seen().persistedIDs(); got != "next-session" {
		t.Fatalf("persisted %q, want the next session's message", got)
	}
}

func TestDelivery_ASessionDeclinedWhileRowsAreSentOneByOneIsSettledAtOnce(t *testing.T) {
	cp, server := newFakeControlPlane(t, "sess-1")
	// A control plane configured below the reporter's limits rejects its
	// batches, so their rows are sent one by one.
	cp.payloadLimit = 150 * 1024
	cp.declinedSessions["sess-1"] = true
	db, r := productionShapedReporter(t, server.URL)
	for i := 0; i < 5; i++ {
		enqueue(t, r, Message{MessageID: fmt.Sprintf("late-%d", i), Role: "assistant", Content: strings.Repeat("a", 90*1024)})
	}

	r.flush()

	got := cp.seen()
	if len(got.requests) != 2 || len(got.requests[1]) != 1 {
		t.Fatalf("sent %d requests (sizes %v), want the rejected batch and then one row on its own", len(got.requests), got.requestBytes)
	}
	assertOutboxCount(t, db, 0, "outbox after the session was declined")
}

func TestDelivery_ARowTheControlPlaneRefusesDoesNotSinkItsBatch(t *testing.T) {
	cp, server := newFakeControlPlane(t, "sess-1")
	db, r := productionShapedReporter(t, server.URL)
	enqueue(t, r, Message{MessageID: "before", Role: "assistant", Content: "first"})
	// A role this control plane does not accept yet, as from a newer agent.
	enqueue(t, r, Message{MessageID: "refused", Role: "narration", Content: "second"})
	enqueue(t, r, Message{MessageID: "after", Role: "assistant", Content: "third"})

	r.flush()

	if got := cp.seen().persistedIDs(); got != "before,after" {
		t.Fatalf("persisted %q, want every message but the refused one", got)
	}
	assertOutboxCount(t, db, 0, "outbox after delivery")
}

func TestDelivery_ARowTooLargeInEveryFormIsDroppedInsteadOfBlockingTheOutbox(t *testing.T) {
	cp, server := newFakeControlPlane(t, "sess-1")
	db, r := productionShapedReporter(t, server.URL)
	small := Message{MessageID: "before", SessionID: "sess-1", Role: "assistant", Content: "first", Timestamp: "2026-09-25T10:00:00Z"}
	big := Message{MessageID: "big", SessionID: "sess-1", Role: "tool", Content: strings.Repeat("o", 4096), ToolMetadata: toolMetadataJSON(t, "cat build.log", 4096), Timestamp: "2026-09-25T10:00:00Z"}
	// A control plane configured so small that the big message's omitted form
	// does not fit, while the small messages still do.
	cp.payloadLimit = (requestBytes(small) + requestBytes(omittedForTransport(big))) / 2
	enqueue(t, r, small)
	enqueue(t, r, big)
	enqueue(t, r, Message{MessageID: "after", Role: "assistant", Content: "third"})

	r.flush()

	if got := cp.seen().persistedIDs(); got != "before,after" {
		t.Fatalf("persisted %q, want every message but the one too large to send", got)
	}
	assertOutboxCount(t, db, 0, "outbox after delivery")
}
