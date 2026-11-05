package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// steerFakeAgent is an ACP agent across the host's real pipes. Prompts park
// until answered; each `_session/steering` request is handed to the test,
// which decides when and how the agent answers it.
type steerFakeAgent struct {
	reader  *bufio.Reader
	writer  *io.PipeWriter
	writeMu sync.Mutex
	prompts chan json.RawMessage
	steers  chan steerRequestSeen
}

type steerRequestSeen struct {
	id     json.RawMessage
	params map[string]any
}

func (a *steerFakeAgent) serve() {
	for {
		line, err := a.reader.ReadBytes('\n')
		if err != nil {
			return
		}
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params map[string]any  `json:"params"`
		}
		if json.Unmarshal(line, &msg) != nil {
			continue
		}
		switch msg.Method {
		case "session/prompt":
			a.prompts <- append(json.RawMessage(nil), msg.ID...)
		case steeringMethod:
			a.steers <- steerRequestSeen{id: append(json.RawMessage(nil), msg.ID...), params: msg.Params}
		}
	}
}

func (a *steerFakeAgent) write(v any) {
	data, _ := json.Marshal(v)
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	_, _ = a.writer.Write(append(data, '\n'))
}

func (a *steerFakeAgent) result(id json.RawMessage, result any) {
	a.write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func (a *steerFakeAgent) fail(id json.RawMessage, code int) {
	a.write(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": "refused"}})
}

func (a *steerFakeAgent) nextPrompt(t *testing.T) json.RawMessage {
	t.Helper()
	select {
	case id := <-a.prompts:
		return id
	case <-time.After(2 * time.Second):
		t.Fatal("fake agent did not receive session/prompt")
		return nil
	}
}

func (a *steerFakeAgent) nextSteer(t *testing.T) steerRequestSeen {
	t.Helper()
	select {
	case steer := <-a.steers:
		return steer
	case <-time.After(2 * time.Second):
		t.Fatal("fake agent did not receive _session/steering")
		return steerRequestSeen{}
	}
}

func (a *steerFakeAgent) assertNoSteer(t *testing.T) {
	t.Helper()
	select {
	case steer := <-a.steers:
		t.Fatalf("adapter received an unexpected steer: %v", steer.params)
	case <-time.After(100 * time.Millisecond):
	}
}

type steerHarness struct {
	host        *SessionHost
	agent       *steerFakeAgent
	reporter    *mockMessageReporter
	completions chan promptCompletion
}

func newSteerHarness(t *testing.T, support steeringSupport) *steerHarness {
	t.Helper()
	completions := make(chan promptCompletion, 8)
	reporter := &mockMessageReporter{}
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:       "test-session",
			WorkspaceID:     "test-workspace",
			ErrorReporter:   &lifecycleRecorder{},
			MessageReporter: reporter,
			SteerTimeout:    300 * time.Millisecond,
			OnPromptComplete: func(stopReason string, err error) {
				completions <- promptCompletion{stopReason: stopReason, err: err}
			},
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	process, agentReader, agentWriter := newFakeAgentProcess(time.Now().Add(-time.Minute), false)
	agent := &steerFakeAgent{
		reader:  bufio.NewReader(agentReader),
		writer:  agentWriter,
		prompts: make(chan json.RawMessage, 4),
		steers:  make(chan steerRequestSeen, 4),
	}
	go agent.serve()
	t.Cleanup(func() {
		host.mu.Lock()
		host.process = nil
		host.mu.Unlock()
		host.Stop()
		_ = agentReader.Close()
		_ = agentWriter.Close()
		_ = process.stdin.Close()
		_ = process.stdout.Close()
	})
	acpConn := acpsdk.NewClientSideConnection(&sessionHostClient{host: host}, process.stdin, process.stdout)
	host.mu.Lock()
	host.agentType = "claude-code"
	host.process = process
	host.acpConn = acpConn
	host.steering = support
	host.setSessionIDLocked("acp-session-steer")
	host.setStatusLocked(HostReady)
	host.mu.Unlock()
	return &steerHarness{host: host, agent: agent, reporter: reporter, completions: completions}
}

var verifiedSteering = steeringSupport{Advertised: true, PromptRequired: true,
	Adapter: "@agentclientprotocol/claude-agent-acp", Version: "0.81.2"}

// startTurn runs a real prompt through the production gate and returns its
// request ID with the attempt the host is executing.
func (h *steerHarness) startTurn(t *testing.T) (json.RawMessage, *promptAttempt) {
	t.Helper()
	params, _ := json.Marshal(map[string]any{"prompt": []map[string]string{{"type": "text", "text": "long task"}}})
	go h.host.HandlePrompt(context.Background(), json.RawMessage(`"req-1"`), params, "control-plane", false)
	id := h.agent.nextPrompt(t)
	attempt, ok := h.host.activePromptAttempt()
	if !ok {
		t.Fatal("prompt attempt is not in flight")
	}
	return id, attempt
}

type steerCall struct {
	result     SteerResult
	claimed    bool
	claimEpoch int64
}

func (h *steerHarness) steerAsync(text, messageID string, claimErr error) chan steerCall {
	done := make(chan steerCall, 1)
	go func() {
		call := steerCall{}
		call.result = h.host.Steer(text, messageID, func(epoch int64) error {
			call.claimed, call.claimEpoch = true, epoch
			return claimErr
		})
		done <- call
	}()
	return done
}

func awaitSteer(t *testing.T, done chan steerCall) steerCall {
	t.Helper()
	select {
	case call := <-done:
		return call
	case <-time.After(2 * time.Second):
		t.Fatal("Steer did not return")
		return steerCall{}
	}
}

func (h *steerHarness) nextCompletion(t *testing.T) promptCompletion {
	t.Helper()
	select {
	case c := <-h.completions:
		return c
	case <-time.After(2 * time.Second):
		t.Fatal("prompt did not complete")
		return promptCompletion{}
	}
}

func (h *steerHarness) assertNoCompletion(t *testing.T) {
	t.Helper()
	select {
	case c := <-h.completions:
		t.Fatalf("unexpected prompt completion: %+v", c)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestSteeringSupportFromInitialize(t *testing.T) {
	advertised := map[string]any{"steering": map[string]any{"supported": true}}
	withIdle := map[string]any{"steering": map[string]any{"supported": true, "idleBehaviors": []any{"promptRequired"}}}
	cases := []struct {
		name                  string
		adapter, version      string
		meta                  map[string]any
		advertised, supported bool
	}{
		{"claude pinned", "@agentclientprotocol/claude-agent-acp", "0.81.2", advertised, true, true},
		{"claude newer", "@agentclientprotocol/claude-agent-acp", "0.90.0", advertised, true, true},
		{"claude before promptRequired", "@agentclientprotocol/claude-agent-acp", "0.80.9", advertised, true, false},
		{"stock codex 2.1.1 starts detached turns", "@agentclientprotocol/codex-acp", "2.1.1", advertised, true, false},
		{"sam codex c2.2 lacks backport", "@agentclientprotocol/codex-acp", "2.1.1-sam-c2.2", advertised, true, false},
		{"sam codex c2.3 backport", "@agentclientprotocol/codex-acp", "2.1.1-sam-c2.3", advertised, true, true},
		{"codex 2.4.0 upstream", "@agentclientprotocol/codex-acp", "2.4.0", advertised, true, true},
		{"codex preview needs allowlist", "@agentclientprotocol/codex-acp", "2.5.1-preview.22", advertised, true, false},
		{"sam opencode advertises idle behavior", "OpenCode", "2.2.5-sam-s1", withIdle, true, true},
		{"upstream opencode has no steering", "OpenCode", "2.2.5", nil, false, false},
		{"unknown adapter advertising only support", "other-acp", "1.0.0", advertised, true, false},
		{"supported false", "@agentclientprotocol/claude-agent-acp", "0.81.2",
			map[string]any{"steering": map[string]any{"supported": false}}, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := steeringSupportFromInitialize(acpsdk.InitializeResponse{
				AgentInfo: &acpsdk.Implementation{Name: tc.adapter, Version: tc.version},
				Meta:      tc.meta,
			})
			if got.Advertised != tc.advertised || (got.Advertised && got.PromptRequired) != tc.supported {
				t.Fatalf("support = %+v, want advertised=%v supported=%v", got, tc.advertised, tc.supported)
			}
		})
	}
}

func TestSteerInjectsIntoRunningTurnWithoutStartingAnEpoch(t *testing.T) {
	h := newSteerHarness(t, verifiedSteering)
	promptID, attempt := h.startTurn(t)

	done := h.steerAsync("use tabs, not spaces", "msg-steer-1", nil)
	seen := h.agent.nextSteer(t)
	if seen.params["sessionId"] != "acp-session-steer" {
		t.Fatalf("steer sessionId = %v", seen.params["sessionId"])
	}
	meta, _ := seen.params["_meta"].(map[string]any)
	steering, _ := meta["steering"].(map[string]any)
	if steering["idleBehavior"] != "promptRequired" {
		t.Fatalf("steer must always request promptRequired idle behavior, got %v", seen.params["_meta"])
	}
	prompt, _ := seen.params["prompt"].([]any)
	block, _ := prompt[0].(map[string]any)
	if block["text"] != "use tabs, not spaces" {
		t.Fatalf("steer prompt = %v", seen.params["prompt"])
	}
	h.agent.result(seen.id, map[string]any{"outcome": "injected"})
	call := awaitSteer(t, done)

	if call.result.Outcome != SteerInjected || !call.claimed {
		t.Fatalf("result = %+v claimed=%v", call.result, call.claimed)
	}
	if want := attempt.startedAt.UnixMilli(); call.claimEpoch != want || call.result.PromptEpoch != want {
		t.Fatalf("steer epoch claim=%d result=%d, want attached attempt %d", call.claimEpoch, call.result.PromptEpoch, want)
	}
	current, ok := h.host.activePromptAttempt()
	if !ok || current != attempt || h.host.Status() != HostPrompting {
		t.Fatalf("steer changed the running turn: attempt=%v ok=%v status=%s", current, ok, h.host.Status())
	}
	h.assertNoCompletion(t)
	h.reporter.mu.Lock()
	mirrored := len(h.reporter.messages) > 0 && h.reporter.messages[len(h.reporter.messages)-1].MessageID == "msg-steer-1"
	h.reporter.mu.Unlock()
	if !mirrored {
		t.Fatal("steered text was not mirrored under the transcript message ID")
	}

	h.agent.result(promptID, map[string]any{"stopReason": "end_turn"})
	if c := h.nextCompletion(t); c.stopReason != "end_turn" {
		t.Fatalf("completion = %+v", c)
	}
	h.assertNoCompletion(t)
}

func TestSteerWithoutRunningTurnNeverContactsAdapter(t *testing.T) {
	h := newSteerHarness(t, verifiedSteering)
	call := awaitSteer(t, h.steerAsync("hello", "msg-1", nil))
	if call.result.Outcome != SteerPromptRequired || call.result.Consumed() || call.claimed {
		t.Fatalf("idle steer = %+v claimed=%v", call.result, call.claimed)
	}
	h.agent.assertNoSteer(t)
}

func TestSteerUnverifiedAdapterNeverSends(t *testing.T) {
	for _, support := range []steeringSupport{
		{},
		{Advertised: true, Adapter: "@agentclientprotocol/codex-acp", Version: "2.1.1"},
	} {
		h := newSteerHarness(t, support)
		_, _ = h.startTurn(t)
		call := awaitSteer(t, h.steerAsync("x", "m", nil))
		if call.result.Outcome != SteerUnsupported || call.claimed || call.result.Consumed() {
			t.Fatalf("support %+v: result = %+v claimed=%v", support, call.result, call.claimed)
		}
		h.agent.assertNoSteer(t)
	}
}

func TestSteerRacingTurnEndIsNotConsumed(t *testing.T) {
	h := newSteerHarness(t, verifiedSteering)
	_, _ = h.startTurn(t)
	done := h.steerAsync("late", "m", nil)
	seen := h.agent.nextSteer(t)
	h.agent.result(seen.id, map[string]any{"outcome": "promptRequired", "reason": "noRunningTurn"})
	call := awaitSteer(t, done)
	if call.result.Outcome != SteerPromptRequired || call.result.Consumed() {
		t.Fatalf("result = %+v", call.result)
	}
}

func TestSteerClaimFailureSendsNothing(t *testing.T) {
	h := newSteerHarness(t, verifiedSteering)
	_, _ = h.startTurn(t)
	call := awaitSteer(t, h.steerAsync("x", "m", errors.New("receipt store unavailable")))
	if call.result.Outcome != SteerNotClaimed || call.result.Consumed() {
		t.Fatalf("result = %+v", call.result)
	}
	h.agent.assertNoSteer(t)
}

func TestSteerRefusesCancellingTurn(t *testing.T) {
	h := newSteerHarness(t, verifiedSteering)
	_, _ = h.startTurn(t)
	h.host.promptCancelMu.Lock()
	h.host.promptCancelRequested = true
	h.host.promptCancelMu.Unlock()
	call := awaitSteer(t, h.steerAsync("x", "m", nil))
	if call.result.Outcome != SteerPromptRequired || call.result.Reason != "turn_cancelling" || call.claimed {
		t.Fatalf("result = %+v claimed=%v", call.result, call.claimed)
	}
	h.agent.assertNoSteer(t)
}

func TestSteerAdapterResponsesClassifyConsumption(t *testing.T) {
	cases := []struct {
		name     string
		reply    func(a *steerFakeAgent, id json.RawMessage)
		outcome  SteerOutcome
		consumed bool
	}{
		{"invalid params", func(a *steerFakeAgent, id json.RawMessage) { a.fail(id, -32602) }, SteerRejected, false},
		{"method not found", func(a *steerFakeAgent, id json.RawMessage) { a.fail(id, -32601) }, SteerRejected, false},
		{"internal error", func(a *steerFakeAgent, id json.RawMessage) { a.fail(id, -32603) }, SteerUnknown, true},
		{"codex failed", func(a *steerFakeAgent, id json.RawMessage) { a.result(id, map[string]any{"outcome": "failed"}) }, SteerUnknown, true},
		{"detached turn", func(a *steerFakeAgent, id json.RawMessage) {
			a.result(id, map[string]any{"outcome": "startedNewTurn"})
		}, SteerUnknown, true},
		{"no reply before timeout", func(*steerFakeAgent, json.RawMessage) {}, SteerUnknown, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newSteerHarness(t, verifiedSteering)
			_, _ = h.startTurn(t)
			done := h.steerAsync("x", "m", nil)
			tc.reply(h.agent, h.agent.nextSteer(t).id)
			call := awaitSteer(t, done)
			if call.result.Outcome != tc.outcome || call.result.Consumed() != tc.consumed {
				t.Fatalf("result = %+v, want %s consumed=%v", call.result, tc.outcome, tc.consumed)
			}
		})
	}
}

func TestSteersAreSentOneAtATimeAndNeverHoldThePromptGate(t *testing.T) {
	h := newSteerHarness(t, verifiedSteering)
	promptID, _ := h.startTurn(t)

	first := h.steerAsync("first", "m1", nil)
	firstSeen := h.agent.nextSteer(t)
	second := h.steerAsync("second", "m2", nil)
	h.agent.assertNoSteer(t)

	// The turn can still finish while a steer request is outstanding.
	h.agent.result(promptID, map[string]any{"stopReason": "end_turn"})
	if c := h.nextCompletion(t); c.stopReason != "end_turn" {
		t.Fatalf("completion = %+v", c)
	}
	h.agent.result(firstSeen.id, map[string]any{"outcome": "promptRequired", "reason": "noRunningTurn"})
	if call := awaitSteer(t, first); call.result.Outcome != SteerPromptRequired {
		t.Fatalf("first = %+v", call.result)
	}
	// The second steer was admitted only after the first returned, by which
	// time no turn was running, so it never reached the adapter.
	if call := awaitSteer(t, second); call.result.Outcome != SteerPromptRequired || call.claimed {
		t.Fatalf("second = %+v claimed=%v", call.result, call.claimed)
	}
	h.agent.assertNoSteer(t)
}
