package eventstore

import (
	"path/filepath"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	s, err := New(filepath.Join(dir, "events.db"))
	if err != nil {
		t.Fatalf("eventstore.New: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestListByTypePrefix_ChronologicalOrderAndFilter(t *testing.T) {
	s := newTestStore(t)

	base := time.Date(2026, 4, 18, 12, 0, 0, 0, time.UTC)
	seed := []EventRecord{
		// Interleaved types; insertion order deliberately not chronological.
		{ID: "e1", Type: "provision.docker-install.started", Level: "info", Message: "start", CreatedAt: base.Add(2 * time.Second).Format(time.RFC3339)},
		{ID: "e2", Type: "heartbeat", Level: "info", Message: "hb", CreatedAt: base.Add(1 * time.Second).Format(time.RFC3339)},
		{ID: "e3", Type: "provision.docker-install.completed", Level: "info", Message: "done", CreatedAt: base.Add(5 * time.Second).Format(time.RFC3339)},
		{ID: "e4", Type: "provision.firewall.started", Level: "info", Message: "fw-start", CreatedAt: base.Add(0).Format(time.RFC3339)},
		{ID: "e5", Type: "other.event", Level: "info", Message: "noise", CreatedAt: base.Add(3 * time.Second).Format(time.RFC3339)},
	}
	for _, e := range seed {
		s.Append(e)
	}

	got, err := s.ListByTypePrefix("provision.", 0)
	if err != nil {
		t.Fatalf("ListByTypePrefix: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("expected 3 provision events, got %d: %+v", len(got), got)
	}
	// Must be chronological ASC.
	wantIDs := []string{"e4", "e1", "e3"}
	for i, w := range wantIDs {
		if got[i].ID != w {
			t.Errorf("pos %d: want id %q, got %q (createdAt=%q)", i, w, got[i].ID, got[i].CreatedAt)
		}
	}
	// Filter must exclude non-matching prefix.
	for _, e := range got {
		if e.Type == "heartbeat" || e.Type == "other.event" {
			t.Errorf("prefix filter leak: %+v", e)
		}
	}
}

func TestListByTypePrefix_RespectsLimit(t *testing.T) {
	s := newTestStore(t)
	base := time.Date(2026, 4, 18, 12, 0, 0, 0, time.UTC)
	for i := 0; i < 5; i++ {
		s.Append(EventRecord{
			ID:        "p" + string(rune('0'+i)),
			Type:      "provision.step",
			Level:     "info",
			Message:   "msg",
			CreatedAt: base.Add(time.Duration(i) * time.Second).Format(time.RFC3339),
		})
	}
	got, err := s.ListByTypePrefix("provision.", 2)
	if err != nil {
		t.Fatalf("ListByTypePrefix: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 events (limit), got %d", len(got))
	}
	if got[0].ID != "p0" || got[1].ID != "p1" {
		t.Errorf("limit should keep oldest 2 in ASC order; got %q,%q", got[0].ID, got[1].ID)
	}
}

func TestListByTypePrefix_PreservesDetail(t *testing.T) {
	s := newTestStore(t)
	now := time.Now().UTC().Format(time.RFC3339)
	s.Append(EventRecord{
		ID:        "d1",
		Type:      "provision.docker.completed",
		Level:     "info",
		Message:   "ok",
		CreatedAt: now,
		Detail:    map[string]interface{}{"durationMs": float64(1234), "status": "completed"},
	})
	got, err := s.ListByTypePrefix("provision.", 0)
	if err != nil || len(got) != 1 {
		t.Fatalf("ListByTypePrefix: err=%v len=%d", err, len(got))
	}
	if got[0].Detail["durationMs"].(float64) != 1234 {
		t.Errorf("detail.durationMs mismatch: %+v", got[0].Detail)
	}
	if got[0].Detail["status"].(string) != "completed" {
		t.Errorf("detail.status mismatch: %+v", got[0].Detail)
	}
}
