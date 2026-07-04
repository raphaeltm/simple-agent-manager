package features

import (
	"context"
	"strings"
	"testing"
)

func TestNewToolsStartCompleteAndStatus(t *testing.T) {
	list, err := New([]Feature{{
		ID:           "docs",
		Behavior:     "Update docs",
		Verification: []string{"go test ./..."},
	}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	stateChanges := 0
	tools := toolsByName(NewTools(list, func() { stateChanges++ }))

	if got, err := tools["feature_start"].Execute(context.Background(), map[string]any{"id": "docs"}); err != nil || !strings.Contains(got, "in_progress") {
		t.Fatalf("feature_start = %q, %v", got, err)
	}
	if got, err := tools["feature_complete"].Execute(context.Background(), map[string]any{
		"id":       "docs",
		"evidence": []string{"go test ./... passed"},
	}); err != nil || !strings.Contains(got, "done") {
		t.Fatalf("feature_complete = %q, %v", got, err)
	}
	status, err := tools["feature_status"].Execute(context.Background(), map[string]any{})
	if err != nil {
		t.Fatalf("feature_status: %v", err)
	}
	if !strings.Contains(status, `"status": "done"`) {
		t.Fatalf("feature_status missing done state: %s", status)
	}
	if stateChanges != 2 {
		t.Fatalf("stateChanges = %d, want 2", stateChanges)
	}
}

func TestBlockToolRecordsBlocker(t *testing.T) {
	list, err := New([]Feature{{ID: "blocked", Behavior: "Blocked work"}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	tools := toolsByName(NewTools(list, nil))

	if _, err := tools["feature_block"].Execute(context.Background(), map[string]any{
		"id":       "blocked",
		"evidence": []any{"waiting on dependency"},
	}); err != nil {
		t.Fatalf("feature_block: %v", err)
	}
	snapshot := list.Snapshot()
	if snapshot[0].Status != StatusBlocked || snapshot[0].Evidence[0] != "waiting on dependency" {
		t.Fatalf("unexpected blocked state: %+v", snapshot[0])
	}
}

func TestCompleteToolRejectsInvalidEvidenceShape(t *testing.T) {
	list, err := New([]Feature{{ID: "bad", Behavior: "Bad evidence"}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := list.Start("bad"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	tools := toolsByName(NewTools(list, nil))

	_, err = tools["feature_complete"].Execute(context.Background(), map[string]any{
		"id":       "bad",
		"evidence": "not an array",
	})
	if err == nil || !strings.Contains(err.Error(), "array of strings") {
		t.Fatalf("expected evidence shape error, got %v", err)
	}
}

func TestMisconfiguredToolsReturnErrors(t *testing.T) {
	if _, err := (&StartTool{}).Execute(context.Background(), map[string]any{}); err == nil {
		t.Fatal("expected StartTool misconfigured error")
	}
	if _, err := (&CompleteTool{}).Execute(context.Background(), map[string]any{}); err == nil {
		t.Fatal("expected CompleteTool misconfigured error")
	}
	if _, err := (&BlockTool{}).Execute(context.Background(), map[string]any{}); err == nil {
		t.Fatal("expected BlockTool misconfigured error")
	}
	if _, err := (&StatusTool{}).Execute(context.Background(), map[string]any{}); err == nil {
		t.Fatal("expected StatusTool misconfigured error")
	}
}

func toolsByName(tools []Tool) map[string]Tool {
	out := make(map[string]Tool, len(tools))
	for _, tool := range tools {
		out[tool.Name()] = tool
	}
	return out
}
