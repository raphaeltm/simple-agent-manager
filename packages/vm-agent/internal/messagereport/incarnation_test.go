package messagereport

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestOutboxIncarnationSurvivesReopenAndChangesWithDatabase(t *testing.T) {
	var observed []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		observed = append(observed, req.Header.Get("X-SAM-Outbox-Incarnation"))
		requestMessageIDs(t, req)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "outbox.db")
	open := func() *sql.DB {
		t.Helper()
		db, err := sql.Open("sqlite", path)
		if err != nil {
			t.Fatal(err)
		}
		return db
	}
	run := func(db *sql.DB, session string) {
		t.Helper()
		cfg := testConfig(server.URL, "workspace")
		cfg.BatchMaxWait = time.Hour
		r, err := New(db, cfg)
		if err != nil {
			t.Fatal(err)
		}
		r.SetToken("test-token")
		r.SetSessionID(session)
		if err := r.Enqueue(Message{MessageID: uuid.NewString(), Role: "assistant", Content: "chunk"}); err != nil {
			t.Fatal(err)
		}
		r.flush()
		r.Shutdown()
	}
	db := open()
	run(db, "first-session")
	run(db, "second-session")
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db = open()
	run(db, "second-session")
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	db = open()
	defer db.Close()
	run(db, "second-session")
	if len(observed) != 4 {
		t.Fatalf("got %d requests, want 4", len(observed))
	}
	for _, id := range observed {
		if _, err := uuid.Parse(id); err != nil {
			t.Fatalf("reporter must send an outbox UUID: %v", err)
		}
	}
	if observed[0] != observed[1] || observed[0] != observed[2] {
		t.Fatal("session changes or database reopen changed the durable outbox identity")
	}
	if observed[0] == observed[3] {
		t.Fatal("database recreation reused the old outbox identity")
	}
}
