package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

func serveCheckpointACP(t *testing.T, reader *io.PipeReader, writer *io.PipeWriter) <-chan string {
	t.Helper()
	methods := make(chan string, 8)
	go func() {
		scanner := bufio.NewScanner(reader)
		for scanner.Scan() {
			var request struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
			}
			if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
				return
			}
			methods <- request.Method
			if len(request.ID) == 0 || string(request.ID) == "null" {
				continue
			}
			response, err := json.Marshal(map[string]any{
				"jsonrpc": "2.0", "id": json.RawMessage(request.ID), "result": map[string]any{},
			})
			if err != nil {
				return
			}
			_, _ = writer.Write(append(response, '\n'))
		}
	}()
	return methods
}

func TestPromptEpochStableAcrossActivityRereportsAndChangesOnNewAcceptance(t *testing.T) {
	var clockCalls atomic.Int32
	base := time.Unix(1_900_000_000, 0)
	var mu sync.Mutex
	var epochs []int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload activityPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode payload: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if payload.PromptStartedAt != nil {
			mu.Lock()
			epochs = append(epochs, *payload.PromptStartedAt)
			mu.Unlock()
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
		ProjectID: "project", NodeID: "node", SessionID: "session",
		ControlPlaneURL: server.URL, CallbackToken: "token", HTTPClient: server.Client(),
		Now: func() time.Time { return base.Add(time.Duration(clockCalls.Add(1)-1) * time.Hour) },
	}})
	defer host.Stop()

	_, cancel := context.WithCancel(context.Background())
	first, ok := host.beginPrompt(cancel, nil)
	if !ok {
		t.Fatal("first prompt was not accepted")
	}
	host.reportActivity("prompting")
	host.reportActivity("prompting")
	waitFor(t, time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(epochs) == 2
	})
	mu.Lock()
	if epochs[0] != epochs[1] || epochs[0] != base.UnixMilli() {
		t.Fatalf("rereport epochs = %v, want stable %d", epochs, base.UnixMilli())
	}
	mu.Unlock()
	first.complete(host, "end_turn", nil)

	_, cancel2 := context.WithCancel(context.Background())
	second, ok := host.beginPrompt(cancel2, nil)
	if !ok {
		t.Fatal("second prompt was not accepted")
	}
	host.reportActivity("prompting")
	waitFor(t, time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(epochs) == 3
	})
	mu.Lock()
	if epochs[2] == epochs[0] || epochs[2] != base.Add(time.Hour).UnixMilli() {
		t.Fatalf("new prompt epoch = %d, want %d (all=%v)", epochs[2], base.Add(time.Hour).UnixMilli(), epochs)
	}
	mu.Unlock()
	second.complete(host, "end_turn", nil)
}

func TestPromptTerminalArbiterCompletesExactlyOnceAcrossRaces(t *testing.T) {
	completed := make(chan string, 10)
	observed := make(chan string, 10)
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
		OnPromptComplete: func(reason string, _ error) { completed <- reason },
	}})
	defer host.Stop()
	_, cancel := context.WithCancel(context.Background())
	attempt, ok := host.beginPrompt(cancel, func(reason string, _ error) { observed <- reason })
	if !ok {
		t.Fatal("prompt was not accepted")
	}

	reasons := []string{"end_turn", "cancelled", checkpointPreemptedStopReason, fatalErrorStopReason, "process_exit"}
	var wg sync.WaitGroup
	for _, reason := range reasons {
		wg.Add(1)
		go func(reason string) {
			defer wg.Done()
			attempt.complete(host, reason, errors.New(reason))
		}(reason)
	}
	wg.Wait()

	select {
	case <-completed:
	case <-time.After(time.Second):
		t.Fatal("completion callback did not run")
	}
	select {
	case second := <-completed:
		t.Fatalf("second completion callback: %q", second)
	case <-time.After(30 * time.Millisecond):
	}
	select {
	case <-observed:
	case <-time.After(time.Second):
		t.Fatal("terminal observer did not run")
	}
	select {
	case second := <-observed:
		t.Fatalf("second terminal observer: %q", second)
	case <-time.After(30 * time.Millisecond):
	}
}

