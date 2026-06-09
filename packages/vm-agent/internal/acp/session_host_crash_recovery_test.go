package acp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

type fakeAgentProcess struct {
	stdin           *io.PipeWriter
	stdout          *io.PipeReader
	stderr          io.Reader
	startedAt       time.Time
	stopCount       atomic.Int32
	waitCh          chan struct{}
	waitErr         error
	closeWaitOnStop bool
	recoveryMu      sync.Mutex
	recoveryNotify  recoveryNotify
}

func newFakeAgentProcess(startedAt time.Time, closeWaitOnStop bool) (*fakeAgentProcess, *io.PipeReader, *io.PipeWriter) {
	clientToAgentReader, clientToAgentWriter := io.Pipe()
	agentToClientReader, agentToClientWriter := io.Pipe()
	return &fakeAgentProcess{
		stdin:           clientToAgentWriter,
		stdout:          agentToClientReader,
		stderr:          bytes.NewReader(nil),
		startedAt:       startedAt,
		waitCh:          make(chan struct{}),
		closeWaitOnStop: closeWaitOnStop,
	}, clientToAgentReader, agentToClientWriter
}

func (p *fakeAgentProcess) Stdin() io.Writer                      { return p.stdin }
func (p *fakeAgentProcess) Stdout() io.Reader                     { return p.stdout }
func (p *fakeAgentProcess) Stderr() io.Reader                     { return p.stderr }
func (p *fakeAgentProcess) StartedAt() time.Time                  { return p.startedAt }
func (p *fakeAgentProcess) KillContainerProcesses(syscall.Signal) {}

func (p *fakeAgentProcess) Stop() error {
	p.stopCount.Add(1)
	if p.closeWaitOnStop {
		select {
		case <-p.waitCh:
		default:
			close(p.waitCh)
		}
	}
	return nil
}

func (p *fakeAgentProcess) Wait() error {
	<-p.waitCh
	return p.waitErr
}

func (p *fakeAgentProcess) SetRecoveryNotify(notify recoveryNotify) {
	p.recoveryMu.Lock()
	defer p.recoveryMu.Unlock()
	p.recoveryNotify = notify
}

func (p *fakeAgentProcess) RecoveryNotify() recoveryNotify {
	p.recoveryMu.Lock()
	defer p.recoveryMu.Unlock()
	return p.recoveryNotify
}

func serveRecoveryACP(t *testing.T, reader *io.PipeReader, writer *io.PipeWriter) {
	t.Helper()
	go func() {
		scanner := bufio.NewScanner(reader)
		for scanner.Scan() {
			var req struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
			}
			if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
				return
			}
			result := map[string]any{}
			switch req.Method {
			case acpsdk.AgentMethodInitialize:
				result = map[string]any{
					"protocolVersion": acpsdk.ProtocolVersionNumber,
					"agentCapabilities": map[string]any{
						"loadSession": true,
					},
					"authMethods": []any{},
				}
			case acpsdk.AgentMethodSessionLoad:
				result = map[string]any{"configOptions": []any{}}
			default:
				result = map[string]any{}
			}
			resp, err := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result":  result,
			})
			if err != nil {
				return
			}
			_, _ = writer.Write(append(resp, '\n'))
		}
	}()
}

func TestSessionHost_HungDisconnectStopsProcessAndSignalsOnce(t *testing.T) {
	host := newRecoveryTestHost(t, 2*time.Second)
	defer host.Stop()

	oldProc, _, _ := armRecoverablePrompt(t, host, "claude-code", 10*time.Second, true)

	var startCount atomic.Int32
	completed := startRecoveryMonitor(t, host, oldProc, "claude-code", countingSpawn(t, &startCount))
	finishWithPeerDisconnect(host)

	expectCompletion(t, completed, crashRecoveredStopReason, 2*time.Second, "timed out waiting for recovery completion")
	assertNoSecondCompletion(t, completed)
	if oldProc.stopCount.Load() != 1 {
		t.Fatalf("Stop count = %d, want 1", oldProc.stopCount.Load())
	}
	if startCount.Load() != 1 {
		t.Fatalf("restart count = %d, want 1", startCount.Load())
	}
}

