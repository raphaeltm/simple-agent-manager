package messagereport

import (
	"encoding/json"
	"strings"
	"testing"
)

// Enqueue must persist the origin column, and the flush read path
// (readBatch → rowToAPIMessage → buildBatchPayload) must carry it outward.
func TestEnqueue_PersistsAndForwardsOrigin(t *testing.T) {
	db := openTestDB(t)
	r, err := New(db, testConfig("http://localhost", "ws-1"))
	if err != nil {
		t.Fatalf("new reporter: %v", err)
	}
	defer r.Shutdown()

	if err := r.Enqueue(Message{MessageID: "m-sys", SessionID: "s", Role: "user", Content: "reminder", Timestamp: "t1", Origin: "system"}); err != nil {
		t.Fatalf("enqueue system: %v", err)
	}
	if err := r.Enqueue(Message{MessageID: "m-usr", SessionID: "s", Role: "user", Content: "hi", Timestamp: "t2"}); err != nil {
		t.Fatalf("enqueue user: %v", err)
	}

	// Column persisted.
	var stored string
	if err := db.QueryRow("SELECT origin FROM message_outbox WHERE message_id='m-sys'").Scan(&stored); err != nil {
		t.Fatalf("query origin: %v", err)
	}
	if stored != "system" {
		t.Fatalf("stored origin = %q, want system", stored)
	}

	// Flush read path preserves origin and omits it when empty.
	batch, err := r.readBatch()
	if err != nil {
		t.Fatalf("readBatch: %v", err)
	}
	byID := map[string]apiMessage{}
	for _, row := range batch {
		byID[row.messageID] = rowToAPIMessage(row)
	}
	if byID["m-sys"].Origin != "system" {
		t.Fatalf("apiMessage origin = %q, want system", byID["m-sys"].Origin)
	}
	if byID["m-usr"].Origin != "" {
		t.Fatalf("apiMessage origin for normal user = %q, want empty", byID["m-usr"].Origin)
	}

	payload, err := buildBatchPayload([]apiMessage{byID["m-sys"], byID["m-usr"]})
	if err != nil {
		t.Fatalf("buildBatchPayload: %v", err)
	}
	if !strings.Contains(string(payload), `"origin":"system"`) {
		t.Fatalf("payload missing origin marker: %s", payload)
	}
	// omitempty: the normal user message must not emit an origin key.
	var decoded struct {
		Messages []map[string]json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if len(decoded.Messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(decoded.Messages))
	}
	if _, ok := decoded.Messages[1]["origin"]; ok {
		t.Fatalf("normal user message should omit origin, got %v", decoded.Messages[1])
	}
}

// migrateOutbox must be idempotent: calling it again (origin column already
// present) must not error on the ALTER TABLE ADD COLUMN.
func TestMigrateOutbox_Idempotent(t *testing.T) {
	db := openTestDB(t) // New() already ran migrateOutbox once
	if err := migrateOutbox(db); err != nil {
		t.Fatalf("second migrateOutbox errored: %v", err)
	}
}
