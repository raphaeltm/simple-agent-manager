package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// cancelGraceFakeAgent is an ACP agent on the far side of the host's real
// stdin/stdout pipes. Every session/prompt request is parked until the test
// answers it, and session/cancel notifications are recorded.
type cancelGraceFakeAgent struct {
	t       *testing.T
	reader  *bufio.Reader
	writer  *io.PipeWriter
	prompts chan json.RawMessage
	cancels chan struct{}
	// stopReading makes the agent stop draining stdin after the next prompt,
	// modelling a wedged agent: the SDK's post-cancel session/cancel write then
	// blocks and the cancelled prompt cannot settle on its own.
	stopReading chan struct{}
}

func (a *cancelGraceFakeAgent) serve() {
	for {
		line, err := a.reader.ReadBytes('\n')
		if err != nil {
			return
		}
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if json.Unmarshal(line, &msg) != nil {
			continue
		}
		switch msg.Method {
		case "session/prompt":
			a.prompts <- append(json.RawMessage(nil), msg.ID...)
			select {
			case <-a.stopReading:
				return
			default:
			}
		case "session/cancel":
			a.cancels <- struct{}{}
		}
	}
}

func (a *cancelGraceFakeAgent) respond(id json.RawMessage, stopReason string) {
	data, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"result":  map[string]any{"stopReason": stopReason},
	})
	_, _ = a.writer.Write(append(data, '\n'))
}

func (a *cancelGraceFakeAgent) nextPrompt(t *testing.T) json.RawMessage {
	t.Helper()
	select {
	case id := <-a.prompts:
		return id
	case <-time.After(2 * time.Second):
		t.Fatal("fake agent did not receive a session/prompt")
		return nil
	}
}

// lifecycleRecorder is a goroutine-safe ErrorReporter: lifecycle reports are
// emitted from prompt, cancel, and watchdog goroutines.
type lifecycleRecorder struct {
	mu      sync.Mutex
	reports []lifecycleReport
}

func (r *lifecycleRecorder) record(level, message string, ctx map[string]interface{}) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reports = append(r.reports, lifecycleReport{level: level, message: message, context: ctx})
}

func (r *lifecycleRecorder) ReportError(err error, _ string, _ string, ctx map[string]interface{}) {
	r.record("error", err.Error(), ctx)
}
func (r *lifecycleRecorder) ReportInfo(message, _ string, _ string, ctx map[string]interface{}) {
	r.record("info", message, ctx)
}
func (r *lifecycleRecorder) ReportWarn(message, _ string, _ string, ctx map[string]interface{}) {
	r.record("warn", message, ctx)
}

func (r *lifecycleRecorder) Count(message string) int {
	return len(r.find(message))
}

func (r *lifecycleRecorder) find(message string) []lifecycleReport {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []lifecycleReport
	for _, report := range r.reports {
		if report.message == message {
			out = append(out, report)
		}
	}
	return out
}

type promptCompletion struct {
	stopReason string
	err        error
}

// gatedGraceTimer lets a test own the load-bearing midpoint: the cancel-grace
// deadline fires only when the test releases it.
type gatedGraceTimer struct {
	armed chan chan time.Time
}

func (g *gatedGraceTimer) start(time.Duration) (<-chan time.Time, func()) {
	fire := make(chan time.Time, 1)
	g.armed <- fire
	return fire, func() {}
}

func (g *gatedGraceTimer) awaitArmed(t *testing.T) chan time.Time {
	t.Helper()
	select {
	case fire := <-g.armed:
		return fire
	case <-time.After(2 * time.Second):
		t.Fatal("cancel-grace watchdog was never armed")
		return nil
	}
}

type cancelGraceHarness struct {
	host        *SessionHost
	agent       *cancelGraceFakeAgent
	process     *fakeAgentProcess
	timer       *gatedGraceTimer
	completions chan promptCompletion
	events      *lifecycleRecorder
}

func newCancelGraceHarness(t *testing.T) *cancelGraceHarness {
	t.Helper()
	return newCancelGraceHarnessWithProcess(t, false)
}