func TestSessionHost_UnkillableProcessWatchdogSignalsError(t *testing.T) {
	host := newRecoveryTestHost(t, 20*time.Millisecond)
	defer host.Stop()

	_, completed, _ := armRecoverablePrompt(t, host, "openai-codex", 10*time.Second, false)
	finishWithPeerDisconnect(host)

	expectCompletion(t, completed, "error", time.Second, "watchdog did not emit terminal error")
	assertNoSecondCompletion(t, completed)
}

// TestSessionHost_WatchdogAfterMonitorSuccessDoesNotNilNewProcess isolates the
// watchdog-vs-success race by manually injecting the state monitorProcessExit
// would install on a successful restart (new process, cleared recovery flag,
// HostReady), rather than running the full restart path. This lets the test use
// a 20ms watchdog and deterministically assert the watchdog short-circuits on
// the cleared flag without nil-ing the freshly-installed process. The full
// monitorProcessExit restart path is exercised by
// TestSessionHost_HungDisconnectStopsProcessAndSignalsOnce.
func TestSessionHost_WatchdogAfterMonitorSuccessDoesNotNilNewProcess(t *testing.T) {
	host := newRecoveryTestHost(t, 20*time.Millisecond)
	defer host.Stop()

	_, completed, _ := armRecoverablePrompt(t, host, "claude-code", 10*time.Second, false)
	finishWithPeerDisconnect(host)
	newProc, _, _ := newFakeAgentProcess(time.Now(), false)
	notify := host.process.RecoveryNotify()
	if notify == nil {
		t.Fatal("recovery notify was not armed")
	}
	notify(crashRecoveredStopReason, nil)

	host.mu.Lock()
	host.process = newProc
	host.clearCrashRecoveryLocked()
	host.status = HostReady
	host.mu.Unlock()

	time.Sleep(80 * time.Millisecond)
	host.mu.RLock()
	gotProcess := host.process
	host.mu.RUnlock()
	if gotProcess != newProc {
		t.Fatal("watchdog nilled or replaced the new process after recovery resolved")
	}
	select {
	case reason := <-completed:
		if reason != crashRecoveredStopReason {
			t.Fatalf("stopReason = %q, want recovered", reason)
		}
	default:
		t.Fatal("missing monitor-success completion before watchdog fired")
	}
	assertNoSecondCompletion(t, completed)
}

func TestSessionHost_AutoSuspendDefersDuringStartingRecovery(t *testing.T) {
	host := newRecoveryTestHost(t, time.Second)
	host.config.IdleSuspendTimeout = 20 * time.Millisecond
	defer host.Stop()

	host.mu.Lock()
	host.status = HostStarting
	host.crashRecoveryInProgress = true
	host.mu.Unlock()

	host.viewerMu.Lock()
	host.suspendTimer = time.AfterFunc(time.Hour, func() {})
	host.viewerMu.Unlock()

	done := make(chan struct{})
	go func() {
		host.autoSuspend()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("autoSuspend deadlocked")
	}

	host.viewerMu.Lock()
	timer := host.suspendTimer
	host.viewerMu.Unlock()
	if timer == nil {
		t.Fatal("autoSuspend did not re-arm timer during recovery")
	}
	host.mu.RLock()
	status := host.status
	inRecovery := host.crashRecoveryInProgress
	host.mu.RUnlock()
	if status != HostStarting || !inRecovery {
		t.Fatalf("autoSuspend killed recovery: status=%s inRecovery=%v", status, inRecovery)
	}
}

func TestSessionHost_RestartCountDecayWindow(t *testing.T) {
	host := newRecoveryTestHost(t, time.Second)
	defer host.Stop()
	host.config.RestartDecayWindow = 50 * time.Millisecond

	host.mu.Lock()
	host.restartCount = 2
	host.lastCrashTime = time.Now()
	host.applyRestartDecayLocked()
	if host.restartCount != 2 {
		t.Fatalf("restartCount decayed inside window: %d", host.restartCount)
	}
	host.lastCrashTime = time.Now().Add(-time.Second)
	host.applyRestartDecayLocked()
	if host.restartCount != 0 {
		t.Fatalf("restartCount = %d, want 0 after decay window", host.restartCount)
	}
	host.mu.Unlock()
}

