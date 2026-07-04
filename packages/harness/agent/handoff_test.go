package agent

import (
	"context"
	"errors"
	"testing"

	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/tools"
	"github.com/workspace/harness/transcript"
)

func TestRunHandoffHappyPath(t *testing.T) {
	provider := llm.NewMockProvider(
		&llm.Response{Content: "Done."},
		&llm.Response{Content: `{
			"summary": "The session completed the task.",
			"facts": [{"key": "result", "value": "done"}],
			"openQuestions": [],
			"suggestedActions": ["Review changes"]
		}`},
	)
	result, err := Run(context.Background(), provider, tools.NewRegistry(), transcript.NewLog(), Config{
		MaxTurns:              5,
		HandoffEnabled:        true,
		HandoffMissionID:      "mission-1",
		HandoffFromTaskID:     "task-1",
		HandoffTranscriptPath: "transcript.json",
	}, "do the work")
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Fatalf("stop reason = %s", result.StopReason)
	}
	if result.Handoff == nil {
		t.Fatal("handoff was not generated")
	}
	if result.Handoff.Summary != "The session completed the task." {
		t.Fatalf("handoff summary = %q", result.Handoff.Summary)
	}
	if provider.CallCount() != 2 {
		t.Fatalf("provider calls = %d, want 2", provider.CallCount())
	}
}

func TestRunHandoffMalformedJSONDoesNotAffectExit(t *testing.T) {
	provider := llm.NewMockProvider(
		&llm.Response{Content: "Done."},
		&llm.Response{Content: "not json"},
	)
	result, err := Run(context.Background(), provider, tools.NewRegistry(), transcript.NewLog(), Config{
		MaxTurns:       5,
		HandoffEnabled: true,
	}, "finish")
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Fatalf("stop reason = %s", result.StopReason)
	}
	if result.Handoff == nil {
		t.Fatal("handoff was not generated")
	}
	if !handoffFact(result, "terminalStatus", "success") {
		t.Fatalf("handoff fallback facts = %#v", result.Handoff.Facts)
	}
}

func TestRunHandoffTerminalStatuses(t *testing.T) {
	tests := []struct {
		name       string
		run        func(t *testing.T) (*Result, error)
		wantStop   string
		wantStatus string
		wantErr    bool
	}{
		{
			name: "success",
			run: func(t *testing.T) (*Result, error) {
				provider := llm.NewMockProvider(
					&llm.Response{Content: "Done."},
					&llm.Response{Content: `not json`},
				)
				return Run(context.Background(), provider, tools.NewRegistry(), transcript.NewLog(), Config{MaxTurns: 2, HandoffEnabled: true}, "task")
			},
			wantStop:   "complete",
			wantStatus: "success",
		},
		{
			name: "incomplete",
			run: func(t *testing.T) (*Result, error) {
				provider := llm.NewMockProvider(
					&llm.Response{ToolCalls: []llm.ToolCall{{ID: "echo-1", Name: "echo", Params: map[string]any{"text": "loop"}}}},
					&llm.Response{Content: `not json`},
				)
				registry := tools.NewRegistry()
				if err := registry.Register(&echoTool{}); err != nil {
					t.Fatalf("register echo: %v", err)
				}
				return Run(context.Background(), provider, registry, transcript.NewLog(), Config{MaxTurns: 1, HandoffEnabled: true}, "task")
			},
			wantStop:   "max_turns",
			wantStatus: "incomplete",
		},
		{
			name: "error",
			run: func(t *testing.T) (*Result, error) {
				provider := &firstCallErrorProvider{}
				return Run(context.Background(), provider, tools.NewRegistry(), transcript.NewLog(), Config{MaxTurns: 2, HandoffEnabled: true}, "task")
			},
			wantStop:   "error",
			wantStatus: "error",
			wantErr:    true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := tt.run(t)
			if tt.wantErr && err == nil {
				t.Fatal("expected Run error")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("Run error: %v", err)
			}
			if result == nil {
				t.Fatal("result is nil")
			}
			if result.StopReason != tt.wantStop {
				t.Fatalf("stop reason = %s, want %s", result.StopReason, tt.wantStop)
			}
			if result.Handoff == nil {
				t.Fatal("handoff was not generated")
			}
			if !handoffFact(result, "terminalStatus", tt.wantStatus) && result.Handoff.Summary == "" {
				t.Fatalf("handoff missing status %q: %#v", tt.wantStatus, result.Handoff)
			}
		})
	}
}

type firstCallErrorProvider struct {
	calls int
}

func (p *firstCallErrorProvider) SendMessage(context.Context, []llm.Message, []llm.ToolDefinition) (*llm.Response, error) {
	p.calls++
	if p.calls == 1 {
		return nil, errors.New("primary LLM failed")
	}
	return &llm.Response{Content: `not json`}, nil
}

func handoffFact(result *Result, key, value string) bool {
	if result == nil || result.Handoff == nil {
		return false
	}
	for _, fact := range result.Handoff.Facts {
		if fact.Key == key && fact.Value == value {
			return true
		}
	}
	return false
}
