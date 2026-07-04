package handoff

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/transcript"
)

type errorProvider struct{}

func (errorProvider) SendMessage(context.Context, []llm.Message, []llm.ToolDefinition) (*llm.Response, error) {
	return nil, errors.New("summary unavailable")
}

func TestGenerateHappyPathPlatformJSONKeys(t *testing.T) {
	log := transcript.NewLog()
	log.Append(transcript.EventToolCall, 1, map[string]any{
		"id":     "write-1",
		"name":   "write_file",
		"params": map[string]any{"path": "src/app.go"},
	})
	log.Append(transcript.EventToolResult, 1, map[string]any{
		"call_id":  "write-1",
		"is_error": false,
		"content":  "Created src/app.go",
	})

	provider := llm.NewMockProvider(&llm.Response{Content: `{
		"summary": "Implemented the requested change.",
		"facts": [{"key": "tests", "value": "go test passed"}],
		"openQuestions": ["None"],
		"suggestedActions": ["Open a PR"]
	}`})

	packet := Generate(context.Background(), provider, Input{
		MissionID:      "mission-1",
		FromTaskID:     "task-1",
		TaskPrompt:     "implement feature",
		TerminalStatus: StatusSuccess,
		StopReason:     "complete",
		TurnsUsed:      2,
		Transcript:     log,
		TranscriptPath: "runs/session.json",
		Now:            time.UnixMilli(1710000000000),
	})

	if packet.Summary != "Implemented the requested change." {
		t.Fatalf("summary = %q", packet.Summary)
	}
	if len(packet.Facts) != 1 || packet.Facts[0].Key != "tests" {
		t.Fatalf("facts = %#v", packet.Facts)
	}
	if len(packet.ArtifactRefs) != 2 {
		t.Fatalf("artifact refs = %#v", packet.ArtifactRefs)
	}

	data, err := json.Marshal(packet)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		t.Fatalf("unmarshal keys: %v", err)
	}
	for _, key := range []string{
		"id", "missionId", "fromTaskId", "toTaskId", "summary", "facts",
		"openQuestions", "artifactRefs", "suggestedActions", "version", "createdAt",
	} {
		if _, ok := keys[key]; !ok {
			t.Fatalf("missing platform JSON key %q in %s", key, data)
		}
	}
}

func TestGenerateLLMFailureUsesMechanicalFallback(t *testing.T) {
	packet := Generate(context.Background(), errorProvider{}, Input{
		TaskPrompt:     "fix flaky test",
		TerminalStatus: StatusError,
		StopReason:     "error",
		TurnsUsed:      3,
		Now:            time.UnixMilli(1710000000000),
	})

	if !strings.Contains(packet.Summary, "fix flaky test") {
		t.Fatalf("fallback summary did not include task prompt: %q", packet.Summary)
	}
	if !strings.Contains(packet.Summary, "status error after 3 turns") {
		t.Fatalf("fallback summary did not include status/turns: %q", packet.Summary)
	}
	if !hasFact(packet.Facts, "handoffGeneration") {
		t.Fatalf("fallback facts missing handoffGeneration: %#v", packet.Facts)
	}
}

func TestGenerateMalformedJSONUsesMechanicalFallback(t *testing.T) {
	provider := llm.NewMockProvider(&llm.Response{Content: "not json"})
	packet := Generate(context.Background(), provider, Input{
		TaskPrompt:     "continue work",
		TerminalStatus: StatusIncomplete,
		StopReason:     "max_turns",
		TurnsUsed:      5,
		Now:            time.UnixMilli(1710000000000),
	})

	if packet.Summary == "not json" {
		t.Fatal("malformed LLM content was used as summary")
	}
	if !hasFactValue(packet.Facts, "terminalStatus", "incomplete") {
		t.Fatalf("fallback facts = %#v", packet.Facts)
	}
}

func hasFact(facts []Fact, key string) bool {
	for _, fact := range facts {
		if fact.Key == key {
			return true
		}
	}
	return false
}

func hasFactValue(facts []Fact, key, value string) bool {
	for _, fact := range facts {
		if fact.Key == key && fact.Value == value {
			return true
		}
	}
	return false
}
