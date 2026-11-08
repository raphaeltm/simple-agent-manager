package acp

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// These opt-in tests drive the SHIPPED adapter builds through the real
// SessionHost steering path against a local mock model, so they need no API
// key and never contact a provider. Each proves the same thing: a steer sent
// while the first model call of a turn is in flight reaches a later model call
// of the SAME turn, and the turn completes exactly once afterwards.

const steerProbeText = "STEER-PROBE: name the file notes.md, not todo.md"

// steerModel is a mock provider: the first request of a turn is held until the
// test releases it; every request body is recorded.
type steerModel struct {
	t        *testing.T
	mu       sync.Mutex
	bodies   []string
	firstIn  chan struct{}
	release  chan struct{}
	respond  func(w http.ResponseWriter, call int, body string)
	once     sync.Once
	matchURL func(path string) bool
	// hold selects the turn request to park; nil parks the first request.
	hold     func(body string) bool
	heldCall int
}

func newSteerModel(t *testing.T, matchURL func(string) bool, respond func(http.ResponseWriter, int, string)) (*steerModel, *httptest.Server) {
	m := &steerModel{t: t, firstIn: make(chan struct{}), release: make(chan struct{}), respond: respond, matchURL: matchURL}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !m.matchURL(r.URL.Path) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{}`)
			return
		}
		data, _ := io.ReadAll(io.LimitReader(r.Body, 4<<20))
		m.mu.Lock()
		m.bodies = append(m.bodies, string(data))
		call := len(m.bodies)
		m.mu.Unlock()
		m.mu.Lock()
		shouldHold := m.heldCall == 0 && (m.hold == nil || m.hold(string(data)))
		if shouldHold {
			m.heldCall = call
		}
		m.mu.Unlock()
		if shouldHold {
			m.once.Do(func() { close(m.firstIn) })
			select {
			case <-m.release:
			case <-r.Context().Done():
				return
			}
		}
		m.respond(w, call, string(data))
	}))
	t.Cleanup(server.Close)
	return m, server
}

func (m *steerModel) calls() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.bodies...)
}

type realAdapterSteerCase struct {
	agentType string
	command   string
	args      []string
	env       []string
	cwd       string
}

// runRealAdapterSteer starts the adapter, opens a session, runs one prompt
// through HandlePrompt and steers it while the first model call is held.
func runRealAdapterSteer(t *testing.T, tc realAdapterSteerCase, model *steerModel) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	completions := make(chan promptCompletion, 4)
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
		SessionID:       "steer-real",
		WorkspaceID:     "steer-real",
		ErrorReporter:   &lifecycleRecorder{},
		MessageReporter: &mockMessageReporter{},
		OnPromptComplete: func(stopReason string, err error) {
			completions <- promptCompletion{stopReason: stopReason, err: err}
		},
	}, MessageBufferSize: 200, ViewerSendBuffer: 64})
	defer host.Stop()

	cmd := exec.CommandContext(ctx, tc.command, tc.args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Env = append(os.Environ(), tc.env...)
	cmd.Dir = tc.cwd
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
	}()

	client := acpsdk.NewClientSideConnection(&sessionHostClient{host: host}, stdin, stdout)
	host.mu.Lock()
	host.acpConn = client
	host.agentType = tc.agentType
	if _, err := host.initializeACP(ctx, tc.agentType, 30*time.Second); err != nil {
		host.mu.Unlock()
		t.Fatalf("initialize: %v", err)
	}
	support := host.steering
	host.mu.Unlock()
	if !support.Advertised || !support.PromptRequired {
		t.Fatalf("shipped adapter %s %s did not prove steering support: %+v", support.Adapter, support.Version, support)
	}
	t.Logf("adapter %s %s: steering advertised, promptRequired verified", support.Adapter, support.Version)

	session, err := client.NewSession(ctx, acpsdk.NewSessionRequest{Cwd: tc.cwd, McpServers: []acpsdk.McpServer{}})
	if err != nil {
		t.Fatalf("new session: %v", err)
	}
	host.mu.Lock()
	host.setSessionIDLocked(session.SessionId)
	host.setStatusLocked(HostReady)
	host.mu.Unlock()

	// A steer with no running turn is returned unconsumed by the real adapter.
	idle := host.Steer("idle probe", "msg-idle", func(int64) error { return nil })
	if idle.Outcome != SteerPromptRequired {
		t.Fatalf("idle steer = %+v, want prompt_required", idle)
	}

	params, _ := json.Marshal(map[string]any{"prompt": []map[string]string{{"type": "text", "text": "Create a todo file for the project."}}})
	go host.HandlePrompt(context.Background(), json.RawMessage(`"real-1"`), params, "control-plane", false)
	select {
	case <-model.firstIn:
	case <-ctx.Done():
		t.Fatal("the adapter never called the model")
	}
	attempt, ok := host.activePromptAttempt()
	if !ok {
		t.Fatal("no prompt in flight while the model call is held")
	}

	steer := host.Steer(steerProbeText, "msg-steer", func(int64) error { return nil })
	if steer.Outcome != SteerInjected {
		t.Fatalf("steer during the turn = %+v, want injected", steer)
	}
	if steer.PromptEpoch != attempt.startedAt.UnixMilli() {
		t.Fatalf("steer attached to epoch %d, want %d", steer.PromptEpoch, attempt.startedAt.UnixMilli())
	}
	if current, ok := host.activePromptAttempt(); !ok || current != attempt {
		t.Fatal("steering changed the running prompt attempt")
	}
	select {
	case c := <-completions:
		t.Fatalf("turn completed before the held model call returned: %+v", c)
	default:
	}
	close(model.release)

	var completion promptCompletion
	select {
	case completion = <-completions:
	case <-ctx.Done():
		t.Fatalf("turn never completed; model calls=%d", len(model.calls()))
	}
	if completion.err != nil {
		t.Fatalf("turn failed: %+v", completion)
	}
	calls := model.calls()
	steeredCall := -1
	for i, body := range calls {
		if strings.Contains(body, "STEER-PROBE") {
			steeredCall = i
			break
		}
	}
	model.mu.Lock()
	held := model.heldCall
	model.mu.Unlock()
	if steeredCall < held {
		t.Fatalf("no model call after the held turn call %d carried the steer (calls=%d)", held, len(calls))
	}
	t.Logf("steer reached model call %d of %d inside one turn (stopReason=%s)", steeredCall+1, len(calls), completion.stopReason)
	if os.Getenv("SAM_STEER_DEBUG") != "" {
		for i, body := range calls {
			t.Logf("call %d: %.400s", i+1, body)
		}
	}
	select {
	case c := <-completions:
		t.Fatalf("second completion for one turn: %+v", c)
	case <-time.After(300 * time.Millisecond):
	}
}

func sseEvents(w http.ResponseWriter, events ...map[string]any) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, event := range events {
		data, _ := json.Marshal(event)
		_, _ = io.WriteString(w, "event: "+event["type"].(string)+"\ndata: "+string(data)+"\n\n")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
}

func TestShippedCodexAdapterSteersRunningTurn(t *testing.T) {
	adapter, cli := os.Getenv("SAM_STEER_CODEX_ADAPTER"), os.Getenv("SAM_STEER_CODEX_CLI")
	if adapter == "" || cli == "" {
		t.Skip("set SAM_STEER_CODEX_ADAPTER and SAM_STEER_CODEX_CLI to the shipped c2.3 adapter.js and codex binary")
	}
	model, server := newSteerModel(t, func(p string) bool { return strings.HasSuffix(p, "/responses") },
		func(w http.ResponseWriter, call int, body string) {
			id := "response-" + string(rune('0'+call))
			text := "Working on it."
			if strings.Contains(body, "STEER-PROBE") {
				text = "Using notes.md as requested."
			}
			sseEvents(w,
				map[string]any{"type": "response.created", "response": map[string]any{"id": id}},
				map[string]any{"type": "response.output_item.done", "item": map[string]any{
					"type": "message", "role": "assistant", "id": "msg-" + id,
					"content": []any{map[string]any{"type": "output_text", "text": text}}}},
				map[string]any{"type": "response.completed", "response": map[string]any{"id": id,
					"usage": map[string]any{"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}},
			)
		})
	home := t.TempDir()
	config := "model = \"gpt-6.1-sol\"\napproval_policy = \"never\"\nsandbox_mode = \"danger-full-access\"\n" +
		"model_provider = \"mock_provider\"\n[model_providers.mock_provider]\nname = \"Mock\"\n" +
		"base_url = \"" + server.URL + "/v1\"\nwire_api = \"responses\"\nenv_key = \"PROBE_API_KEY\"\n" +
		"request_max_retries = 0\nstream_max_retries = 0\n"
	if err := os.WriteFile(home+"/config.toml", []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	command, args := adapter, []string{}
	if strings.HasSuffix(adapter, ".js") {
		command, args = "node", []string{adapter}
	}
	runRealAdapterSteer(t, realAdapterSteerCase{
		agentType: "openai-codex", command: command, args: args, cwd: home,
		env: []string{"CODEX_PATH=" + cli, "CODEX_HOME=" + home, "CODEX_API_KEY=probe-only", "PROBE_API_KEY=probe-only"},
	}, model)
}

// openAIChatStream writes an OpenAI-compatible streamed chat completion.
func openAIChatStream(w http.ResponseWriter, text string) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, chunk := range []map[string]any{
		{"id": "c1", "object": "chat.completion.chunk", "model": "probe",
			"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": text}}}},
		{"id": "c1", "object": "chat.completion.chunk", "model": "probe",
			"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "stop"}},
			"usage":   map[string]any{"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
	} {
		data, _ := json.Marshal(chunk)
		_, _ = io.WriteString(w, "data: "+string(data)+"\n\n")
	}
	_, _ = io.WriteString(w, "data: [DONE]\n\n")
}

func TestShippedOpenCodeSteersRunningTurn(t *testing.T) {
	binary := os.Getenv("SAM_STEER_OPENCODE")
	if binary == "" {
		t.Skip("set SAM_STEER_OPENCODE to the shipped opencode 2.2.5-sam-s1 binary")
	}
	model, server := newSteerModel(t,
		// Only the agent's own turn requests; side requests (titles) are answered without holding.
		func(p string) bool { return strings.HasSuffix(p, "/chat/completions") },
		func(w http.ResponseWriter, _ int, body string) {
			text := "Working on it."
			if strings.Contains(body, "STEER-PROBE") {
				text = "Using notes.md as requested."
			}
			openAIChatStream(w, text)
		})
	home := t.TempDir()
	config, _ := json.Marshal(map[string]any{
		"model":       "probe/probe-model",
		"small_model": "probe/probe-model",
		"provider": map[string]any{"probe": map[string]any{
			"npm": "@ai-sdk/openai-compatible", "name": "Probe",
			"options": map[string]any{"baseURL": server.URL + "/v1", "apiKey": "probe-only"},
			"models":  map[string]any{"probe-model": map[string]any{"name": "probe-model"}},
		}},
	})
	runRealAdapterSteer(t, realAdapterSteerCase{
		agentType: "opencode", command: binary, args: []string{"acp"}, cwd: home,
		env: []string{"HOME=" + home, "XDG_CONFIG_HOME=" + home + "/.config", "XDG_DATA_HOME=" + home + "/.local/share",
			"OPENCODE_CONFIG_CONTENT=" + string(config), "OPENCODE_DISABLE_AUTOUPDATE=1"},
	}, model)
}

func anthropicStream(w http.ResponseWriter, text string) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, event := range []map[string]any{
		{"type": "message_start", "message": map[string]any{"id": "msg_probe", "type": "message", "role": "assistant",
			"model": "claude-probe", "content": []any{}, "stop_reason": nil, "stop_sequence": nil,
			"usage": map[string]any{"input_tokens": 1, "output_tokens": 1}}},
		{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}},
		{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": text}},
		{"type": "content_block_stop", "index": 0},
		{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn", "stop_sequence": nil},
			"usage": map[string]any{"output_tokens": 1}},
		{"type": "message_stop"},
	} {
		data, _ := json.Marshal(event)
		_, _ = io.WriteString(w, "event: "+event["type"].(string)+"\ndata: "+string(data)+"\n\n")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
}

func anthropicMessage(w http.ResponseWriter, text string) {
	w.Header().Set("Content-Type", "application/json")
	data, _ := json.Marshal(map[string]any{"id": "msg_probe", "type": "message", "role": "assistant",
		"model": "claude-probe", "content": []any{map[string]any{"type": "text", "text": text}},
		"stop_reason": "end_turn", "stop_sequence": nil, "usage": map[string]any{"input_tokens": 1, "output_tokens": 1}})
	_, _ = w.Write(data)
}

func TestShippedClaudeAdapterSteersRunningTurn(t *testing.T) {
	adapter, claude := os.Getenv("SAM_STEER_CLAUDE_ACP"), os.Getenv("SAM_STEER_CLAUDE_CODE")
	if adapter == "" || claude == "" {
		t.Skip("set SAM_STEER_CLAUDE_ACP (claude-agent-acp 0.81.2 bin) and SAM_STEER_CLAUDE_CODE (claude 2.1.281)")
	}
	const turnMarker = "Create a todo file for the project."
	model, server := newSteerModel(t, func(p string) bool { return strings.HasSuffix(p, "/v1/messages") },
		func(w http.ResponseWriter, _ int, body string) {
			text := "Working on it."
			if strings.Contains(body, "STEER-PROBE") {
				text = "Using notes.md as requested."
			}
			if strings.Contains(body, `"stream":true`) {
				anthropicStream(w, text)
				return
			}
			anthropicMessage(w, text)
		})
	// Park the agent's own turn request, not Claude Code's side requests.
	model.hold = func(body string) bool {
		return strings.Contains(body, turnMarker) && strings.Contains(body, `"tools"`)
	}
	home := t.TempDir()
	runRealAdapterSteer(t, realAdapterSteerCase{
		agentType: "claude-code", command: adapter, cwd: home,
		env: []string{"HOME=" + home, "CLAUDE_CODE_EXECUTABLE=" + claude, "ANTHROPIC_BASE_URL=" + server.URL,
			"ANTHROPIC_API_KEY=probe-only", "DISABLE_TELEMETRY=1", "DISABLE_AUTOUPDATER=1",
			"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "DISABLE_ERROR_REPORTING=1"},
	}, model)
}
