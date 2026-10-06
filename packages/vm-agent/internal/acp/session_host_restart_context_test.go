package acp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

// The incident this file pins (SAM idea 01M0644866Q0000M4HP39WNCZW, 2026-09-08):
// a Codex session was restored from a snapshot over HTTP, worked normally for
// half an hour, and then the user pressed Stop. The intentional process stop is
// supposed to be followed by an automatic restart that LoadSession-resumes the
// same conversation. Instead every restart died with
//
//	agent_restart_failed: failed to write auth file: create auth file parent dir:
//	command failed: context canceled
//
// because monitorProcessExit had captured the *restore HTTP request's* context,
// which the Go http.Server cancelled the moment that request returned — minutes
// before the restart ran. The session was left with no usable agent while the
// control-plane mirror still said "recovering", and both observed sessions had
// to be recovered onto replacement workspaces.
//
// The pre-existing coverage could not see this: every restart test called
// monitorProcessExit directly with context.Background(), hand-feeding the live
// context whose absence IS the bug (.claude/rules/62). These tests reach the
// monitor the way production does — through RestoreAgent / SelectAgent — and
// then kill the caller's context before triggering the restart.

// restartContextProbe records the context handed to each agent-startup attempt.
//
// RuntimeAssetsProvider is a real production hook that receives the startup
// context unmodified, which makes it a valid observation point for "what context
// did this attempt get". It is NOT the incident's own failure site: that was
// injectAuthFileCredential -> writeAuthFileToContainer -> execInContainer, which
// needs agentType=openai-codex AND a resolved container. `ctx` is threaded as one
// unmodified value from startAgentWithSessionMode through both, so observing it
// here proves the same property — but a future change that re-derives a context
// specifically inside the codex/container branch would not be caught here. That
// gap is recorded in the task file.
type restartContextProbe struct {
	mu        sync.Mutex
	errs      []error
	deadlines []time.Duration // 0 = attempt context had no deadline
	failFrom  int             // 1-based attempt from which to fail; 0 disables
	failWith  error           // error returned once failFrom is reached

	// onAttempt, when set, runs INSIDE the startup call for the given 1-based
	// attempt, holding that attempt's own context. It is the only way to observe
	// the attempt context while it is still live.
	onAttempt func(attempt int, ctx context.Context)
}

func (p *restartContextProbe) provider(ctx context.Context) (RuntimeAssets, error) {
	var remaining time.Duration
	if deadline, ok := ctx.Deadline(); ok {
		remaining = time.Until(deadline)
	}
	p.mu.Lock()
	p.errs = append(p.errs, ctx.Err())
	p.deadlines = append(p.deadlines, remaining)
	attempt := len(p.errs)
	failFrom, failWith := p.failFrom, p.failWith
	onAttempt := p.onAttempt
	p.mu.Unlock()

	if onAttempt != nil {
		onAttempt(attempt, ctx)
	}

	// Model ctx-sensitive startup I/O: a cancelled context fails the attempt,
	// exactly as `docker exec ... mkdir -p` did in production.
	if err := ctx.Err(); err != nil {
		return RuntimeAssets{}, err
	}
	if failFrom > 0 && attempt >= failFrom {
		return RuntimeAssets{}, failWith
	}
	return RuntimeAssets{}, nil
}

func (p *restartContextProbe) attempts() []error {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]error, len(p.errs))
	copy(out, p.errs)
	return out
}

func (p *restartContextProbe) attemptDeadlines() []time.Duration {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]time.Duration, len(p.deadlines))
	copy(out, p.deadlines)
	return out
}

// restartControlPlane serves both the agent-key fetch and the activity callback
// so a single ControlPlaneURL satisfies startup and reportActivity.
type restartControlPlane struct {
	mu       sync.Mutex
	payloads []activityPayload
	server   *httptest.Server
}

