package features

import "testing"

func TestCompleteRequiresEvidenceForEachVerification(t *testing.T) {
	list, err := New([]Feature{{
		ID:           "api",
		Behavior:     "Add API behavior",
		Verification: []string{"go test ./api", "curl /health"},
	}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := list.Start("api"); err != nil {
		t.Fatalf("Start: %v", err)
	}

	err = list.Complete("api", []string{"go test passed"})
	if err == nil {
		t.Fatal("expected missing evidence error")
	}
	got := list.Snapshot()[0]
	if got.Status != StatusInProgress {
		t.Fatalf("status = %s, want in_progress", got.Status)
	}
}

func TestWIPLimit(t *testing.T) {
	list, err := New([]Feature{
		{ID: "one", Behavior: "First"},
		{ID: "two", Behavior: "Second"},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := list.Start("one"); err != nil {
		t.Fatalf("Start one: %v", err)
	}
	if err := list.Start("two"); err == nil {
		t.Fatal("expected WIP limit error")
	}
	snapshot := list.Snapshot()
	if snapshot[0].Status != StatusInProgress || snapshot[1].Status != StatusPending {
		t.Fatalf("unexpected statuses: %+v", snapshot)
	}
}

func TestFromJSONAcceptsWrappedFeatures(t *testing.T) {
	list, err := FromJSON([]byte(`{"features":[{"id":"ui","behavior":"Render UI","verification":["go test ./..."]}]}`))
	if err != nil {
		t.Fatalf("FromJSON: %v", err)
	}
	if got := list.Snapshot(); len(got) != 1 || got[0].ID != "ui" || got[0].Status != StatusPending {
		t.Fatalf("unexpected features: %+v", got)
	}
}
