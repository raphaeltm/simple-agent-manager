package server

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/agentsessions"
)

func TestEnrichedSessionJSON_WithHostStatus(t *testing.T) {
	status := "prompting"
	viewers := 2
	session := enrichedSession{
		Session: agentsessions.Session{
			ID:          "sess-1",
			WorkspaceID: "ws-1",
			Status:      agentsessions.StatusRunning,
			Label:       "Chat 1",
			CreatedAt:   time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC),
			UpdatedAt:   time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC),
		},
		HostStatus:  &status,
		ViewerCount: &viewers,
	}

	data, err := json.Marshal(session)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// Verify enriched fields are present
	if parsed["hostStatus"] != "prompting" {
		t.Errorf("expected hostStatus=prompting, got %v", parsed["hostStatus"])
	}
	if parsed["viewerCount"] != float64(2) {
		t.Errorf("expected viewerCount=2, got %v", parsed["viewerCount"])
	}

	// Verify base session fields are preserved
	if parsed["id"] != "sess-1" {
		t.Errorf("expected id=sess-1, got %v", parsed["id"])
	}
	if parsed["workspaceId"] != "ws-1" {
		t.Errorf("expected workspaceId=ws-1, got %v", parsed["workspaceId"])
	}
	if parsed["status"] != "running" {
		t.Errorf("expected status=running, got %v", parsed["status"])
	}
	if parsed["label"] != "Chat 1" {
		t.Errorf("expected label=Chat 1, got %v", parsed["label"])
	}
}

func TestEnrichedSessionJSON_WithoutHostStatus(t *testing.T) {
	session := enrichedSession{
		Session: agentsessions.Session{
			ID:          "sess-2",
			WorkspaceID: "ws-1",
			Status:      agentsessions.StatusRunning,
			CreatedAt:   time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC),
			UpdatedAt:   time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC),
		},
		// No HostStatus or ViewerCount — simulates no SessionHost yet
	}

	data, err := json.Marshal(session)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// Enriched fields should be absent (omitempty)
	if _, found := parsed["hostStatus"]; found {
		t.Errorf("expected hostStatus to be omitted, got %v", parsed["hostStatus"])
	}
	if _, found := parsed["viewerCount"]; found {
		t.Errorf("expected viewerCount to be omitted, got %v", parsed["viewerCount"])
	}

	// Base fields should still be present
	if parsed["id"] != "sess-2" {
		t.Errorf("expected id=sess-2, got %v", parsed["id"])
	}
}

func TestEnrichedSessionJSON_AllHostStatuses(t *testing.T) {
	statuses := []string{"idle", "starting", "ready", "prompting", "error", "stopped"}

	for _, s := range statuses {
		status := s
		session := enrichedSession{
			Session: agentsessions.Session{
				ID:          "sess-test",
				WorkspaceID: "ws-1",
				Status:      agentsessions.StatusRunning,
				CreatedAt:   time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC),
				UpdatedAt:   time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC),
			},
			HostStatus: &status,
		}

		data, err := json.Marshal(session)
		if err != nil {
			t.Fatalf("marshal %s: %v", s, err)
		}

		var parsed map[string]interface{}
		if err := json.Unmarshal(data, &parsed); err != nil {
			t.Fatalf("unmarshal %s: %v", s, err)
		}

		if parsed["hostStatus"] != s {
			t.Errorf("expected hostStatus=%s, got %v", s, parsed["hostStatus"])
		}
	}
}