func TestPromptTimeoutConvergesToErrorAndSingleFatalCallback(t *testing.T) {
	completed := make(chan string, 2)
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
		OnPromptComplete: func(reason string, _ error) { completed <- reason },
	}})
	defer host.Stop()
	_, cancel := context.WithCancel(context.Background())
	attempt, ok := host.beginPrompt(cancel, nil)
	if !ok {
		t.Fatal("prompt was not accepted")
	}
	host.setStatus(HostPrompting, "")
	host.triggerPromptForceStopIfStuck(attempt.id, "hard deadline")
	host.triggerPromptForceStopIfStuck(attempt.id, "late process exit")
	if host.Status() != HostError {
		t.Fatalf("status = %s, want error", host.Status())
	}
	select {
	case got := <-completed:
		if got != fatalErrorStopReason {
			t.Fatalf("stop reason = %q, want %q", got, fatalErrorStopReason)
		}
	case <-time.After(time.Second):
		t.Fatal("fatal callback did not run")
	}
	select {
	case got := <-completed:
		t.Fatalf("duplicate terminal callback: %q", got)
	case <-time.After(30 * time.Millisecond):
	}
}

func TestCheckpointRolloverGracefulAndForcedStrictResume(t *testing.T) {
	for _, tc := range []struct {
		name     string
		graceful bool
		forced   bool
	}{
		{name: "graceful", graceful: true, forced: false},
		{name: "forced", graceful: false, forced: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			host := newRecoveryTestHost(t, time.Second)
			defer host.Stop()
			t.Setenv("HOME", t.TempDir())
			t.Setenv("CODEX_HOME", "")
			host.config.ContainerResolver = func() (string, error) { return "", nil }
			var starts atomic.Int32
			host.config.StartProcess = countingSpawn(t, &starts)
			completed := make(chan string, 2)
			host.config.OnPromptComplete = func(reason string, _ error) { completed <- reason }

			oldProc, reader, writer := newFakeAgentProcess(time.Now().Add(-10*time.Second), true)
			methods := serveCheckpointACP(t, reader, writer)
			conn := acpsdk.NewClientSideConnection(&sessionHostClient{host: host}, oldProc.Stdin(), oldProc.Stdout())
			_, cancel := context.WithCancel(context.Background())
			attempt, ok := host.beginPrompt(cancel, nil)
			if !ok {
				t.Fatal("prompt was not accepted")
			}
			if tc.graceful {
				close(attempt.rpcDone)
			}
			host.mu.Lock()
			host.process = oldProc
			host.acpConn = conn
			host.setStatusLocked(HostPrompting)
			host.agentType = "openai-codex"
			host.setSessionIDLocked("acp-session-1")
			host.agentSupportsLoadSession = true
			host.mu.Unlock()
			go host.monitorProcessExit(context.Background(), oldProc, "openai-codex", &agentCredential{credentialKind: "api-key"}, nil)

			grace := 50 * time.Millisecond
			if tc.forced {
				grace = time.Millisecond
			}
			ctx, deadlineCancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer deadlineCancel()
			result, err := host.CheckpointRollover(ctx, grace)
			if err != nil {
				t.Fatalf("CheckpointRollover: %v (%+v)", err, result)
			}
			if result.State != "completed" || result.Forced != tc.forced || result.ACPSessionID != "acp-session-1" {
				t.Fatalf("result = %+v", result)
			}
			if starts.Load() != 1 {
				t.Fatalf("restart count = %d, want 1", starts.Load())
			}
			seen := map[string]bool{}
			for len(methods) > 0 {
				seen[<-methods] = true
			}
			if !seen[acpsdk.AgentMethodSessionCancel] || !seen[acpsdk.AgentMethodSessionClose] {
				t.Fatalf("checkpoint ACP methods = %#v, want cancel and close", seen)
			}
			select {
			case reason := <-completed:
				if reason != checkpointPreemptedStopReason {
					t.Fatalf("completion reason = %q", reason)
				}
			case <-time.After(time.Second):
				t.Fatal("checkpoint completion callback missing")
			}
		})
	}
}

