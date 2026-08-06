package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/tools"
	"github.com/workspace/harness/transcript"
)

func TestRun_NoToolCalls(t *testing.T) {
	provider := llm.NewMockProvider(
		&llm.Response{Content: "The answer is 42."},
	)
	registry := tools.NewRegistry()
	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns: 5,
	}, "What is the meaning of life?")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}
	if result.TurnsUsed != 1 {
		t.Errorf("turns_used = %d, want 1", result.TurnsUsed)
	}
	if result.FinalMessage != "The answer is 42." {
		t.Errorf("final_message = %q, want %q", result.FinalMessage, "The answer is 42.")
	}
}

func TestRun_ToolCallThenComplete(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "test.txt"), []byte("hello world"), 0o644)

	provider := llm.NewMockProvider(
		// Turn 1: ask to read a file
		&llm.Response{
			Content: "Let me read the file.",
			ToolCalls: []llm.ToolCall{{
				ID:     "call-1",
				Name:   "read_file",
				Params: map[string]any{"path": "test.txt"},
			}},
		},
		// Turn 2: respond with summary
		&llm.Response{Content: "The file contains 'hello world'."},
	)

	registry := tools.NewRegistry()
	registry.Register(&tools.ReadFile{WorkDir: dir})

	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns: 5,
	}, "Read test.txt")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}
	if result.TurnsUsed != 2 {
		t.Errorf("turns_used = %d, want 2", result.TurnsUsed)
	}
	if result.FinalMessage != "The file contains 'hello world'." {
		t.Errorf("final_message = %q", result.FinalMessage)
	}

	// Verify transcript recorded events.
	events := log.Events()
	if len(events) == 0 {
		t.Fatal("no transcript events recorded")
	}

	// Should have: LLMRequest(1), LLMResponse(1), ToolCall(1), ToolResult(1), LLMRequest(2), LLMResponse(2)
	types := make([]transcript.EventType, len(events))
	for i, e := range events {
		types[i] = e.Type
	}
	expected := []transcript.EventType{
		transcript.EventLLMRequest, transcript.EventLLMResponse,
		transcript.EventToolCall, transcript.EventToolResult,
		transcript.EventLLMRequest, transcript.EventLLMResponse,
	}
	if len(types) != len(expected) {
		t.Fatalf("got %d events, want %d: %v", len(types), len(expected), types)
	}
	for i, exp := range expected {
		if types[i] != exp {
			t.Errorf("event %d: got %s, want %s", i, types[i], exp)
		}
	}
}