// newCancelGraceHarnessWithProcess lets a test choose whether Stop() makes the
// fake agent process exit, which is what lets a real process monitor restart it.
func newCancelGraceHarnessWithProcess(t *testing.T, exitOnStop bool) *cancelGraceHarness {
	t.Helper()
	completions := make(chan promptCompletion, 8)
	events := &lifecycleRecorder{}
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:               "test-session",
			WorkspaceID:             "test-workspace",
			ErrorReporter:           events,
			MessageReporter:         &mockMessageReporter{},
			PromptCancelGracePeriod: 5 * time.Second,
			OnPromptComplete: func(stopReason string, err error) {
				completions <- promptCompletion{stopReason: stopReason, err: err}
			},
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	timer := &gatedGraceTimer{armed: make(chan chan time.Time, 4)}
	host.cancelGraceTimer = timer.start

	process, agentReader, agentWriter := newFakeAgentProcess(time.Now().Add(-time.Minute), exitOnStop)
	agent := &cancelGraceFakeAgent{
		t:           t,
		reader:      bufio.NewReader(agentReader),
		writer:      agentWriter,
		prompts:     make(chan json.RawMessage, 4),
		cancels:     make(chan struct{}, 4),
		stopReading: make(chan struct{}),
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
	host.setSessionIDLocked("acp-session-cancel")
	host.setStatusLocked(HostReady)
	host.mu.Unlock()

	return &cancelGraceHarness{host: host, agent: agent, process: process, timer: timer, completions: completions, events: events}
}

func (h *cancelGraceHarness) nextCompletion(t *testing.T) promptCompletion {
	t.Helper()
	select {
	case c := <-h.completions:
		return c
	case <-time.After(2 * time.Second):
		t.Fatal("prompt completion callback did not fire")
		return promptCompletion{}
	}
}

func (h *cancelGraceHarness) assertNoCompletion(t *testing.T) {
	t.Helper()
	select {
	case c := <-h.completions:
		t.Fatalf("unexpected prompt completion: %+v", c)
	case <-time.After(100 * time.Millisecond):
	}
}

func cancelGracePromptParams(text string) json.RawMessage {
	params, _ := json.Marshal(map[string]any{
		"prompt": []map[string]string{{"type": "text", "text": text}},
	})
	return params
}

func (h *cancelGraceHarness) waitForReady(t *testing.T) {
	t.Helper()
	waitFor(t, 2*time.Second, func() bool { return h.host.Status() == HostReady })
}

// cancelTransport drives one production entry point end to end: how a prompt
// arrives and how the user's Stop reaches the host.
type cancelTransport struct {
	name   string
	prompt func(t *testing.T, h *cancelGraceHarness, text string)
	cancel func(h *cancelGraceHarness)
}

var cancelTransports = []cancelTransport{
	{
		// Browser viewer: prompt and Stop both arrive as WebSocket JSON-RPC frames.
		name: "ws session/cancel",
		prompt: func(t *testing.T, h *cancelGraceHarness, text string) {
			g := &Gateway{host: h.host, viewerID: "viewer-1"}
			frame, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0", "id": text, "method": "session/prompt",
				"params": cancelGracePromptParams(text),
			})
			g.handleMessage(context.Background(), frame)
		},
		cancel: func(h *cancelGraceHarness) {
			g := &Gateway{host: h.host, viewerID: "viewer-1"}
			g.handleMessage(context.Background(), []byte(`{"jsonrpc":"2.0","method":"session/cancel","params":{}}`))
		},
	},
	{
		// Control plane: a durable prompt delivery, and the HTTP cancel used by
		// the chat Stop button and urgent stop-and-deliver.
		name: "http control-plane cancel",
		prompt: func(t *testing.T, h *cancelGraceHarness, text string) {
			accepted, ok := h.host.AcceptPrompt(context.Background(), json.RawMessage(`"`+text+`"`),
				cancelGracePromptParams(text), "control-plane", false, "delivery-"+text, nil)
			if !ok {
				t.Fatalf("control-plane prompt %q was not accepted", text)
			}
			go accepted.Run()
		},
		cancel: func(h *cancelGraceHarness) { h.host.CancelPromptFromControlPlane() },
	},
}

