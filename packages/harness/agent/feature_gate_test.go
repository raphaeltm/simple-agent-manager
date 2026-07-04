package agent

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/workspace/harness/features"
	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/session"
	"github.com/workspace/harness/tools"
	"github.com/workspace/harness/transcript"
)

func TestFeatureGateNudgesThenTerminatesIncomplete(t *testing.T) {
	list := mustFeatureList(t, features.Feature{
		ID:           "login",
		Behavior:     "Implement login",
		Verification: []string{"go test ./login"},
	})
	provider := llm.NewMockProvider(
		&llm.Response{Content: "Done."},
		&llm.Response{Content: "Still done."},
		&llm.Response{Content: "Really done."},
	)
	tlog := transcript.NewLog()

	result, err := Run(context.Background(), provider, tools.NewRegistry(), tlog, Config{
		MaxTurns:         5,
		FeatureList:      list,
		MaxFeatureNudges: 2,
	}, "Implement login")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.StopReason != "incomplete" {
		t.Fatalf("StopReason = %q, want incomplete", result.StopReason)
	}
	if result.TerminalStatus != "incomplete" {
		t.Fatalf("TerminalStatus = %q, want incomplete", result.TerminalStatus)
	}
	if provider.CallCount() != 3 {
		t.Fatalf("provider calls = %d, want 3", provider.CallCount())
	}
	if len(result.UnfinishedFeatures) != 1 || result.UnfinishedFeatures[0].ID != "login" {
		t.Fatalf("unfinished = %+v", result.UnfinishedFeatures)
	}
	if !containsInfoEvent(tlog, "termination_gate_nudge") {
		t.Fatal("expected termination_gate_nudge transcript event")
	}
	if !strings.Contains(result.FinalMessage, "Harness terminal status: incomplete") {
		t.Fatalf("final message missing incomplete status: %q", result.FinalMessage)
	}
}

func TestFeatureGateCompletesWhenAllFeaturesDoneWithEvidence(t *testing.T) {
	list := mustFeatureList(t, features.Feature{
		ID:           "tests",
		Behavior:     "Add tests",
		Verification: []string{"go test ./..."},
	})
	provider := llm.NewMockProvider(
		&llm.Response{ToolCalls: []llm.ToolCall{{
			ID:     "start",
			Name:   "feature_start",
			Params: map[string]any{"id": "tests"},
		}}},
		&llm.Response{ToolCalls: []llm.ToolCall{{
			ID:     "complete",
			Name:   "feature_complete",
			Params: map[string]any{"id": "tests", "evidence": []any{"go test ./... passed"}},
		}}},
		&llm.Response{Content: "All done."},
	)

	result, err := Run(context.Background(), provider, tools.NewRegistry(), transcript.NewLog(), Config{
		MaxTurns:    5,
		FeatureList: list,
	}, "Add tests")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.StopReason != "complete" {
		t.Fatalf("StopReason = %q, want complete", result.StopReason)
	}
	got := list.Snapshot()[0]
	if got.Status != features.StatusDone {
		t.Fatalf("feature status = %s, want done", got.Status)
	}
	if len(got.Evidence) != 1 || got.Evidence[0] != "go test ./... passed" {
		t.Fatalf("evidence = %+v", got.Evidence)
	}
}

func TestFeatureCompleteWithoutRequiredEvidenceRejected(t *testing.T) {
	list := mustFeatureList(t, features.Feature{
		ID:           "api",
		Behavior:     "Implement API",
		Verification: []string{"go test ./api", "curl /api"},
	})
	provider := llm.NewMockProvider(
		&llm.Response{ToolCalls: []llm.ToolCall{{
			ID:     "start",
			Name:   "feature_start",
			Params: map[string]any{"id": "api"},
		}}},
		&llm.Response{ToolCalls: []llm.ToolCall{{
			ID:     "complete",
			Name:   "feature_complete",
			Params: map[string]any{"id": "api", "evidence": []any{"go test ./api passed"}},
		}}},
	)

	result, err := Run(context.Background(), provider, tools.NewRegistry(), transcript.NewLog(), Config{
		MaxTurns:    2,
		FeatureList: list,
	}, "Implement API")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.StopReason != "incomplete" {
		t.Fatalf("StopReason = %q, want incomplete", result.StopReason)
	}
	got := list.Snapshot()[0]
	if got.Status != features.StatusInProgress {
		t.Fatalf("feature status = %s, want in_progress", got.Status)
	}
	if !messagesContain(result.Messages, "requires evidence for each verification entry") {
		t.Fatal("expected instructive evidence error in model-visible tool result")
	}
}

func TestFeatureGateEnforcesWIPLimit(t *testing.T) {
	list := mustFeatureList(t,
		features.Feature{ID: "one", Behavior: "First feature"},
		features.Feature{ID: "two", Behavior: "Second feature"},
	)
	provider := llm.NewMockProvider(
		&llm.Response{ToolCalls: []llm.ToolCall{
			{ID: "start-one", Name: "feature_start", Params: map[string]any{"id": "one"}},
			{ID: "start-two", Name: "feature_start", Params: map[string]any{"id": "two"}},
		}},
	)

	result, err := Run(context.Background(), provider, tools.NewRegistry(), transcript.NewLog(), Config{
		MaxTurns:    1,
		FeatureList: list,
	}, "Work on both")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	snapshot := list.Snapshot()
	if snapshot[0].Status != features.StatusInProgress || snapshot[1].Status != features.StatusPending {
		t.Fatalf("unexpected statuses: %+v", snapshot)
	}
	if !messagesContain(result.Messages, "already in_progress") {
		t.Fatal("expected WIP error in model-visible tool result")
	}
}