func TestSessionHost_RecoveryNotifyOnceDoesNotWrapLaterNormalPrompt(t *testing.T) {
	host := newRecoveryTestHost(t, time.Second)
	defer host.Stop()

	_, completed, errs := armRecoverablePrompt(t, host, "claude-code", 10*time.Second, false)
	agentType, _, _, notify, ok := host.beginCrashRecovery(json.RawMessage(`"req-1"`), "viewer-1")
	if !ok {
		t.Fatal("beginCrashRecovery failed")
	}
	if agentType != "claude-code" {
		t.Fatalf("agentType = %q, want claude-code", agentType)
	}
	host.mu.Lock()
	snapshot := host.crashRecoverySnapshotLocked()
	host.mu.Unlock()

	host.finishCrashRecoveryFailure(snapshot, "rapid exit", errors.New("rapid exit"), notify)
	host.finishCrashRecoveryFailure(snapshot, "max restarts", errors.New("max restarts"), notify)
	host.finishCrashRecoveryFailure(snapshot, "restart failed", errors.New("restart failed"), notify)
	notify(crashRecoveredStopReason, nil)
	host.finishCrashRecoveryFailure(snapshot, "watchdog", errors.New("watchdog"), notify)

	expectCompletion(t, completed, "error", time.Second, "missing recovery completion")
	select {
	case err := <-errs:
		if err == nil || err.Error() != "rapid exit" {
			t.Fatalf("first recovery err = %v, want rapid exit", err)
		}
	default:
		t.Fatal("missing recovery error")
	}
	assertNoSecondCompletion(t, completed)

	host.notifyPromptComplete("end_turn", nil)
	expectCompletion(t, completed, "end_turn", time.Second, "normal prompt completion was swallowed by recovery once")
}

// TestSessionHost_CodexCrashRecovery_ReportsTerminalError proves the Codex
// conservatism invariant (resumeShouldReportTerminalErrorLocked): even when the
// LoadSession-based restart succeeds, Codex recovery is routed to a terminal
// "error" rather than "recovered" until resume coherence is validated. The long
// watchdog isolates this from the watchdog path so the only way to reach "error"
// is through the successful-restart branch of monitorProcessExit.
func TestSessionHost_CodexCrashRecovery_ReportsTerminalError(t *testing.T) {
	host := newRecoveryTestHost(t, 30*time.Second)
	defer host.Stop()

	oldProc, _, _ := armRecoverablePrompt(t, host, "openai-codex", 10*time.Second, true)

	var startCount atomic.Int32
	completed := startRecoveryMonitor(t, host, oldProc, "openai-codex", countingSpawn(t, &startCount))
	finishWithPeerDisconnect(host)

	expectCompletion(t, completed, "error", 2*time.Second, "codex recovery did not report terminal error")
	assertNoSecondCompletion(t, completed)
	if startCount.Load() != 1 {
		t.Fatalf("restart count = %d, want 1 (LoadSession restart must run before the terminal error)", startCount.Load())
	}
}

// TestSessionHost_CrashRecovery_MaxRestartExhausted proves that exceeding the
// restart budget while a crash recovery episode is in flight resolves the
// stranded prompt to a terminal "error" instead of leaving it recovering. No
// restart is attempted once the budget is exhausted.
func TestSessionHost_CrashRecovery_MaxRestartExhausted(t *testing.T) {
	host := newRecoveryTestHost(t, 30*time.Second)
	defer host.Stop()
	host.config.MaxRestartAttempts = 1

	oldProc, _, _ := armRecoverablePrompt(t, host, "claude-code", 10*time.Second, true)
	host.mu.Lock()
	host.restartCount = 1
	host.mu.Unlock()

	var startCount atomic.Int32
	completed := startRecoveryMonitor(t, host, oldProc, "claude-code", countingSpawn(t, &startCount))
	finishWithPeerDisconnect(host)

	expectCompletion(t, completed, "error", 2*time.Second, "max-restart exhaustion did not report terminal error")
	assertNoSecondCompletion(t, completed)
	if startCount.Load() != 0 {
		t.Fatalf("restart attempted despite exhausted budget: startCount=%d", startCount.Load())
	}
}