func newRestartControlPlane(t *testing.T) *restartControlPlane {
	t.Helper()
	cp := &restartControlPlane{}
	cp.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/activity"):
			var payload activityPayload
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				http.Error(w, "invalid activity payload", http.StatusBadRequest)
				return
			}
			cp.mu.Lock()
			cp.payloads = append(cp.payloads, payload)
			cp.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		case strings.Contains(r.URL.Path, "/agent-key"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"apiKey":"test-api-key","credentialKind":"api-key"}`))
		default:
			// agent-settings and friends fall back to defaults on 404.
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(cp.server.Close)
	return cp
}

func (cp *restartControlPlane) activities() []string {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	out := make([]string, 0, len(cp.payloads))
	for _, payload := range cp.payloads {
		out = append(out, payload.Activity)
	}
	return out
}

func (cp *restartControlPlane) count(activity string) int {
	total := 0
	for _, got := range cp.activities() {
		if got == activity {
			total++
		}
	}
	return total
}

func (cp *restartControlPlane) lastWith(activity string) (activityPayload, bool) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	for i := len(cp.payloads) - 1; i >= 0; i-- {
		if cp.payloads[i].Activity == activity {
			return cp.payloads[i], true
		}
	}
	return activityPayload{}, false
}

// newRestartTestHost builds a host whose agent processes die when Stop() is
// called, so StopProcessForPromptCancel drives the real monitorProcessExit
// restart path.
func newRestartTestHost(t *testing.T, cp *restartControlPlane, acp *fakeACPServer, probe *restartContextProbe) *SessionHost {
	t.Helper()
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:            "test-session",
			WorkspaceID:          "test-workspace",
			ProjectID:            "test-project",
			NodeID:               "test-node",
			ControlPlaneURL:      cp.server.URL,
			CallbackToken:        "test-token",
			PreviousAcpSessionID: "acp-session-1",
			PreviousAgentType:    "claude-code",
			InitializeTimeoutMs:  500,
			LoadSessionTimeoutMs: 500,
			NewSessionTimeoutMs:  500,
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	host.config.HTTPClient = cp.server.Client()
	host.config.ProcessLauncher = stubProcessLauncher{}
	host.config.RuntimeAssetsProvider = probe.provider
	host.config.StartProcess = func(*agentStartup) (agentProcess, error) {
		// closeWaitOnStop=true so StopProcessForPromptCancel actually ends
		// Wait() and releases the monitor, as a real SIGTERM would.
		proc, reader, writer := newFakeAgentProcess(time.Now(), true)
		acp.serve(reader, writer)
		return proc, nil
	}
	return host
}

// startAgentThroughDoomedRequest starts the agent via the production entry point
// under `startCtx`, then cancels that context to model the request or WebSocket
// connection finishing while the host lives on.
func startAgentThroughDoomedRequest(t *testing.T, host *SessionHost, restore bool) {
	t.Helper()
	requestCtx, cancelRequest := context.WithCancel(context.Background())
	if restore {
		if err := host.RestoreAgent(requestCtx, "claude-code"); err != nil {
			cancelRequest()
			t.Fatalf("RestoreAgent failed: %v", err)
		}
	} else {
		host.SelectAgent(requestCtx, "claude-code")
	}
	if host.Status() != HostReady {
		cancelRequest()
		t.Fatalf("status after start = %s, want HostReady", host.Status())
	}
	// The restore HTTP handler has returned / the viewer socket has closed.
	cancelRequest()
}

// TestSessionHost_RestartAfterCancelSurvivesFinishedCallerRequest is the
// incident, reproduced through the real trigger. It must fail against the
// pre-fix code, where monitorProcessExit captured the caller's context.
//
// Both production entry points are covered because both hand startAgent a
// context that dies long before the restart does (.claude/rules/61): the HTTP
// snapshot restore (Server.handleRestoreAgentSession -> RestoreAgent, the path
// both incident sessions took) and the viewer WebSocket (Gateway.handleMessage
// -> SelectAgent, which dies when the browser tab closes). They converge on the
// same selectAgent body, so this is "both real callers supply their own doomed
// context", not two structurally different propagation paths.
func TestSessionHost_RestartAfterCancelSurvivesFinishedCallerRequest(t *testing.T) {
	for _, tc := range []struct {
		name    string
		restore bool
	}{
		{name: "snapshot restore request", restore: true},
		{name: "viewer websocket connection", restore: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			installFakeAgentBinary(t, "claude-agent-acp")
			cp := newRestartControlPlane(t)
			acpServer := newFakeACPServer(true, false)
			probe := &restartContextProbe{}
			host := newRestartTestHost(t, cp, acpServer, probe)
			defer host.Stop()

			startAgentThroughDoomedRequest(t, host, tc.restore)

			// The user presses Stop. This is the production trigger: the
			// control-plane cancel route calls StopProcessForPromptCancel, and
			// the already-running monitor restarts the agent.
			host.StopProcessForPromptCancel()

			// monitorProcessExit sleeps ~1.1s before restarting.
			waitFor(t, 8*time.Second, func() bool {
				return len(probe.attempts()) >= 2
			})

			attempts := probe.attempts()
			if len(attempts) < 2 {
				t.Fatalf("startup attempts = %d, want >= 2 (initial + restart)", len(attempts))
			}
			if attempts[0] != nil {
				t.Fatalf("initial startup context err = %v, want nil", attempts[0])
			}
			// The assertion that discriminates: the restart must NOT inherit
			// the caller's cancelled context.
			if attempts[1] != nil {
				t.Fatalf("restart startup context err = %v, want nil — the restart inherited the finished caller's context", attempts[1])
			}

			waitFor(t, 8*time.Second, func() bool {
				return host.Status() == HostReady
			})
			waitFor(t, 8*time.Second, func() bool {
				return cp.count("idle") >= 1
			})

			if cp.count("error") != 0 {
				t.Fatalf("activities = %v, want no error report after a recoverable restart", cp.activities())
			}
			if cp.count("recovering") < 1 {
				t.Fatalf("activities = %v, want a recovering report before idle", cp.activities())
			}

			// The resumed conversation must be the same one, not a fork.
			host.mu.RLock()
			sid := string(host.sessionID)
			host.mu.RUnlock()
			if sid != "acp-session-1" {
				t.Fatalf("resumed sessionID = %q, want acp-session-1", sid)
			}
			if got := acpServer.newSessionCalls.Load(); got != 0 {
				t.Fatalf("NewSession calls = %d, want 0 — the restart must resume, not fork", got)
			}
			if got := acpServer.loadSessionCalls.Load(); got < 2 {
				t.Fatalf("LoadSession calls = %d, want >= 2 (initial + restart)", got)
			}
			for i := 0; i < 2; i++ {
				select {
				case id := <-acpServer.loadSessionIDs:
					if id != "acp-session-1" {
						t.Fatalf("LoadSession target = %q, want acp-session-1", id)
					}
				default:
					t.Fatalf("only %d LoadSession ids recorded, want 2", i)
				}
			}
		})
	}
}

// TestSessionHost_FailedRestartReportsErrorActivity covers the second half of
// the wedge: when the restart genuinely cannot succeed, the host is left in
// HostError with no usable agent, but before this fix the only closing signal
// was reportAgentError. The activity mirror stayed on the "recovering" published
// at detach, so the composer, the durable-message delivery gate and the idle
// scheduler all kept believing work was in flight (.claude/rules/57).
func TestSessionHost_FailedRestartReportsErrorActivity(t *testing.T) {
	installFakeAgentBinary(t, "claude-agent-acp")
	cp := newRestartControlPlane(t)
	acpServer := newFakeACPServer(true, false)
	probe := &restartContextProbe{
		failFrom: 2,
		failWith: errRestartProbeFailure,
	}
	host := newRestartTestHost(t, cp, acpServer, probe)
	defer host.Stop()

	startAgentThroughDoomedRequest(t, host, true)
	host.StopProcessForPromptCancel()

	waitFor(t, 8*time.Second, func() bool {
		return cp.count("error") >= 1
	})
	waitFor(t, 8*time.Second, func() bool {
		return host.Status() == HostError
	})

	if cp.count("recovering") < 1 {
		t.Fatalf("activities = %v, want a recovering report before error", cp.activities())
	}
	if cp.count("idle") != 0 {
		t.Fatalf("activities = %v, want no idle report — no usable agent exists", cp.activities())
	}

	// Exactly one: finishCrashRecoveryFailure and completeActivePromptFailure sit
	// on the same branch, so a future refactor that adds a second report here
	// must be deliberate.
	if got := cp.count("error"); got != 1 {
		t.Fatalf("error activity reports = %d, want exactly 1 (activities = %v)", got, cp.activities())
	}

	payload, ok := cp.lastWith("error")
	if !ok {
		t.Fatal("no error activity payload recorded")
	}
	if payload.StatusError == nil || *payload.StatusError == "" {
		t.Fatal("error activity carried no statusError — the restart diagnostic was lost")
	}
	if !strings.Contains(*payload.StatusError, errRestartProbeFailure.Error()) {
		t.Fatalf("statusError = %q, want the restart failure reason", *payload.StatusError)
	}
}

// TestSessionHost_LifecycleContextIsCancelledByStop is the discriminating
// control for the fix. Handing the monitor a context that outlives the caller
// is only safe if it still dies with the host: otherwise a restart could run
// against a torn-down session. It also pins the struct-literal fallback, so a
// long-lived goroutine can never be handed a nil context.
func TestSessionHost_LifecycleContextIsCancelledByStop(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig:     GatewayConfig{SessionID: "s", WorkspaceID: "w"},
		MessageBufferSize: 8,
		ViewerSendBuffer:  8,
	})
	ctx := host.lifecycleContext()
	if err := ctx.Err(); err != nil {
		t.Fatalf("lifecycle context err before Stop = %v, want nil", err)
	}

	host.Stop()

	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("lifecycle context was not cancelled by Stop — a restart could outlive the host")
	}

	bare := &SessionHost{}
	if bare.lifecycleContext() == nil {
		t.Fatal("lifecycle context = nil for a struct-literal host")
	}
	if err := bare.lifecycleContext().Err(); err != nil {
		t.Fatalf("fallback lifecycle context err = %v, want nil", err)
	}
}

// TestSessionHost_MonitorSkipsRestartAfterStop proves the widened context did
// not weaken the shutdown guard: a process exit observed after Stop must not
// start a replacement.
func TestSessionHost_MonitorSkipsRestartAfterStop(t *testing.T) {
	installFakeAgentBinary(t, "claude-agent-acp")
	cp := newRestartControlPlane(t)
	acpServer := newFakeACPServer(true, false)
	probe := &restartContextProbe{}
	host := newRestartTestHost(t, cp, acpServer, probe)

	startAgentThroughDoomedRequest(t, host, true)

	host.mu.RLock()
	process := host.process
	host.mu.RUnlock()
	if process == nil {
		t.Fatal("no agent process installed")
	}

	host.Stop()
	// Stop() already stops the process; make the monitor's Wait() return even
	// if the host had detached it first.
	_ = process.Stop()

	// Longer than the monitor's 100ms + 1s restart delay, so a restart would have
	// been observable. In practice Stop() detaches the process first and the
	// monitor exits via the pre-existing "process replaced" guard well before
	// that; this asserts the outcome, not which guard produced it.
	time.Sleep(1500 * time.Millisecond)

	if attempts := probe.attempts(); len(attempts) != 1 {
		t.Fatalf("startup attempts = %d, want 1 — a stopped host must not restart", len(attempts))
	}
	if host.Status() != HostStopped {
		t.Fatalf("status = %s, want HostStopped", host.Status())
	}
}

// errRestartProbeFailure is a non-context startup failure, so the error-activity
// test cannot pass merely because the context was cancelled.
var errRestartProbeFailure = errors.New("runtime assets unavailable for restart")

// TestSessionHost_RestartAttemptIsBoundedButDoesNotLeakIntoNextMonitor covers
// the other half of the context-ownership contract, and the trap that makes it
// easy to get wrong (rule 71, requirement 4).
//
// The restart attempt must be BOUNDED: monitorProcessExit holds h.mu for its
// whole duration and execInContainer has no timeout of its own, so an unbounded
// attempt against a wedged container runtime would block Stop() forever.
//
// But that bound must be derived DOWNWARD from the host lifecycle and dropped
// when the attempt resolves. If the bounded context were handed to the
// replacement process's monitor, the host would silently lose the ability to
// restart again once the timeout elapsed — trading the original wedge for a
// slower one. A deliberately short timeout plus a second Stop→restart cycle
// after it has elapsed is what discriminates the two.
func TestSessionHost_RestartAttemptIsBoundedButDoesNotLeakIntoNextMonitor(t *testing.T) {
	installFakeAgentBinary(t, "claude-agent-acp")
	cp := newRestartControlPlane(t)
	acpServer := newFakeACPServer(true, false)
	probe := &restartContextProbe{}
	host := newRestartTestHost(t, cp, acpServer, probe)
	const attemptTimeout = 2 * time.Second
	host.config.RestartAttemptTimeout = attemptTimeout
	defer host.Stop()

	startAgentThroughDoomedRequest(t, host, true)

	// First Stop -> restart.
	host.StopProcessForPromptCancel()
	waitFor(t, 8*time.Second, func() bool { return len(probe.attempts()) >= 2 })
	waitFor(t, 8*time.Second, func() bool { return host.Status() == HostReady })

	deadlines := probe.attemptDeadlines()
	if deadlines[0] != 0 {
		t.Fatalf("initial startup deadline = %s, want none (it belongs to the caller's request)", deadlines[0])
	}
	if deadlines[1] <= 0 || deadlines[1] > attemptTimeout {
		t.Fatalf("restart attempt deadline = %s, want a bound in (0, %s]", deadlines[1], attemptTimeout)
	}

	// Let the first attempt's bound elapse. If it leaked into the replacement
	// process's monitor, the next restart starts already expired.
	time.Sleep(attemptTimeout + 500*time.Millisecond)

	// Second Stop -> restart, on the process installed by the first restart.
	host.StopProcessForPromptCancel()
	waitFor(t, 8*time.Second, func() bool { return len(probe.attempts()) >= 3 })

	attempts := probe.attempts()
	if attempts[2] != nil {
		t.Fatalf("second restart context err = %v, want nil — the first attempt's timeout leaked into the replacement monitor", attempts[2])
	}
	waitFor(t, 8*time.Second, func() bool { return host.Status() == HostReady })
	if cp.count("error") != 0 {
		t.Fatalf("activities = %v, want no error report across two restart cycles", cp.activities())
	}
}

// TestSessionHost_RestartAttemptTimeoutIsConfigurable pins the configured value
// as the source of the bound (Constitution Principle XI: no hardcoded limits).
func TestSessionHost_RestartAttemptTimeoutIsConfigurable(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig:     GatewayConfig{SessionID: "s", WorkspaceID: "w"},
		MessageBufferSize: 8,
		ViewerSendBuffer:  8,
	})
	defer host.Stop()
	if got := host.restartAttemptTimeout(); got != config.DefaultACPRestartAttemptTimeout {
		t.Fatalf("default restart attempt timeout = %s, want %s", got, config.DefaultACPRestartAttemptTimeout)
	}

	host.config.RestartAttemptTimeout = 90 * time.Second
	if got := host.restartAttemptTimeout(); got != 90*time.Second {
		t.Fatalf("configured restart attempt timeout = %s, want 90s", got)
	}
}

// TestSessionHost_RestartContextIsDerivedFromHostLifecycle is the control that
// actually discriminates the fix's other half.
//
// It exists because the obvious controls do not. Asserting that
// lifecycleContext() is cancelled by Stop() only tests the accessor in
// isolation, and asserting that a stopped host performs no restart passes on the
// pre-existing "process replaced" guard in monitorProcessExit — neither notices
// if the restart call site is changed to context.Background(). Verified: making
// that exact substitution leaves the whole package suite green.
//
// A genuine "Stop() cancels a restart mid-flight" race is unreachable today
// (h.mu is held for the whole attempt and Stop() needs it), so this asserts the
// property that guard would depend on instead: the attempt context is a CHILD of
// the host lifecycle context, and therefore observes host teardown. The attempt
// bound is set far longer than the test, so the only thing that can end the
// context quickly is the lifecycle parent.
func TestSessionHost_RestartContextIsDerivedFromHostLifecycle(t *testing.T) {
	installFakeAgentBinary(t, "claude-agent-acp")
	cp := newRestartControlPlane(t)
	acpServer := newFakeACPServer(true, false)
	probe := &restartContextProbe{}
	host := newRestartTestHost(t, cp, acpServer, probe)
	host.config.RestartAttemptTimeout = 10 * time.Minute
	defer host.Stop()

	const observeWindow = 2 * time.Second
	observed := make(chan error, 4)
	probe.onAttempt = func(attempt int, ctx context.Context) {
		if attempt != 2 { // 1 = initial start, 2 = the restart
			return
		}
		// Tear the host down while this restart attempt is in flight.
		host.cancel()
		select {
		case <-ctx.Done():
			observed <- ctx.Err()
		case <-time.After(observeWindow):
			observed <- nil
		}
	}

	startAgentThroughDoomedRequest(t, host, true)
	host.StopProcessForPromptCancel()

	select {
	case err := <-observed:
		if err == nil {
			t.Fatalf("restart attempt context did not observe host teardown within %s — it is not derived from the host lifecycle context", observeWindow)
		}
	case <-time.After(15 * time.Second):
		// Liveness: distinguishes "the restart never happened" from "the context
		// was not derived", which would otherwise look identical.
		t.Fatalf("restart never reached the startup probe (attempts = %d)", len(probe.attempts()))
	}
}

// TestSessionHost_FailedCrashRecoveryRestartReportsErrorActivity covers the
// second flavour of the restart-failure branch. The reportActivity("error") call
// is unconditional, but the crash-recovery flavour runs extra teardown around it
// (finishCrashRecoveryFailure, clearCrashRecoveryLocked, the prompt terminal
// callback), so this proves that teardown neither suppresses the report nor
// duplicates it.
func TestSessionHost_FailedCrashRecoveryRestartReportsErrorActivity(t *testing.T) {
	cp := newRestartControlPlane(t)
	host := newRecoveryTestHost(t, 30*time.Second)
	defer host.Stop()
	host.config.ProjectID = "test-project"
	host.config.NodeID = "test-node"
	host.config.ControlPlaneURL = cp.server.URL
	host.config.CallbackToken = "test-token"
	host.config.HTTPClient = cp.server.Client()

	oldProc, _, _ := armRecoverablePrompt(t, host, "claude-code", 10*time.Second, true)
	completed := startRecoveryMonitor(t, host, oldProc, "claude-code", func(*agentStartup) (agentProcess, error) {
		return nil, errors.New("spawn failed")
	})
	finishWithPeerDisconnect(host)

	expectCompletion(t, completed, fatalErrorStopReason, 5*time.Second, "failed crash-recovery restart did not report terminal error")

	waitFor(t, 8*time.Second, func() bool { return cp.count("error") >= 1 })
	if got := cp.count("error"); got != 1 {
		t.Fatalf("error activity reports = %d, want exactly 1 (activities = %v)", got, cp.activities())
	}
	if cp.count("idle") != 0 {
		t.Fatalf("activities = %v, want no idle report — the crash recovery failed", cp.activities())
	}
	if host.Status() != HostError {
		t.Fatalf("status = %s, want HostError", host.Status())
	}
}
