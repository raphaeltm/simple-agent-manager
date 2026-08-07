package server

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/errorreport"
	"github.com/workspace/vm-agent/internal/eventstore"
)

func TestIncidentCollectorsExposeOnlyBoundedSafePreviews(t *testing.T) {
	store, err := eventstore.New(t.TempDir() + "/events.db")
	if err != nil {
		t.Fatalf("create event store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	now := time.Now().UTC()
	for _, event := range []eventstore.EventRecord{
		{ID: "event-other", NodeID: "node-secret", WorkspaceID: "workspace-other", Level: "warn", Type: "other", Message: "must not leak", Detail: map[string]any{"token": "must-not-leak"}, CreatedAt: now.Add(-time.Second).Format(time.RFC3339Nano)},
		{ID: "event-old", NodeID: "node-secret", WorkspaceID: "workspace-a", Level: "info", Type: "provisioning.old", Message: "private old message", Detail: map[string]any{"secret": "private-old-detail"}, CreatedAt: now.Add(-2 * time.Second).Format(time.RFC3339Nano)},
		{ID: "event-new", NodeID: "node-secret", WorkspaceID: "workspace-a", Level: "error", Type: "provisioning.new", Message: "private new message", Detail: map[string]any{"secret": "private-new-detail"}, CreatedAt: now.Format(time.RFC3339Nano)},
	} {
		store.Append(event)
	}

	server := &Server{
		config:     &config.Config{ErrorReportEventLimit: 2},
		eventStore: store,
		workspaces: map[string]*WorkspaceRuntime{
			"workspace-z": {ID: "workspace-z", Status: "running", Repository: "private/repo-z", CallbackToken: "callback-secret-z", CreatedAt: now, UpdatedAt: now},
			"workspace-a": {ID: "workspace-a", Status: "ready", WorkspaceDir: "/private/workspace-a", CreatedAt: now.Add(-time.Minute), UpdatedAt: now, Lightweight: true, ProvisioningActive: true},
			"workspace-b": {ID: "workspace-b", Status: "queued", CloneURL: "https://secret@example.test/repo", CreatedAt: now, UpdatedAt: now},
		},
	}
	collectors := server.incidentCollectors()
	if got := collectorNames(collectors); strings.Join(got, ",") != "agent-version,system-resources,structured-events,workspace-lifecycle" {
		t.Fatalf("unexpected production collector allowlist: %v", got)
	}

	structured := collectorByName(t, collectors, "structured-events")
	value, err := structured.Collect(context.Background(), errorreport.IncidentContext{WorkspaceID: "workspace-a"})
	if err != nil {
		t.Fatalf("collect structured events: %v", err)
	}
	events := value.(map[string]any)["events"].([]eventSafePreview)
	if len(events) != 2 || events[0].ID != "event-new" || events[1].ID != "event-old" {
		t.Fatalf("expected newest two workspace events, got %#v", events)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal structured preview: %v", err)
	}
	for _, forbidden := range []string{"node-secret", "private new message", "private-new-detail", "event-other"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("structured preview leaked %q: %s", forbidden, encoded)
		}
	}

	lifecycle := collectorByName(t, collectors, "workspace-lifecycle")
	value, err = lifecycle.Collect(context.Background(), errorreport.IncidentContext{})
	if err != nil {
		t.Fatalf("collect workspace lifecycle: %v", err)
	}
	workspaces := value.(map[string]any)["workspaces"].([]workspaceSafePreview)
	if len(workspaces) != 2 || workspaces[0].ID != "workspace-a" || workspaces[1].ID != "workspace-b" {
		t.Fatalf("expected sorted bounded workspace previews, got %#v", workspaces)
	}
	encoded, err = json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal workspace preview: %v", err)
	}
	for _, forbidden := range []string{"private/repo-z", "callback-secret-z", "/private/workspace-a", "secret@example.test"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("workspace preview leaked %q: %s", forbidden, encoded)
		}
	}
}

func TestIncidentCollectorsHonorCancellationAndReportUnavailableDependencies(t *testing.T) {
	server := &Server{
		config:     &config.Config{ErrorReportEventLimit: 2},
		workspaces: map[string]*WorkspaceRuntime{},
	}
	collectors := server.incidentCollectors()
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	for _, collector := range collectors {
		if _, err := collector.Collect(cancelled, errorreport.IncidentContext{}); err == nil {
			t.Fatalf("collector %q ignored cancellation", collector.Name())
		}
	}

	for _, name := range []string{"system-resources", "structured-events"} {
		if _, err := collectorByName(t, collectors, name).Collect(context.Background(), errorreport.IncidentContext{}); err == nil {
			t.Fatalf("collector %q did not report its unavailable dependency", name)
		}
	}
}

func collectorNames(collectors []errorreport.Collector) []string {
	names := make([]string, 0, len(collectors))
	for _, collector := range collectors {
		names = append(names, collector.Name())
	}
	return names
}

func collectorByName(t *testing.T, collectors []errorreport.Collector, name string) errorreport.Collector {
	t.Helper()
	for _, collector := range collectors {
		if collector.Name() == name {
			return collector
		}
	}
	t.Fatalf("collector %q was not configured", name)
	return nil
}