func TestCheckpointRolloverStrictResumeFailureIsExplicit(t *testing.T) {
	host := newRecoveryTestHost(t, time.Second)
	defer host.Stop()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", "")
	host.config.ContainerResolver = func() (string, error) { return "", nil }
	var starts atomic.Int32
	host.config.StartProcess = func(*agentStartup) (agentProcess, error) {
		starts.Add(1)
		return nil, errors.New("spawn failed")
	}
	completed := make(chan string, 2)
	host.config.OnPromptComplete = func(reason string, _ error) { completed <- reason }
	oldProc, reader, writer := newFakeAgentProcess(time.Now().Add(-10*time.Second), true)
	serveCheckpointACP(t, reader, writer)
	conn := acpsdk.NewClientSideConnection(&sessionHostClient{host: host}, oldProc.Stdin(), oldProc.Stdout())
	_, cancel := context.WithCancel(context.Background())
	attempt, _ := host.beginPrompt(cancel, nil)
	close(attempt.rpcDone)
	host.mu.Lock()
	host.process, host.acpConn, host.status = oldProc, conn, HostPrompting
	host.agentType, host.sessionID, host.agentSupportsLoadSession = "openai-codex", "same-session", true
	host.mu.Unlock()
	go host.monitorProcessExit(context.Background(), oldProc, "openai-codex", &agentCredential{credentialKind: "api-key"}, nil)

	ctx, deadlineCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer deadlineCancel()
	result, err := host.CheckpointRollover(ctx, 20*time.Millisecond)
	if err == nil || result.State != "failed" || result.ErrorCode != "strict_resume_failed" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if host.Status() != HostError {
		t.Fatalf("status = %s, want error", host.Status())
	}
	time.Sleep(1200 * time.Millisecond)
	if starts.Load() != 1 {
		t.Fatalf("strict resume starts = %d, want exactly one and no fresh fallback", starts.Load())
	}
	assertSingleCheckpointTerminal(t, completed)
	assertNoReadyStatus(t, host)
}

func TestCheckpointTerminalOwnershipSuppressesDelayedProcessExitRestart(t *testing.T) {
	for _, tc := range []struct {
		name      string
		deadline  time.Duration
		grace     time.Duration
		closeRPC  bool
		errorCode string
	}{
		{name: "operation deadline", deadline: 40 * time.Millisecond, grace: time.Millisecond, closeRPC: true, errorCode: "rollover_deadline_exceeded"},
		{name: "caller cancellation", deadline: 40 * time.Millisecond, grace: time.Second, closeRPC: false, errorCode: "rollover_cancelled"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			host := newRecoveryTestHost(t, time.Second)
			defer host.Stop()
			t.Setenv("HOME", t.TempDir())
			t.Setenv("CODEX_HOME", "")
			host.config.ContainerResolver = func() (string, error) { return "", nil }
			var starts atomic.Int32
			host.config.StartProcess = countingSpawn(t, &starts)
			completed := make(chan string, 2)
			host.config.OnPromptComplete = func(reason string, _ error) { completed <- reason }

			oldProc, reader, writer := newFakeAgentProcess(time.Now().Add(-10*time.Second), false)
			serveCheckpointACP(t, reader, writer)
			conn := acpsdk.NewClientSideConnection(&sessionHostClient{host: host}, oldProc.Stdin(), oldProc.Stdout())
			_, cancelPrompt := context.WithCancel(context.Background())
			attempt, ok := host.beginPrompt(cancelPrompt, nil)
			if !ok {
				t.Fatal("prompt was not accepted")
			}
			if tc.closeRPC {
				close(attempt.rpcDone)
			}
			host.mu.Lock()
			host.process, host.acpConn, host.status = oldProc, conn, HostPrompting
			host.agentType, host.sessionID, host.agentSupportsLoadSession = "openai-codex", "same-session", true
			host.mu.Unlock()
			go host.monitorProcessExit(context.Background(), oldProc, "openai-codex", &agentCredential{credentialKind: "api-key"}, nil)

			ctx, cancel := context.WithTimeout(context.Background(), tc.deadline)
			defer cancel()
			result, err := host.CheckpointRollover(ctx, tc.grace)
			if err == nil || result.State != "failed" || result.ErrorCode != tc.errorCode {
				t.Fatalf("result=%+v err=%v", result, err)
			}

			// Release process.Wait only after terminal ownership is durable. The
			// delayed exit monitor must observe suppression rather than taking its
			// generic one-second restart path.
			close(oldProc.waitCh)
			time.Sleep(1300 * time.Millisecond)
			if starts.Load() != 0 {
				t.Fatalf("process starts after terminal = %d, want 0", starts.Load())
			}
			if host.Status() != HostError {
				t.Fatalf("status after delayed exit = %s, want error", host.Status())
			}
			assertSingleCheckpointTerminal(t, completed)
			assertNoReadyStatus(t, host)
			host.mu.RLock()
			rollover, process := host.checkpointRollover, host.process
			host.mu.RUnlock()
			if rollover != nil || process != nil {
				t.Fatalf("terminal episode did not converge: rollover=%v process=%v", rollover != nil, process != nil)
			}
		})
	}
}

