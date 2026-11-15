package messagereport

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// TestArchiveReporterFixture is the Go half of the archive profile vertical
// slice: actual HTTP messages emitted by Reporter, consumed by the real-workerd
// persistMessageBatch test. No direct outbox INSERTs or sender mocks.
// Regenerate with UPDATE_ARCHIVE_REPORTER_FIXTURE=1 go test
// ./internal/messagereport -run '^TestArchiveReporterFixture$'.
func TestArchiveReporterFixture(t *testing.T) {
	reporter, capture := newArchiveFixtureReporter(t)
	expected, contentBytes := enqueueArchiveFixture(t, reporter)
	// Reporter batches HTTP transport but preserves consecutive assistant chunks.
	reporter.flush()
	assertOutboxCount(t, reporter.db, 0, "after complete archive fixture flush")
	if capture.requests != 42 {
		t.Fatalf("got %d HTTP batches, want 42", capture.requests)
	}
	if !reflect.DeepEqual(capture.messages, expected) {
		t.Fatal("HTTP reporter changed content, metadata, IDs, timestamps or sequence")
	}
	assertArchiveFixtureJSON(t, capture.messages)
	assertArchiveFixtureReplay(t, reporter, capture, expected[0])
	t.Logf("raw_rows=%d content_bytes=%d average_content_bytes=%.4f hypothetical_assistant_coalesced_rows=420 saved_rows=1680 saved_percent=80", len(expected), contentBytes, float64(contentBytes)/float64(len(expected)))
}

// Flush is driven synchronously; the production timer is delayed for this fixture.
// HTTP response completion precedes each inspection of the captured payload.
type archiveFixtureCapture struct {
	t        *testing.T
	messages []apiMessage
	requests int
}

func (capture *archiveFixtureCapture) serveHTTP(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost || req.URL.Path != "/api/workspaces/archive-profile-workspace/messages" {
		capture.t.Errorf("unexpected request: %s %s", req.Method, req.URL.Path)
	}
	if req.Header.Get("Authorization") != "Bearer archive-profile-test-token" {
		capture.t.Error("missing reporter authorization")
	}
	var payload struct {
		Messages []apiMessage `json:"messages"`
	}
	if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
		capture.t.Error(err)
		w.WriteHeader(400)
		return
	}
	if len(payload.Messages) > 50 {
		capture.t.Errorf("batch exceeded production row ceiling: %d", len(payload.Messages))
	}
	capture.requests++
	capture.messages = append(capture.messages, payload.Messages...)
	writePersistedCount(w, len(payload.Messages))
}

func newArchiveFixtureReporter(t *testing.T) (*Reporter, *archiveFixtureCapture) {
	t.Helper()
	capture := &archiveFixtureCapture{t: t}
	server := httptest.NewServer(http.HandlerFunc(capture.serveHTTP))
	t.Cleanup(server.Close)
	cfg := DefaultConfig()
	cfg.Endpoint, cfg.WorkspaceID = server.URL, "archive-profile-workspace"
	cfg.ProjectID, cfg.SessionID = "archive-profile-project", "archive-profile-session"
	cfg.BatchMaxWait = time.Hour
	reporter, err := New(openTestDB(t), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reporter.Shutdown)
	reporter.SetToken("archive-profile-test-token")
	return reporter, capture
}

func enqueueArchiveFixture(t *testing.T, reporter *Reporter) ([]apiMessage, int) {
	t.Helper()
	expected := make([]apiMessage, 0, 2100)
	contentBytes := 0
	for index := 0; index < 2100; index++ {
		position := index % 20
		msg := Message{MessageID: fmt.Sprintf("profile-%05d", index), Role: "assistant",
			Content:   fmt.Sprintf("Archive measurement stream chunk %d: inspect the workspace and verify the transcript. ", index),
			Timestamp: time.UnixMilli(1_000_000 + int64(index/3)*1000).UTC().Format("2006-01-02T15:04:05.000Z")}
		if position == 0 {
			msg.Role, msg.Content = "user", fmt.Sprintf("Please inspect workspace turn %d", index/20)
		} else if position >= 18 {
			msg.Role, msg.Content = "tool", fmt.Sprintf("Read workspace file %d", index)
			msg.ToolMetadata = fmt.Sprintf(`{"title":"Read file","content":[{"type":"text","text":"Tool result %d"}]}`, index)
		}
		if err := reporter.Enqueue(msg); err != nil {
			t.Fatal(err)
		}
		msg.SessionID = reporter.cfg.SessionID
		expected = append(expected, msg.toAPIMessage(int64(index+1)))
		contentBytes += len(msg.Content)
	}
	return expected, contentBytes
}

func assertArchiveFixtureJSON(t *testing.T, received []apiMessage) {
	t.Helper()
	fixture, err := json.MarshalIndent(received, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	fixture = append(fixture, '\n')
	fixturePath := filepath.Join("..", "..", "..", "..", "apps", "api", "tests", "workers", "fixtures", "archive-reporter-messages.json")
	if os.Getenv("UPDATE_ARCHIVE_REPORTER_FIXTURE") == "1" {
		if err := os.MkdirAll(filepath.Dir(fixturePath), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fixturePath, fixture, 0644); err != nil {
			t.Fatal(err)
		}
	}
	checkedIn, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(checkedIn, fixture) {
		t.Fatal("checked-in workerd fixture differs from real Reporter HTTP output; regenerate explicitly")
	}
}

func assertArchiveFixtureReplay(t *testing.T, reporter *Reporter, capture *archiveFixtureCapture, first apiMessage) {
	t.Helper()
	// A queued duplicate is ignored locally. Once delivery removes it from the
	// outbox, replay is transmitted again with a new sequence and the same ID;
	// the receiving persistMessageBatch path owns durable ID deduplication.
	replay := Message{MessageID: first.MessageID, Role: first.Role,
		Content: first.Content, Timestamp: first.Timestamp}
	for range 2 {
		if err := reporter.Enqueue(replay); err != nil {
			t.Fatal(err)
		}
	}
	assertOutboxCount(t, reporter.db, 1, "queued duplicate")
	reporter.flush()
	if len(capture.messages) != 2101 || capture.messages[2100].MessageID != replay.MessageID || capture.messages[2100].Sequence != 2101 {
		t.Fatal("queued duplicate was not deduplicated, or replay identity was lost")
	}
	if err := reporter.Enqueue(replay); err != nil {
		t.Fatal(err)
	}
	reporter.flush()
	if len(capture.messages) != 2102 || capture.messages[2101].MessageID != replay.MessageID || capture.messages[2101].Sequence <= capture.messages[2100].Sequence {
		t.Fatal("post-delivery replay must preserve ID and advance sequence for API deduplication")
	}
}
