package server

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/eventstore"
)

func newEventStore(t *testing.T) *eventstore.Store {
	t.Helper()
	dir := t.TempDir()
	es, err := eventstore.New(filepath.Join(dir, "events.db"))
	if err != nil {
		t.Fatalf("eventstore.New: %v", err)
	}
	t.Cleanup(func() { _ = es.Close() })
	return es
}

func TestBuildProvisioningTimings_EmptyReturnsBlank(t *testing.T) {
	es := newEventStore(t)
	if out := buildProvisioningTimings(es); out != "" {
		t.Errorf("expected empty string for no events, got: %q", out)
	}
}

func TestBuildProvisioningTimings_RendersTableAndSummary(t *testing.T) {
	es := newEventStore(t)
	base := time.Date(2026, 4, 18, 12, 0, 0, 0, time.UTC)

	// firewall: 0s -> 1s (1000ms)
	es.Append(eventstore.EventRecord{
		ID: "fw-start", Type: "provision.firewall", Level: "info", Message: "s",
		CreatedAt: base.Format(time.RFC3339),
		Detail:    map[string]interface{}{"status": "started"},
	})
	es.Append(eventstore.EventRecord{
		ID: "fw-end", Type: "provision.firewall", Level: "info", Message: "d",
		CreatedAt: base.Add(1 * time.Second).Format(time.RFC3339),
		Detail:    map[string]interface{}{"status": "completed", "durationMs": float64(1000)},
	})

	// docker-install: 2s -> 5s (3000ms)
	es.Append(eventstore.EventRecord{
		ID: "d-start", Type: "provision.docker-install", Level: "info", Message: "s",
		CreatedAt: base.Add(2 * time.Second).Format(time.RFC3339),
		Detail:    map[string]interface{}{"status": "started"},
	})
	es.Append(eventstore.EventRecord{
		ID: "d-end", Type: "provision.docker-install", Level: "info", Message: "d",
		CreatedAt: base.Add(5 * time.Second).Format(time.RFC3339),
		Detail:    map[string]interface{}{"status": "completed", "durationMs": float64(3000)},
	})

	out := buildProvisioningTimings(es)
	if out == "" {
		t.Fatal("expected non-empty output")
	}

	// Header columns.
	for _, want := range []string{"STEP", "STATUS", "STARTED_AT", "ENDED_AT", "DURATION_MS"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing column header %q in output:\n%s", want, out)
		}
	}

	// Step rows render step name + status.
	for _, want := range []string{"firewall", "docker-install", "completed"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing step content %q in output:\n%s", want, out)
		}
	}

	// Durations present.
	if !strings.Contains(out, "1000") || !strings.Contains(out, "3000") {
		t.Errorf("expected durations 1000 and 3000 in output:\n%s", out)
	}

	// Sum-of-durations line (4000 ms total).
	if !strings.Contains(out, "Sum of per-step durations:") {
		t.Errorf("missing sum-of-durations line:\n%s", out)
	}
	if !strings.Contains(out, "4000 ms") {
		t.Errorf("expected total 4000 ms in summary:\n%s", out)
	}

	// Wall-clock line — 5s from first start to last end.
	if !strings.Contains(out, "Wall-clock (first→last):") {
		t.Errorf("missing wall-clock summary line:\n%s", out)
	}
	if !strings.Contains(out, "5000 ms") {
		t.Errorf("expected wall-clock 5000 ms in summary:\n%s", out)
	}
}

func TestBuildProvisioningTimings_HandlesFailedStep(t *testing.T) {
	es := newEventStore(t)
	now := time.Now().UTC()
	es.Append(eventstore.EventRecord{
		ID: "s", Type: "provision.broken", Level: "info", Message: "s",
		CreatedAt: now.Format(time.RFC3339),
		Detail:    map[string]interface{}{"status": "started"},
	})
	es.Append(eventstore.EventRecord{
		ID: "f", Type: "provision.broken", Level: "error", Message: "err",
		CreatedAt: now.Add(2 * time.Second).Format(time.RFC3339),
		Detail:    map[string]interface{}{"status": "failed", "durationMs": float64(2000)},
	})
	out := buildProvisioningTimings(es)
	if !strings.Contains(out, "broken") || !strings.Contains(out, "failed") {
		t.Errorf("expected failed step in output:\n%s", out)
	}
	if !strings.Contains(out, "2000") {
		t.Errorf("expected duration 2000 ms:\n%s", out)
	}
}