func assertSingleCheckpointTerminal(t *testing.T, completed <-chan string) {
	t.Helper()
	select {
	case reason := <-completed:
		if reason != fatalErrorStopReason {
			t.Fatalf("completion reason = %q, want %q", reason, fatalErrorStopReason)
		}
	case <-time.After(time.Second):
		t.Fatal("checkpoint terminal completion callback missing")
	}
	select {
	case reason := <-completed:
		t.Fatalf("duplicate checkpoint terminal completion: %q", reason)
	case <-time.After(80 * time.Millisecond):
	}
}

func assertNoReadyStatus(t *testing.T, host *SessionHost) {
	t.Helper()
	host.bufMu.RLock()
	messages := append([]BufferedMessage(nil), host.messageBuf...)
	host.bufMu.RUnlock()
	for _, message := range messages {
		var status AgentStatusMessage
		if err := json.Unmarshal(message.Data, &status); err == nil && status.Type == MsgAgentStatus && status.Status == StatusReady {
			t.Fatalf("late Ready observed after terminal checkpoint ownership: %s", message.Data)
		}
	}
}

func TestCheckpointRolloverIsSupersededByNaturalCompletionOrUserCancel(t *testing.T) {
	for _, tc := range []struct {
		name       string
		stopReason string
		cancelled  bool
	}{
		{name: "natural completion", stopReason: "end_turn"},
		{name: "user cancellation", stopReason: "cancelled", cancelled: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			host := newRecoveryTestHost(t, time.Second)
			defer host.Stop()
			oldProc, reader, writer := newFakeAgentProcess(time.Now().Add(-10*time.Second), true)
			methods := serveCheckpointACP(t, reader, writer)
			conn := acpsdk.NewClientSideConnection(&sessionHostClient{host: host}, oldProc.Stdin(), oldProc.Stdout())
			_, cancel := context.WithCancel(context.Background())
			attempt, _ := host.beginPrompt(cancel, nil)
			host.mu.Lock()
			host.process, host.acpConn, host.status = oldProc, conn, HostPrompting
			host.agentType, host.sessionID, host.agentSupportsLoadSession = "openai-codex", "same-session", true
			host.mu.Unlock()

			go func() {
				for method := range methods {
					if method != acpsdk.AgentMethodSessionCancel {
						continue
					}
					if tc.cancelled {
						host.promptCancelMu.Lock()
						host.promptCancelRequested = true
						host.promptCancelMu.Unlock()
					}
					attempt.completeWith(host, tc.stopReason, nil, host.markPromptDone)
					// Real AcceptedPrompt.Run closes rpcDone as it returns. Keeping
					// both channels ready proves checkpoint prioritizes the prompt's
					// terminal owner instead of randomly selecting strict restart.
					close(attempt.rpcDone)
					return
				}
			}()

			ctx, deadlineCancel := context.WithTimeout(context.Background(), time.Second)
			defer deadlineCancel()
			result, err := host.CheckpointRollover(ctx, 100*time.Millisecond)
			if err != nil || result.State != "superseded" {
				t.Fatalf("result=%+v err=%v", result, err)
			}
			if oldProc.stopCount.Load() != 0 {
				t.Fatalf("superseded rollover stopped process %d times", oldProc.stopCount.Load())
			}
		})
	}
}

func TestCheckpointTerminalClaimPreventsRestartWhenCompletionWinsBeforeStop(t *testing.T) {
	host := newRecoveryTestHost(t, time.Second)
	defer host.Stop()
	oldProc, reader, writer := newFakeAgentProcess(time.Now().Add(-10*time.Second), true)
	serveCheckpointACP(t, reader, writer)
	conn := acpsdk.NewClientSideConnection(&sessionHostClient{host: host}, oldProc.Stdin(), oldProc.Stdout())
	_, cancel := context.WithCancel(context.Background())
	attempt, _ := host.beginPrompt(cancel, nil)
	close(attempt.rpcDone)
	host.config.BeforeCheckpointProcessStop = func() {
		attempt.completeWith(host, "end_turn", nil, host.markPromptDone)
	}
	host.mu.Lock()
	host.process, host.acpConn, host.status = oldProc, conn, HostPrompting
	host.agentType, host.sessionID, host.agentSupportsLoadSession = "openai-codex", "same-session", true
	host.mu.Unlock()

	ctx, deadlineCancel := context.WithTimeout(context.Background(), time.Second)
	defer deadlineCancel()
	result, err := host.CheckpointRollover(ctx, 100*time.Millisecond)
	if err != nil || result.State != "superseded" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if oldProc.stopCount.Load() != 0 {
		t.Fatalf("superseded rollover stopped process %d times", oldProc.stopCount.Load())
	}
}