// TestSessionHost_CrashRecovery_RestartFails proves that when the recovery
// restart itself fails to spawn a new agent process, the stranded prompt is
// resolved to a terminal "error" rather than hanging in recovering state.
func TestSessionHost_CrashRecovery_RestartFails(t *testing.T) {
	host := newRecoveryTestHost(t, 30*time.Second)
	defer host.Stop()

	oldProc, _, _ := armRecoverablePrompt(t, host, "claude-code", 10*time.Second, true)

	completed := startRecoveryMonitor(t, host, oldProc, "claude-code", func(*agentStartup) (agentProcess, error) {
		return nil, errors.New("spawn failed")
	})
	finishWithPeerDisconnect(host)

	expectCompletion(t, completed, "error", 2*time.Second, "failed restart did not report terminal error")
	assertNoSecondCompletion(t, completed)
}

func newRecoveryTestHost(t *testing.T, watchdog time.Duration) *SessionHost {
	t.Helper()
	return NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:               "test-session",
			WorkspaceID:             "test-workspace",
			RecoveryWatchdogTimeout: watchdog,
			RestartDecayWindow:      time.Minute,
			InitializeTimeoutMs:     500,
			LoadSessionTimeoutMs:    500,
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
}

// countingSpawn returns a StartProcess hook that increments startCount and
// spins up a fresh fake agent serving the recovery ACP handshake on each call.
func countingSpawn(t *testing.T, startCount *atomic.Int32) func(*agentStartup) (agentProcess, error) {
	t.Helper()
	return func(*agentStartup) (agentProcess, error) {
		startCount.Add(1)
		proc, reader, writer := newFakeAgentProcess(time.Now(), false)
		serveRecoveryACP(t, reader, writer)
		return proc, nil
	}
}

// startRecoveryMonitor wires the container resolver, restart-spawn hook, and a
// completion channel onto host, then drives monitorProcessExit for oldProc in a
// goroutine. It returns the buffered completion channel the restart path reports
// through.
func startRecoveryMonitor(t *testing.T, host *SessionHost, oldProc *fakeAgentProcess, agentType string, startProcess func(*agentStartup) (agentProcess, error)) chan string {
	t.Helper()
	host.config.ContainerResolver = func() (string, error) { return "container", nil }
	host.config.StartProcess = startProcess
	completed := make(chan string, 2)
	host.config.OnPromptComplete = func(stopReason string, _ error) { completed <- stopReason }
	go host.monitorProcessExit(context.Background(), oldProc, agentType, &agentCredential{credentialKind: "api-key"}, nil)
	return completed
}

func armRecoverablePrompt(t *testing.T, host *SessionHost, agentType string, startedAgo time.Duration, waitClosesOnStop bool) (*fakeAgentProcess, chan string, chan error) {
	t.Helper()
	proc, _, _ := newFakeAgentProcess(time.Now().Add(-startedAgo), waitClosesOnStop)
	completed := make(chan string, 2)
	errs := make(chan error, 2)
	host.config.OnPromptComplete = func(stopReason string, promptErr error) {
		completed <- stopReason
		errs <- promptErr
	}
	host.mu.Lock()
	host.process = proc
	host.status = HostReady
	host.agentType = agentType
	host.sessionID = "acp-session-1"
	host.agentSupportsLoadSession = true
	host.mu.Unlock()
	return proc, completed, errs
}

func assertNoSecondCompletion(t *testing.T, completed <-chan string) {
	t.Helper()
	select {
	case reason := <-completed:
		t.Fatalf("unexpected second completion: %q", reason)
	case <-time.After(80 * time.Millisecond):
	}
}

// finishWithPeerDisconnect simulates the hard ACP stdio disconnect that the
// recovery path is designed to survive: the prompt fails because the peer
// vanished mid-response.
func finishWithPeerDisconnect(host *SessionHost) {
	host.finishPromptWithError(
		context.Background(),
		json.RawMessage(`"req-1"`),
		promptStartInfo{startedAt: time.Now(), viewerID: "viewer-1"},
		errors.New("peer disconnected before response"),
	)
}

// expectCompletion blocks until a completion reason arrives and asserts it
// matches want, failing with timeoutMsg if the recovery path never reports.
func expectCompletion(t *testing.T, completed <-chan string, want string, timeout time.Duration, timeoutMsg string) {
	t.Helper()
	select {
	case reason := <-completed:
		if reason != want {
			t.Fatalf("stopReason = %q, want %q", reason, want)
		}
	case <-time.After(timeout):
		t.Fatal(timeoutMsg)
	}
}