func TestRun_RedactsToolParamsFromTranscriptButExecutesRawInputs(t *testing.T) {
	dir := t.TempDir()
	oldCanary := "ghp_oldSecretCanary_1234567890abcdef1234567890abcdef"
	newCanary := "sk-proj-newSecretCanary-abcdefghijklmnopqrstuvwxyz123456"
	bashCanary := "xoxb-bash-canary-123456789012-abcdefghijklmnopqrstuv"
	writeCanary := "-----BEGIN PRIVATE KEY-----\nwrite-file-canary-secret-material\n-----END PRIVATE KEY-----"
	appPath := filepath.Join(dir, "app.env")
	if err := os.WriteFile(appPath, []byte("TOKEN="+oldCanary+"\n"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	provider := llm.NewMockProvider(
		&llm.Response{ToolCalls: []llm.ToolCall{{
			ID:     "write-secret",
			Name:   "write_file",
			Params: map[string]any{"path": "secrets.pem", "content": writeCanary},
		}}},
		&llm.Response{ToolCalls: []llm.ToolCall{{
			ID:   "edit-secret",
			Name: "edit_file",
			Params: map[string]any{
				"path":       "app.env",
				"old_string": oldCanary,
				"new_string": newCanary,
			},
		}}},
		&llm.Response{ToolCalls: []llm.ToolCall{{
			ID:     "bash-secret",
			Name:   "bash",
			Params: map[string]any{"command": "printf '%s' '" + bashCanary + "' > bash-output.txt"},
		}}},
		&llm.Response{Content: "done"},
	)

	registry := tools.NewRegistry()
	registry.Register(&tools.WriteFile{WorkDir: dir})
	registry.Register(&tools.EditFile{WorkDir: dir})
	registry.Register(&tools.Bash{WorkDir: dir})
	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{MaxTurns: 8}, "exercise secret-bearing tools")
	if err != nil {
		t.Fatalf("Run() error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Fatalf("stop reason = %q, want complete", result.StopReason)
	}

	written, err := os.ReadFile(filepath.Join(dir, "secrets.pem"))
	if err != nil {
		t.Fatalf("read written file: %v", err)
	}
	if string(written) != writeCanary {
		t.Fatalf("write_file did not receive raw content")
	}
	updated, err := os.ReadFile(appPath)
	if err != nil {
		t.Fatalf("read edited file: %v", err)
	}
	if !strings.Contains(string(updated), newCanary) || strings.Contains(string(updated), oldCanary) {
		t.Fatalf("edit_file did not receive raw old/new strings; got %q", string(updated))
	}
	bashOut, err := os.ReadFile(filepath.Join(dir, "bash-output.txt"))
	if err != nil {
		t.Fatalf("read bash output file: %v", err)
	}
	if string(bashOut) != bashCanary {
		t.Fatalf("bash did not execute raw command")
	}

	jsonBytes, err := log.JSON()
	if err != nil {
		t.Fatalf("transcript JSON: %v", err)
	}
	jsonText := string(jsonBytes)
	for _, forbidden := range []string{oldCanary, newCanary, bashCanary, writeCanary, "BEGIN PRIVATE KEY", "Authorization: Bearer"} {
		if strings.Contains(jsonText, forbidden) {
			t.Fatalf("transcript JSON leaked %q: %s", forbidden, jsonText)
		}
	}

	var events []transcript.Event
	if err := json.Unmarshal(jsonBytes, &events); err != nil {
		t.Fatalf("unmarshal transcript JSON: %v", err)
	}
	var toolCalls int
	for _, event := range events {
		if event.Type != transcript.EventToolCall {
			continue
		}
		toolCalls++
		data, ok := event.Data.(map[string]any)
		if !ok {
			t.Fatalf("tool call data has type %T, want map", event.Data)
		}
		if data["id"] == "" || data["name"] == "" {
			t.Fatalf("tool call missing id/name: %#v", data)
		}
		if data["params_redacted"] != true {
			t.Fatalf("tool call missing params_redacted=true: %#v", data)
		}
		if data["params_summary_version"] != float64(transcript.ToolParamsSummaryVersion) {
			t.Fatalf("tool call summary version = %#v", data["params_summary_version"])
		}
		params, ok := data["params"].(map[string]any)
		if !ok || len(params) == 0 {
			t.Fatalf("tool call params summary missing: %#v", data["params"])
		}
		for key, rawSummary := range params {
			summary, ok := rawSummary.(map[string]any)
			if !ok {
				t.Fatalf("param %s summary has type %T", key, rawSummary)
			}
			if summary["redacted"] != true {
				t.Fatalf("param %s summary not marked redacted: %#v", key, summary)
			}
			if summary["byte_length"].(float64) <= 0 || len(summary["sha256"].(string)) != 64 {
				t.Fatalf("param %s summary lacks useful length/hash metadata: %#v", key, summary)
			}
		}
	}
	if toolCalls != 3 {
		t.Fatalf("tool call events = %d, want 3", toolCalls)
	}
}

func TestRun_MaxTurns(t *testing.T) {
	// Provider always returns tool calls, never stops.
	responses := make([]*llm.Response, 5)
	for i := range responses {
		responses[i] = &llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "call",
				Name:   "echo",
				Params: map[string]any{"text": "loop"},
			}},
		}
	}
	provider := llm.NewMockProvider(responses...)

	registry := tools.NewRegistry()
	registry.Register(&echoTool{})

	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns: 3,
	}, "loop forever")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "max_turns" {
		t.Errorf("stop_reason = %s, want max_turns", result.StopReason)
	}
	if result.TurnsUsed != 3 {
		t.Errorf("turns_used = %d, want 3", result.TurnsUsed)
	}
}

func TestRun_Cancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	provider := llm.NewMockProvider(&llm.Response{Content: "never reached"})
	registry := tools.NewRegistry()
	log := transcript.NewLog()

	result, err := Run(ctx, provider, registry, log, Config{}, "test")
	if err == nil {
		t.Fatal("expected error on cancelled context")
	}
	if result.StopReason != "cancelled" {
		t.Errorf("stop_reason = %s, want cancelled", result.StopReason)
	}
}