// TestCancelGraceWatchdogNeverTouchesTheNextPrompt reproduces the 2026-09-28
// incident ordering: prompt A is cancelled, A settles, prompt B is accepted
// inside the grace window, and only then does A's grace deadline fire.
func TestCancelGraceWatchdogNeverTouchesTheNextPrompt(t *testing.T) {
	t.Parallel()
	for _, transport := range cancelTransports {
		transport := transport
		t.Run(transport.name, func(t *testing.T) {
			t.Parallel()
			h := newCancelGraceHarness(t)

			transport.prompt(t, h, "prompt-a")
			h.agent.nextPrompt(t)
			waitFor(t, 2*time.Second, func() bool { return h.host.Status() == HostPrompting })

			transport.cancel(h)
			fireA := h.timer.awaitArmed(t)

			a := h.nextCompletion(t)
			if a.stopReason != "cancelled" {
				t.Fatalf("prompt A stopReason = %q, want cancelled", a.stopReason)
			}
			h.waitForReady(t)

			// Prompt B is accepted before A's grace deadline.
			transport.prompt(t, h, "prompt-b")
			bID := h.agent.nextPrompt(t)
			waitFor(t, 2*time.Second, func() bool { return h.host.Status() == HostPrompting })
			stopsBefore := h.process.stopCount.Load()

			// Now A's deadline fires while B is running.
			fireA <- time.Now()
			h.assertNoCompletion(t)
			if got := h.host.Status(); got != HostPrompting {
				t.Fatalf("status after stale grace deadline = %s, want %s", got, HostPrompting)
			}
			if got := h.process.stopCount.Load(); got != stopsBefore {
				t.Fatalf("agent process stopped %d times by a stale watchdog", got-stopsBefore)
			}
			if got := h.events.Count("ACP prompt force-stopped"); got != 0 {
				t.Fatalf("force-stop events = %d, want 0", got)
			}

			// Every cancel/start log names the prompt it belongs to.
			requested := h.events.find("Prompt cancel requested")
			if len(requested) != 1 || requested[0].context["promptId"] == nil {
				t.Fatalf("cancel requested reports = %+v, want one with promptId", requested)
			}
			started := h.events.find("ACP Prompt started")
			if len(started) != 2 || started[0].context["promptId"] == started[1].context["promptId"] {
				t.Fatalf("prompt started reports = %+v, want two distinct promptIds", started)
			}
			if transport.name == "http control-plane cancel" && requested[0].context["deliveryId"] != "delivery-prompt-a" {
				t.Fatalf("cancel requested deliveryId = %v, want delivery-prompt-a", requested[0].context["deliveryId"])
			}

			// B completes normally, exactly once.
			h.agent.respond(bID, "end_turn")
			b := h.nextCompletion(t)
			if b.stopReason != "end_turn" || b.err != nil {
				t.Fatalf("prompt B completion = %+v, want end_turn", b)
			}
			h.waitForReady(t)
			h.assertNoCompletion(t)
		})
	}
}

// TestCancelGraceWatchdogSettlesAGenuinelyStuckCancel is the convergence
// control: when the cancelled prompt itself cannot settle, the watchdog still
// fires, reports "cancelled" (never a fatal task failure), and restarts the
// agent through the intentional prompt-cancel stop. That the intentional stop
// then restarts the agent back to ready is proven separately by
// TestSessionHost_MonitorIntentionalPromptCancelReportsIdleAfterSuccessfulRestart.
func TestCancelGraceWatchdogSettlesAGenuinelyStuckCancel(t *testing.T) {
	t.Parallel()
	for _, transport := range cancelTransports {
		transport := transport
		t.Run(transport.name, func(t *testing.T) {
			t.Parallel()
			h := newCancelGraceHarness(t)
			close(h.agent.stopReading)

			transport.prompt(t, h, "prompt-a")
			h.agent.nextPrompt(t)
			waitFor(t, 2*time.Second, func() bool { return h.host.Status() == HostPrompting })

			// The wedged agent no longer drains stdin, so the transport's own
			// session/cancel write can block; production calls it from a
			// request goroutine.
			go transport.cancel(h)
			fireA := h.timer.awaitArmed(t)
			h.assertNoCompletion(t)
			stopsBefore := h.process.stopCount.Load()

			fireA <- time.Now()
			a := h.nextCompletion(t)
			if a.stopReason != "cancelled" {
				t.Fatalf("stuck cancel stopReason = %q, want cancelled", a.stopReason)
			}
			waitFor(t, 2*time.Second, func() bool { return h.process.stopCount.Load() > stopsBefore })
			if got := h.host.Status(); got == HostError {
				t.Fatalf("host status = %s after stuck cancel, want a restart rather than error", got)
			}
			h.host.mu.RLock()
			intentional := h.host.intentionalPromptCancelProcessStop
			h.host.mu.RUnlock()
			if !intentional {
				t.Fatal("stuck cancel must stop the agent as an intentional prompt cancel so the monitor restarts it")
			}
			if got := h.events.Count("ACP prompt cancel did not settle; restarting agent"); got != 1 {
				t.Fatalf("stuck-cancel lifecycle events = %d, want 1", got)
			}
			h.assertNoCompletion(t)
		})
	}
}

// TestCancelGraceWatchdogDisarmsWhenAttemptSettles proves the watchdog exits on
// the attempt's own completion instead of blocking on its timer.
func TestCancelGraceWatchdogDisarmsWhenAttemptSettles(t *testing.T) {
	t.Parallel()
	h := newCancelGraceHarness(t)
	var stopped sync.WaitGroup
	stopped.Add(1)
	h.host.cancelGraceTimer = func(time.Duration) (<-chan time.Time, func()) {
		fire := make(chan time.Time)
		h.timer.armed <- fire
		return fire, stopped.Done
	}

	cancelTransports[0].prompt(t, h, "prompt-a")
	h.agent.nextPrompt(t)
	waitFor(t, 2*time.Second, func() bool { return h.host.Status() == HostPrompting })
	cancelTransports[0].cancel(h)
	h.timer.awaitArmed(t)
	if a := h.nextCompletion(t); a.stopReason != "cancelled" {
		t.Fatalf("prompt A stopReason = %q, want cancelled", a.stopReason)
	}

	done := make(chan struct{})
	go func() { stopped.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("cancel-grace watchdog stayed armed after its attempt settled")
	}
}