func TestFeatureGateMaxTurnsIncomplete(t *testing.T) {
	list := mustFeatureList(t, features.Feature{ID: "loop", Behavior: "Loop feature"})
	provider := llm.NewMockProvider(
		&llm.Response{ToolCalls: []llm.ToolCall{{
			ID:     "echo",
			Name:   "echo",
			Params: map[string]any{"message": "loop"},
		}}},
	)
	registry := tools.NewRegistry()
	registry.Register(&echoTool{})

	result, err := Run(context.Background(), provider, registry, transcript.NewLog(), Config{
		MaxTurns:    1,
		FeatureList: list,
	}, "Loop")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.StopReason != "incomplete" {
		t.Fatalf("StopReason = %q, want incomplete", result.StopReason)
	}
	if !strings.Contains(result.FinalMessage, "max turns exhausted") {
		t.Fatalf("final message = %q, want max turns reason", result.FinalMessage)
	}
}

func TestFeatureGateAllowsZeroNudges(t *testing.T) {
	list := mustFeatureList(t, features.Feature{ID: "zero", Behavior: "No nudge feature"})
	provider := llm.NewMockProvider(&llm.Response{Content: "Done."})

	result, err := Run(context.Background(), provider, tools.NewRegistry(), transcript.NewLog(), Config{
		MaxTurns:            5,
		FeatureList:         list,
		MaxFeatureNudges:    0,
		FeatureMaxNudgesSet: true,
	}, "Stop immediately")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.StopReason != "incomplete" {
		t.Fatalf("StopReason = %q, want incomplete", result.StopReason)
	}
	if provider.CallCount() != 1 {
		t.Fatalf("provider calls = %d, want 1", provider.CallCount())
	}
}

func TestNoFeatureListPreservesNoToolCompletionBehavior(t *testing.T) {
	provider := llm.NewMockProvider(&llm.Response{Content: "Done."})

	result, err := Run(context.Background(), provider, tools.NewRegistry(), transcript.NewLog(), Config{
		MaxTurns: 5,
	}, "Stop")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.StopReason != "complete" {
		t.Fatalf("StopReason = %q, want complete", result.StopReason)
	}
	if provider.CallCount() != 1 {
		t.Fatalf("provider calls = %d, want 1", provider.CallCount())
	}
}

func TestFeatureStatePersistsAndReloadsOnResume(t *testing.T) {
	store, err := session.NewStore(filepath.Join(t.TempDir(), "sessions.db"))
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	defer store.Close()

	sessionID := "feature-resume"
	if _, err := store.CreateSession(sessionID, session.Config{}); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	list := mustFeatureList(t, features.Feature{
		ID:           "persist",
		Behavior:     "Persist feature state",
		Verification: []string{"go test ./..."},
	})

	firstProvider := llm.NewMockProvider(&llm.Response{ToolCalls: []llm.ToolCall{{
		ID:     "start",
		Name:   "feature_start",
		Params: map[string]any{"id": "persist"},
	}}})
	if _, err := Run(context.Background(), firstProvider, tools.NewRegistry(), transcript.NewLog(), Config{
		MaxTurns:     1,
		SessionStore: store,
		SessionID:    sessionID,
		FeatureList:  list,
	}, "Start persisted feature"); err != nil {
		t.Fatalf("first Run: %v", err)
	}
	loaded, err := store.LoadFeatures(sessionID)
	if err != nil {
		t.Fatalf("LoadFeatures: %v", err)
	}
	if got := loaded.Snapshot()[0].Status; got != features.StatusInProgress {
		t.Fatalf("persisted status = %s, want in_progress", got)
	}

	secondProvider := llm.NewMockProvider(
		&llm.Response{ToolCalls: []llm.ToolCall{{
			ID:     "complete",
			Name:   "feature_complete",
			Params: map[string]any{"id": "persist", "evidence": []any{"go test ./... passed"}},
		}}},
		&llm.Response{Content: "Done after resume."},
	)
	result, err := Run(context.Background(), secondProvider, tools.NewRegistry(), transcript.NewLog(), Config{
		MaxTurns:     2,
		SessionStore: store,
		SessionID:    sessionID,
	}, "")
	if err != nil {
		t.Fatalf("second Run: %v", err)
	}
	if result.StopReason != "complete" {
		t.Fatalf("StopReason = %q, want complete", result.StopReason)
	}
	reloaded, err := store.LoadFeatures(sessionID)
	if err != nil {
		t.Fatalf("LoadFeatures after resume: %v", err)
	}
	if got := reloaded.Snapshot()[0].Status; got != features.StatusDone {
		t.Fatalf("reloaded status = %s, want done", got)
	}
}

func mustFeatureList(t *testing.T, input ...features.Feature) *features.List {
	t.Helper()
	list, err := features.New(input)
	if err != nil {
		t.Fatalf("features.New: %v", err)
	}
	return list
}

func messagesContain(messages []llm.Message, needle string) bool {
	for _, msg := range messages {
		if strings.Contains(msg.Content, needle) {
			return true
		}
		if msg.ToolResult != nil && strings.Contains(msg.ToolResult.Content, needle) {
			return true
		}
	}
	return false
}

func containsInfoEvent(log *transcript.Log, event string) bool {
	for _, item := range log.Events() {
		if item.Type != transcript.EventInfo {
			continue
		}
		data, ok := item.Data.(map[string]any)
		if ok && data["event"] == event {
			return true
		}
	}
	return false
}
