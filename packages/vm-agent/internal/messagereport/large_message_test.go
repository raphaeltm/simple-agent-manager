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

func TestReporterDeliversOneCanonicalOversizedMessageAcrossRetries(t *testing.T) {
	const bodyLimit = 262144
	const contentLimit = 102400
	content := strings.Repeat("é🌊<\\\n", 30000)
	metadataBytes, _ := json.Marshal(map[string]string{"output": strings.Repeat("🚀", 45000)})
	metadata := string(metadataBytes)
	type recordedMessage struct{ ID, Role, Content, Metadata string }
	var mu sync.Mutex
	accepted := make(map[string]recordedMessage)
	var order []string
	parts := make(map[string]map[int]string)
	failedPart := false
	failedCommit := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			w.WriteHeader(500)
			return
		}
		if len(body) > bodyLimit {
			t.Errorf("request has %d bytes", len(body))
			writePayloadTooLarge(w)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if strings.HasSuffix(r.URL.Path, "/messages/upload") {
			var envelope struct {
				Action, SessionID, MessageID, Field, Data, Role, ContentSHA256, MetadataSHA256 string
				Part, ContentParts, MetadataParts                                              int
			}
			if err := json.Unmarshal(body, &envelope); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			if envelope.Action == "part" {
				if len(envelope.Data) > contentLimit {
					t.Errorf("part has %d bytes", len(envelope.Data))
					w.WriteHeader(400)
					return
				}
				key := envelope.MessageID + ":" + envelope.Field
				if parts[key] == nil {
					parts[key] = make(map[int]string)
				}
				if old, exists := parts[key][envelope.Part]; exists && old != envelope.Data {
					t.Error("conflicting retry")
				}
				parts[key][envelope.Part] = envelope.Data
				if !failedPart {
					failedPart = true
					w.WriteHeader(500)
					return
				}
				_, _ = w.Write([]byte(`{"accepted":true}`))
				return
			}
			if envelope.Action != "commit" {
				w.WriteHeader(400)
				return
			}
			join := func(field string, count int) string {
				var result strings.Builder
				for i := 0; i < count; i++ {
					value, ok := parts[envelope.MessageID+":"+field][i]
					if !ok {
						t.Errorf("missing %s part %d", field, i)
					}
					result.WriteString(value)
				}
				return result.String()
			}
			assembledContent := join("content", envelope.ContentParts)
			assembledMetadata := join("toolMetadata", envelope.MetadataParts)
			if uploadDigest(assembledContent) != envelope.ContentSHA256 || uploadDigest(assembledMetadata) != envelope.MetadataSHA256 {
				t.Error("digest mismatch")
				w.WriteHeader(400)
				return
			}
			if _, exists := accepted[envelope.MessageID]; !exists {
				accepted[envelope.MessageID] = recordedMessage{envelope.MessageID, envelope.Role, assembledContent, assembledMetadata}
				order = append(order, envelope.MessageID)
			}
			if !failedCommit {
				failedCommit = true
				w.WriteHeader(500)
				return
			}
			_, _ = w.Write([]byte(`{"persisted":1,"duplicates":0}`))
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
			if len(message.Content) > contentLimit {
				t.Error("normal content too large")
				w.WriteHeader(400)
				return
			}
			if _, exists := accepted[message.MessageID]; !exists {
				accepted[message.MessageID] = recordedMessage{message.MessageID, message.Role, message.Content, message.ToolMetadata}
				order = append(order, message.MessageID)
			}
		}
		writePersistedCount(w, len(payload.Messages))
	}))
	defer server.Close()
	db := openTestDB(t)
	cfg := testConfig(server.URL, "ws-1")
	cfg.BatchMaxWait = time.Hour
	cfg.BatchMaxBytes = bodyLimit
	cfg.MaxMessageContentBytes = contentLimit
	cfg.RetryInitial = time.Millisecond
	cfg.RetryMax = 5 * time.Millisecond
	reporter, err := New(db, cfg)
	if err != nil {
		t.Fatal(err)
	}
	reporter.SetToken("token")
	for _, message := range []Message{
		{MessageID: "small-a", Role: "assistant", Content: strings.Repeat("a", 90000)},
		{MessageID: "small-b", Role: "assistant", Content: strings.Repeat("b", 90000)},
		{MessageID: "large", Role: "assistant", Content: content, ToolMetadata: metadata},
		{MessageID: "tail", Role: "assistant", Content: "after oversized"},
	} {
		if err := reporter.Enqueue(message); err != nil {
			t.Fatal(err)
		}
	}
	reporter.flush()
	reporter.Shutdown()
	assertOutboxCount(t, db, 0, "after canonical commit")
	mu.Lock()
	defer mu.Unlock()
	if !failedPart || !failedCommit {
		t.Fatal("retry paths did not run")
	}
	if strings.Join(order, ",") != "small-a,small-b,large,tail" {
		t.Fatalf("order changed: %v", order)
	}
	if accepted["large"] != (recordedMessage{"large", "assistant", content, metadata}) {
		t.Fatal("original message changed")
	}
}

func TestReadBatchRetainsLegacyRowBeyondLogicalMemoryBound(t *testing.T) {
	db := openTestDB(t)
	cfg := testConfig("http://localhost", "ws-1")
	cfg.BatchMaxWait = time.Hour
	reporter, err := New(db, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reporter.Shutdown()
	_, err = db.Exec(
		`INSERT INTO message_outbox (message_id, session_id, role, content, created_at)
		 VALUES ('legacy-large', 'sess-1', 'assistant', ?, '2024-01-01T00:00:00Z'),
		 ('tail', 'sess-1', 'assistant', 'later', '2024-01-01T00:00:01Z')`,
		strings.Repeat("x", DefaultConfig().MaxMessageUploadBytes+1),
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reporter.readBatch(); err == nil {
		t.Fatal("expected explicit legacy row size error")
	}
	assertOutboxCount(t, db, 2, "oversized legacy row and tail retained")
}

func TestUploadTerminalNoContentResponseRetainsOriginal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	db := openTestDB(t)
	cfg := testConfig(server.URL, "ws-1")
	cfg.BatchMaxWait = time.Hour
	reporter, err := New(db, cfg)
	if err != nil {
		t.Fatal(err)
	}
	reporter.SetToken("token")
	if err := reporter.Enqueue(Message{MessageID: "original", Role: "assistant", Content: strings.Repeat("é", 120000)}); err != nil {
		t.Fatal(err)
	}
	reporter.flush()
	assertOutboxCount(t, db, 1, "terminal 204 did not acknowledge storage")
	reporter.Shutdown()
	assertOutboxCount(t, db, 1, "terminal 204 after shutdown")
}

func TestEnqueueRejectsInvalidUTF8WithoutChangingTranscript(t *testing.T) {
	db := openTestDB(t)
	reporter, err := New(db, testConfig("http://localhost", "ws-1"))
	if err != nil {
		t.Fatal(err)
	}
	defer reporter.Shutdown()
	for _, message := range []Message{
		{MessageID: "bad-content", Role: "assistant", Content: string([]byte{0xff})},
		{MessageID: "bad-metadata", Role: "assistant", Content: "valid", ToolMetadata: string([]byte{0xff})},
	} {
		if err := reporter.Enqueue(message); err == nil {
			t.Fatalf("accepted invalid UTF-8 for %s", message.MessageID)
		}
	}
	assertOutboxCount(t, db, 0, "invalid UTF-8 rejected before outbox")
}
