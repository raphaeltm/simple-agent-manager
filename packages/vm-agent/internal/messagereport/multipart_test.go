package messagereport

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestReporterDeliversOversizedTranscriptWithoutLosingBytes(t *testing.T) {
	const serverBodyLimit = 262144
	const serverContentLimit = 102400
	largeContent := strings.Repeat("é🌊<\\\n", 30000)
	largeMetadata := strings.Repeat("\"metadata🌊\\", 18000)
	var mu sync.Mutex
	accepted := make(map[string]apiMessage)
	var acceptedOrder []string
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			w.WriteHeader(500)
			return
		}
		if len(body) > serverBodyLimit {
			t.Errorf("request is %d bytes", len(body))
			writePayloadTooLarge(w)
			return
		}
		var payload struct {
			Messages []apiMessage `json:"messages"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		for _, message := range payload.Messages {
			if len(message.Content) > serverContentLimit {
				t.Errorf("content exceeds server threshold")
				w.WriteHeader(400)
				return
			}
		}
		mu.Lock()
		requestCount++
		for _, message := range payload.Messages {
			if _, exists := accepted[message.MessageID]; !exists {
				acceptedOrder = append(acceptedOrder, message.MessageID)
				accepted[message.MessageID] = message
			}
		}
		first := requestCount == 1
		mu.Unlock()
		if first {
			w.WriteHeader(500)
			return
		} // persisted but acknowledgement lost
		writePersistedCount(w, len(payload.Messages))
	}))
	defer server.Close()
	db := openTestDB(t)
	cfg := testConfig(server.URL, "ws-1")
	cfg.BatchMaxWait = time.Hour
	cfg.BatchMaxBytes = serverBodyLimit
	cfg.MaxMessageContentBytes = serverContentLimit
	reporter, err := New(db, cfg)
	if err != nil {
		t.Fatal(err)
	}
	reporter.SetToken("token")
	for _, message := range []Message{
		{MessageID: "small-a", Role: "assistant", Content: strings.Repeat("a", 90000), Timestamp: "2024-01-01T00:00:00Z"},
		{MessageID: "small-b", Role: "assistant", Content: strings.Repeat("b", 90000), Timestamp: "2024-01-01T00:00:01Z"},
		{MessageID: "large", Role: "assistant", Content: largeContent, ToolMetadata: largeMetadata, Timestamp: "2024-01-01T00:00:02Z"},
	} {
		if err := reporter.Enqueue(message); err != nil {
			t.Fatal(err)
		}
	}
	reporter.flush()
	reporter.Shutdown()
	assertOutboxCount(t, db, 0, "after successful retry")
	mu.Lock()
	defer mu.Unlock()
	if accepted["small-a"].Content != strings.Repeat("a", 90000) || accepted["small-b"].Content != strings.Repeat("b", 90000) {
		t.Fatal("small messages changed")
	}
	if len(acceptedOrder) < 5 || acceptedOrder[0] != "small-a" || acceptedOrder[1] != "small-b" {
		t.Fatalf("delivery order changed: %v", acceptedOrder)
	}
	var content, metadata strings.Builder
	for _, id := range acceptedOrder[2:] {
		message := accepted[id]
		var marker struct {
			SAMMultipart struct {
				MessageID string `json:"messageId"`
				Field     string `json:"field"`
				Part      int    `json:"part"`
			} `json:"samMultipart"`
		}
		if err := json.Unmarshal([]byte(message.ToolMetadata), &marker); err != nil {
			t.Fatal(err)
		}
		if marker.SAMMultipart.MessageID != "large" {
			t.Fatalf("wrong fragment owner: %s", id)
		}
		switch marker.SAMMultipart.Field {
		case "content":
			content.WriteString(message.Content)
		case "toolMetadata":
			metadata.WriteString(message.Content)
		default:
			t.Fatalf("unknown field: %s", marker.SAMMultipart.Field)
		}
	}
	if content.String() != largeContent || metadata.String() != largeMetadata {
		t.Fatal("oversized data changed")
	}
	if requestCount < 2 {
		t.Fatal("lost acknowledgement did not exercise retry")
	}
}