// TestCancelGraceStuckViewerCancelRestartsAgentBackToReady closes the loop for
// the viewer WebSocket transport, where the settled stuck cancel is the only
// thing that stops the wedged agent: the real process monitor must restart it
// back to ready, and a follow-up prompt must then run on the new agent.
func TestCancelGraceStuckViewerCancelRestartsAgentBackToReady(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", "")
	h := newCancelGraceHarnessWithProcess(t, true)
	h.host.config.InitializeTimeoutMs = 500
	h.host.config.LoadSessionTimeoutMs = 500
	h.host.config.ContainerResolver = func() (string, error) { return "", nil }
	var restarts sync.WaitGroup
	restarts.Add(1)
	h.host.config.StartProcess = func(*agentStartup) (agentProcess, error) {
		defer restarts.Done()
		proc, reader, writer := newFakeAgentProcess(time.Now(), false)
		serveRecoveryACP(t, reader, writer)
		return proc, nil
	}
	h.host.mu.Lock()
	h.host.agentSupportsLoadSession = true
	h.host.mu.Unlock()
	go h.host.monitorProcessExit(h.process, "claude-code", &agentCredential{credentialKind: "api-key"}, nil)

	close(h.agent.stopReading)
	ws := cancelTransports[0]
	ws.prompt(t, h, "prompt-a")
	h.agent.nextPrompt(t)
	waitFor(t, 2*time.Second, func() bool { return h.host.Status() == HostPrompting })

	go ws.cancel(h)
	fireA := h.timer.awaitArmed(t)
	if got := h.process.stopCount.Load(); got != 0 {
		t.Fatalf("viewer cancel stopped the agent %d times before the grace deadline", got)
	}

	fireA <- time.Now()
	if a := h.nextCompletion(t); a.stopReason != "cancelled" {
		t.Fatalf("stuck cancel stopReason = %q, want cancelled", a.stopReason)
	}
	waitFor(t, 5*time.Second, func() bool { return h.host.Status() == HostReady })
	restarts.Wait()

	ws.prompt(t, h, "prompt-b")
	b := h.nextCompletion(t)
	if b.err != nil || b.stopReason == fatalErrorStopReason {
		t.Fatalf("follow-up prompt after restart = %+v, want a clean completion", b)
	}
	if got := h.host.Status(); got != HostReady {
		t.Fatalf("status after follow-up = %s, want %s", got, HostReady)
	}
}

// TestCancelGraceStuckCancelDefersToAnInFlightRestart covers a stuck cancel
// whose agent process was already cleared by a concurrent restart (for example
// a crash-recovery restart that does not fail the active prompt). The attempt
// still settles "cancelled", and the watchdog does not claim a second restart.
func TestCancelGraceStuckCancelDefersToAnInFlightRestart(t *testing.T) {
	t.Parallel()
	h := newCancelGraceHarness(t)
	close(h.agent.stopReading)
	ws := cancelTransports[0]
	ws.prompt(t, h, "prompt-a")
	h.agent.nextPrompt(t)
	waitFor(t, 2*time.Second, func() bool { return h.host.Status() == HostPrompting })

	go ws.cancel(h)
	fireA := h.timer.awaitArmed(t)

	// Model monitorProcessExit's restart branch having already taken the process.
	h.host.mu.Lock()
	h.host.process = nil
	h.host.setStatusLocked(HostStarting)
	h.host.mu.Unlock()

	fireA <- time.Now()
	if a := h.nextCompletion(t); a.stopReason != "cancelled" {
		t.Fatalf("stuck cancel stopReason = %q, want cancelled", a.stopReason)
	}
	waitFor(t, 2*time.Second, func() bool {
		return h.events.Count("ACP prompt cancel did not settle; agent restart already in progress") == 1
	})
	if got := h.events.Count("ACP prompt cancel did not settle; restarting agent"); got != 0 {
		t.Fatalf("restart claims = %d, want 0 when another owner is restarting", got)
	}
	if got := h.host.Status(); got != HostStarting {
		t.Fatalf("status = %s, want the in-flight restart's %s left untouched", got, HostStarting)
	}
	h.host.mu.RLock()
	intentional := h.host.intentionalPromptCancelProcessStop
	h.host.mu.RUnlock()
	if intentional {
		t.Fatal("no intentional stop may be recorded without a process to stop")
	}
	h.assertNoCompletion(t)
}