func TestRun_RetriesTransientProviderErrorAndLogsTranscriptEvent(t *testing.T) {
	t.Parallel()

	provider := newAgentScriptedProvider(
		agentScriptedProviderStep{err: errors.New(`Internal error: API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}`)},
		agentScriptedProviderStep{resp: &llm.Response{Content: "recovered"}},
	)
	registry := tools.NewRegistry()
	log := transcript.NewLog()
	var callbackEvents []llm.RetryEvent

	result, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns: 5,
		LLMRetry: llm.RetryConfig{
			MaxRetries:   2,
			InitialDelay: time.Millisecond,
			MaxDelay:     time.Millisecond,
			Sleeper: func(ctx context.Context, _ time.Duration) error {
				select {
				case <-ctx.Done():
					return ctx.Err()
				default:
					return nil
				}
			},
			OnRetry: func(event llm.RetryEvent) {
				callbackEvents = append(callbackEvents, event)
			},
		},
	}, "recover")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}
	if got := provider.CallCount(); got != 2 {
		t.Fatalf("provider call count = %d, want 2", got)
	}
	if len(callbackEvents) != 1 {
		t.Fatalf("configured retry callback events = %d, want 1", len(callbackEvents))
	}

	var sawRetry bool
	for _, event := range log.Events() {
		data, ok := event.Data.(map[string]any)
		if event.Type == transcript.EventInfo && ok && data["event"] == "llm_retry" {
			sawRetry = true
			if data["retry_attempt"] != 2 {
				t.Fatalf("retry_attempt = %#v, want 2", data["retry_attempt"])
			}
		}
	}
	if !sawRetry {
		t.Fatal("transcript did not include llm_retry info event")
	}
}

func TestRun_ScriptedEditWorkflow(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "app.py"), []byte("print('hello')"), 0o644)

	provider := llm.NewMockProvider(
		// Turn 1: read the file
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c1",
				Name:   "read_file",
				Params: map[string]any{"path": "app.py"},
			}},
		},
		// Turn 2: edit the file
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:   "c2",
				Name: "edit_file",
				Params: map[string]any{
					"path":       "app.py",
					"old_string": "print('hello')",
					"new_string": "print('goodbye')",
				},
			}},
		},
		// Turn 3: verify with bash
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c3",
				Name:   "bash",
				Params: map[string]any{"command": "cat app.py"},
			}},
		},
		// Turn 4: done
		&llm.Response{Content: "File has been updated to print goodbye."},
	)

	registry := tools.NewRegistry()
	registry.Register(&tools.ReadFile{WorkDir: dir})
	registry.Register(&tools.EditFile{WorkDir: dir})
	registry.Register(&tools.Bash{WorkDir: dir})

	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{
		MaxTurns: 10,
	}, "Change hello to goodbye in app.py")

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}
	if result.TurnsUsed != 4 {
		t.Errorf("turns_used = %d, want 4", result.TurnsUsed)
	}

	// Verify the file was actually edited.
	data, _ := os.ReadFile(filepath.Join(dir, "app.py"))
	if !strings.Contains(string(data), "goodbye") {
		t.Error("file was not edited")
	}
}

// echoTool for testing max_turns
type echoTool struct{}

func (e *echoTool) Name() string        { return "echo" }
func (e *echoTool) Description() string { return "echo" }
func (e *echoTool) Schema() map[string]any {
	return map[string]any{"type": "object", "properties": map[string]any{"text": map[string]any{"type": "string"}}}
}
func (e *echoTool) Execute(_ context.Context, params map[string]any) (string, error) {
	return "echoed", nil
}

type agentScriptedProviderStep struct {
	resp *llm.Response
	err  error
}

type agentScriptedProvider struct {
	mu    sync.Mutex
	steps []agentScriptedProviderStep
	calls int
}

func newAgentScriptedProvider(steps ...agentScriptedProviderStep) *agentScriptedProvider {
	return &agentScriptedProvider{steps: steps}
}

func (p *agentScriptedProvider) SendMessage(_ context.Context, _ []llm.Message, _ []llm.ToolDefinition) (*llm.Response, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	index := p.calls
	p.calls++
	if index >= len(p.steps) {
		return nil, errors.New("agent scripted provider exhausted")
	}
	step := p.steps[index]
	return step.resp, step.err
}

func (p *agentScriptedProvider) CallCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls
}
